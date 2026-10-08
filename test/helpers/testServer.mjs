import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server.js");

export const mockUser = (shortId, overrides = {}) => ({
  id: `usr_${shortId}`,
  shortId,
  displayName: `${shortId[0].toUpperCase()}${shortId.slice(1)} Tester`,
  email: `${shortId}.tester@example.com`,
  password: "Strong#1234",
  status: "approved",
  role: "user",
  ...overrides
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Spawns server.js from a temp cwd so no developer .env leaks into the test.
export function spawnServer(env, { cwd } = {}) {
  const output = [];
  const child = spawn(process.execPath, [serverPath], {
    cwd: cwd || os.tmpdir(),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, MB_GENAI_API_KEY: "test-key", MB_GENAI_API_VERSION: "2024-10-21", MB_GENAI_ENDPOINT: "https://example.invalid", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output, exited };
}

export async function startTestServer({ users = [], env = {}, prepare, separateAuthStorage = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "btv-auth-test-"));
  const root = path.join(dir, "storage");
  const authRoot = separateAuthStorage ? path.join(dir, "private-auth") : root;
  const authDir = path.join(authRoot, "auth");
  const usersFile = path.join(authDir, "users.json");
  await mkdir(root, { recursive: true });
  await mkdir(authDir, { recursive: true });
  const now = new Date().toISOString();
  const persistedUsers = await Promise.all(users.map(async (user) => ({
    id: user.id || `usr_${user.shortId}`,
    shortId: String(user.shortId || "").toLowerCase(),
    displayName: user.displayName || user.shortId,
    email: String(user.email || "").toLowerCase(),
    passwordHash: await bcrypt.hash(String(user.password || "Strong#1234"), 4),
    status: user.status || "approved",
    role: user.role || "user",
    failedLoginAttempts: 0,
    lockedUntil: 0,
    createdAt: now,
    updatedAt: now,
    approvedAt: now,
    approvedBy: "test",
    rejectedAt: "",
    rejectedBy: "",
    disabledAt: "",
    disabledBy: "",
    lastLoginAt: "",
    passwordUpdatedAt: now
  })));
  await writeFile(usersFile, JSON.stringify({ version: 1, users: persistedUsers }, null, 2), "utf8");
  if (prepare) await prepare(root);
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const { child, output, exited } = spawnServer({
    PORT: String(port),
    BTV_STORAGE_ROOT: root,
    BTV_AUTH_STORAGE_ROOT: authRoot,
    SESSION_SECRET: "this_is_a_test_session_secret_that_is_long_enough_123",
    ...env
  }, { cwd: dir });

  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${api}/health`)).ok) break;
    } catch {}
    if (attempt > 150) throw new Error(`Backend did not start:\n${output.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const responses = [];
  async function call(pathname, { method = "GET", body, cookie, headers = {} } = {}) {
    const response = await fetch(`${api}${pathname}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    responses.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text, headers: response.headers, setCookie: response.headers.getSetCookie() };
  }

  async function readMails() { return []; }
  async function waitForMail() { return null; }
  const codeFrom = () => "";

  async function login(shortId) {
    const user = users.find((candidate) => String(candidate.shortId).toLowerCase() === String(shortId).toLowerCase());
    const response = await call("/api/auth/login", { method: "POST", body: { identifier: shortId, password: String(user?.password || "Strong#1234") } });
    if (response.status !== 200) throw new Error(`login failed: ${response.text}`);
    return response.setCookie.map((value) => value.split(";")[0]).join("; ");
  }

  async function readAudit() {
    return [];
  }

  async function stop() {
    child.kill();
    await exited;
    await rm(dir, { recursive: true, force: true });
  }

  return { api, root, authRoot, dir, output, responses, call, readMails, waitForMail, codeFrom, login, readAudit, stop };
}
