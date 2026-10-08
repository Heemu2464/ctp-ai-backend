import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mockUser, startTestServer } from "./helpers/testServer.mjs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUserRepository } from "../auth/localAuth.js";

function assertNoCredentials(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /"(?:passwordHash|password|confirmPassword|plainPassword|temporaryPassword|encryptedPassword)"\s*:/);
  assert.doesNotMatch(text, /\$2[aby]\$\d{2}\$/);
  assert.ok(!text.includes("Strong#1234"));
}

let server;
let adminCookie = "";

before(async () => {
  server = await startTestServer({
    users: [
      mockUser("adminaa", { role: "admin", email: "admin@example.com" }),
      mockUser("owneraa", { email: "owner@example.com" }),
      mockUser("otheraa", { email: "other@example.com" })
    ]
  });
  adminCookie = await server.login("adminaa");
});

after(async () => {
  await server?.stop();
});

test("register creates pending user and blocks login before approval", async () => {
  const register = await server.call("/api/auth/register", {
    method: "POST",
    body: {
      shortId: "pilotaa",
      displayName: "Pilot User",
      email: "pilot@example.com",
      password: "Strong#1234"
    }
  });
  assert.equal(register.status, 201);
  assert.equal(register.json.ok, true);

  const login = await server.call("/api/auth/login", {
    method: "POST",
    body: { identifier: "pilotaa", password: "Strong#1234" }
  });
  assert.equal(login.status, 403);
  assert.equal(login.json.code, "NOT_APPROVED");
});

test("admin approves user and user can login/get session", async () => {
  const users = await server.call("/api/admin/users", { cookie: adminCookie });
  const pending = users.json.users.find((entry) => entry.shortId === "pilotaa");
  assert.ok(pending);

  const approve = await server.call(`/api/admin/users/${encodeURIComponent(pending.id)}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { status: "approved" }
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.json.user.status, "approved");

  const login = await server.call("/api/auth/login", {
    method: "POST",
    body: { identifier: "pilotaa", password: "Strong#1234" }
  });
  assert.equal(login.status, 200);
  const cookie = login.setCookie.map((value) => value.split(";")[0]).join("; ");

  const me = await server.call("/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user, "pilotaa");
  assert.equal(me.json.identitySource, "local-pilot-auth");
});

test("plan ownership is enforced by internal userId", async () => {
  const ownerCookie = await server.login("owneraa");
  const otherCookie = await server.login("otheraa");

  const planPayload = {
    planId: "secure-plan",
    id: "secure-plan",
    owner: "owneraa",
    carline: "X100",
    commodity: "Brake Hose",
    builds: [],
    milestones: {},
    subActivities: [],
    customPlan: { active: false },
    customPlan2: { active: false },
    aiPlan: { active: false }
  };

  const save = await server.call("/api/plans/save", { method: "POST", cookie: ownerCookie, body: planPayload });
  assert.equal(save.status, 200);
  assert.ok(String(save.json.plan.ownerUserId || "").startsWith("usr_"));

  const ownRead = await server.call("/api/plans/secure-plan", { cookie: ownerCookie });
  assert.equal(ownRead.status, 200);

  const forbiddenRead = await server.call("/api/plans/secure-plan", { cookie: otherCookie });
  assert.equal(forbiddenRead.status, 403);

  const forbiddenDelete = await server.call("/api/plans/secure-plan", { method: "DELETE", cookie: otherCookie });
  assert.equal(forbiddenDelete.status, 403);
});

test("auth, session, debug and admin responses never expose credential material", async () => {
  const cookie = await server.login("owneraa");
  for (const endpoint of ["/api/auth/me", "/api/session", "/api/debug/whoami"]) {
    const response = await server.call(endpoint, { cookie });
    assert.equal(response.status, 200);
    assertNoCredentials(response.json);
  }
  const users = await server.call("/api/admin/users", { cookie: adminCookie });
  assertNoCredentials(users.json);
  const login = await server.call("/api/auth/login", { method: "POST", body: { identifier: "owneraa", password: "Strong#1234" } });
  assertNoCredentials(login.json);
  assertNoCredentials(login.setCookie);
  assert.match(login.setCookie.join(";"), /HttpOnly/i);
  const denied = await server.call("/api/admin/users", { cookie });
  assert.equal(denied.status, 403);
  assertNoCredentials(denied.json);
});

test("static and traversal requests cannot fetch the user store", async () => {
  const cookie = await server.login("owneraa");
  for (const endpoint of ["/auth/users.json", "/users.json", "/api/auth/users.json", "/public/auth/users.json", "/%2e%2e/auth/users.json"]) {
    const response = await server.call(endpoint, { cookie });
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(response.text, /passwordHash|\$2[aby]\$/);
  }
});

test("hash replay is rejected, invalid credentials stay generic, pending status cannot bypass approval", async () => {
  const store = JSON.parse(await readFile(path.join(server.root, "auth", "users.json"), "utf8"));
  const owner = store.users.find((entry) => entry.shortId === "owneraa");
  for (const password of ["Wrong#1234", owner.passwordHash]) {
    const response = await server.call("/api/auth/login", { method: "POST", body: { identifier: "owneraa", password } });
    assert.equal(response.status, 401);
    assert.equal(response.json.error, "Invalid credentials.");
    assertNoCredentials(response.json);
  }
  const absent = await server.call("/api/auth/login", { method: "POST", body: { identifier: "missing", password: "Wrong#1234" } });
  assert.equal(absent.json.error, "Invalid credentials.");
});

test("admin mutations are allowlisted and password reset invalidates old sessions", async () => {
  const cookie = await server.login("otheraa");
  const userId = "usr_otheraa";
  for (const [action, method, body] of [["status", "PATCH", { status: "approved" }], ["role", "PATCH", { role: "user" }], ["unlock", "POST", {}]]) {
    const response = await server.call(`/api/admin/users/${userId}/${action}`, { method, body, cookie: adminCookie });
    assert.equal(response.status, 200);
    assertNoCredentials(response.json);
  }
  const assign = await server.call(`/api/admin/users/${userId}/reset-password`, { method: "POST", cookie: adminCookie, body: { password: "AdminChosen#9812" } });
  assert.equal(assign.status, 400);
  assertNoCredentials(assign.json);
  const requireReset = await server.call(`/api/admin/users/${userId}/reset-password`, { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(requireReset.status, 200);
  assertNoCredentials(requireReset.json);
  assert.equal((await server.call("/api/plans", { cookie })).status, 401);
  const repository = createUserRepository({ storageRoot: server.root });
  const freshPassword = "UserPrivateReset#9287";
  const result = await repository.resetPassword({ userId, password: freshPassword });
  assertNoCredentials(result);
  assert.equal((await server.call("/api/auth/me", { cookie })).status, 401);
  const oldLogin = await server.call("/api/auth/login", { method: "POST", body: { identifier: "otheraa", password: "Strong#1234" } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await server.call("/api/auth/login", { method: "POST", body: { identifier: "otheraa", password: freshPassword } });
  assert.equal(newLogin.status, 200);
  const persisted = await readFile(repository.usersFile, "utf8");
  assert.ok(!persisted.includes(freshPassword));
  assert.ok(!server.output.join("").includes(freshPassword));
  assert.ok(!server.output.join("").includes("Strong#1234"));
});

test("plans marked UNASSIGNED before registration are reclaimed by the matching owner only", async () => {
  const plan = { planId: "early-plan", id: "early-plan", owner: "lateaaa", ownerUserId: "UNASSIGNED", carline: "X1", commodity: "Hose", builds: [], milestones: {}, subActivities: [] };
  const isolated = await startTestServer({
    users: [mockUser("lateaaa"), mockUser("strange")],
    prepare: async (root) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "users", "lateaaa"), { recursive: true });
      await writeFile(path.join(root, "users", "lateaaa", "early-plan.json"), JSON.stringify(plan));
    }
  });
  try {
    const ownerCookie = await isolated.login("lateaaa");
    const mine = await isolated.call("/api/plans/my", { cookie: ownerCookie });
    assert.ok(mine.json.plans.some((entry) => entry.planId === "early-plan"));
    const stored = JSON.parse(await readFile(path.join(isolated.root, "users", "lateaaa", "early-plan.json"), "utf8"));
    assert.equal(stored.ownerUserId, "usr_lateaaa");
    const otherCookie = await isolated.login("strange");
    assert.equal((await isolated.call("/api/plans/early-plan", { cookie: otherCookie })).status, 403);
  } finally {
    await isolated.stop();
  }
});

test("separate auth storage keeps registration credentials out of plan storage", async () => {
  const isolated = await startTestServer({ separateAuthStorage: true, users: [mockUser("splitaa")] });
  try {
    assert.equal((await isolated.call("/health")).status, 200);
    const registration = await isolated.call("/api/auth/register", { method: "POST", body: { shortId: "splitbb", displayName: "Split Test", email: "splitbb@example.invalid", password: "IsolatedStore#9481" } });
    assert.equal(registration.status, 201);
    const persisted = JSON.parse(await readFile(path.join(isolated.authRoot, "auth", "users.json"), "utf8"));
    assert.ok(persisted.users.find((entry) => entry.shortId === "splitbb"));
    assert.ok(!JSON.stringify(persisted).includes("IsolatedStore#9481"));
    await assert.rejects(access(path.join(isolated.root, "auth", "users.json")), { code: "ENOENT" });
    await isolated.login("splitaa");
    await access(path.join(isolated.root, "users", "splitaa"));
  } finally {
    await isolated.stop();
  }
});

test("corrupt storage fails closed without overwriting data or exposing error details", async () => {
  const usersFile = path.join(server.root, "auth", "users.json");
  const original = await readFile(usersFile, "utf8");
  const malformed = '{"users": ["DO-NOT-ECHO-CREDENTIAL#9257"';
  try {
    await writeFile(usersFile, malformed);
    const response = await server.call("/api/auth/login", { method: "POST", body: { identifier: "owneraa", password: "Strong#1234" } });
    assert.equal(response.status, 500);
    assert.ok(!response.text.includes("DO-NOT-ECHO"));
    assert.ok(!server.output.join("").includes("DO-NOT-ECHO"));
    assert.equal(await readFile(usersFile, "utf8"), malformed);
  } finally {
    await writeFile(usersFile, original);
  }
});
