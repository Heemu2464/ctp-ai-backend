import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUserRepository, normalizeEmail, normalizeShortId, validateRegistrationPayload, toPublicUser } from "../auth/localAuth.js";
import { hashPassword, verifyPassword, isStrongPassword, passwordCost } from "../auth/passwordService.js";
import { runAdminCommand } from "../scripts/create-admin.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequireAuth } from "../auth/localMiddleware.js";
import { createLocalAuthRouter } from "../auth/localRoutes.js";

test("password policy rejects weak, missing, non-string and oversized values without coercion", async () => {
  for (const password of [undefined, null, {}, 1234567890, "weak", "onlylowercase123!", "ALLUPPERCASE123!", "NoNumbersHere!", "NoSymbolsHere123", `Aa1!${"x".repeat(69)}`]) {
    assert.equal(isStrongPassword(password), false);
    await assert.rejects(hashPassword(password));
  }
  assert.equal(await verifyPassword("ValidTest#1287", "malformed"), false);
});

test("bcrypt cost configuration rejects unsafe work factors", () => {
  const previous = process.env.BCRYPT_COST;
  try {
    for (const cost of ["4", "11", "16", "NaN", "12.5"]) {
      process.env.BCRYPT_COST = cost;
      assert.throws(passwordCost);
    }
    process.env.BCRYPT_COST = "13";
    assert.equal(passwordCost(), 13);
  } finally {
    if (previous === undefined) delete process.env.BCRYPT_COST;
    else process.env.BCRYPT_COST = previous;
  }
});

test("public serializer ignores all credential fields including unexpected legacy values", () => {
  const user = toPublicUser({ id: "usr_test", shortId: "pilotaa", password: "Private#1297", passwordHash: "not-for-client", confirmPassword: "Private#1297", encryptedPassword: "cipher", unexpectedSecret: "private" });
  const serialized = JSON.stringify(user);
  for (const value of ["Private#1297", "not-for-client", "cipher", "private"]) assert.ok(!serialized.includes(value));
});

test("both Git roots ignore user stores and their temporary files", () => {
  const backend = fileURLToPath(new URL("../", import.meta.url));
  const frontend = path.resolve(backend, "../../timing-planner");
  for (const cwd of [backend, frontend]) {
    for (const file of ["auth/users.json", "auth/users.json.123.tmp", "dev/captured-mail.jsonl", ".env"]) {
      assert.ok(execFileSync("git", ["check-ignore", file], { cwd, encoding: "utf8" }).trim());
    }
  }
});

test("persisted credentials are salted hashes, admin CLI refuses duplicate replacement and argv passwords", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "btv-admin-security-"));
  try {
    const users = createUserRepository({ storageRoot: dir });
    const password = "Private-Admin-Test#9271";
    const values = { shortId: "adminbb", displayName: "Admin Test", email: "adminbb@example.invalid" };
    const result = await runAdminCommand({ users, values, readPassword: async () => password });
    assert.deepEqual(result, { ok: true, created: true });
    const first = await readFile(users.usersFile, "utf8");
    assert.ok(!first.includes(password));
    const user = JSON.parse(first).users[0];
    assert.match(user.passwordHash, /^\$2[aby]\$12\$/);
    assert.equal(await verifyPassword(password, user.passwordHash), true);
    assert.equal(Object.hasOwn(user, "password"), false);
    await assert.rejects(runAdminCommand({ users, values, readPassword: async () => "NewPrivate#9182" }));
    assert.equal(await readFile(users.usersFile, "utf8"), first);
    await assert.rejects(runAdminCommand({ users, values: { ...values, password }, readPassword: async () => { throw new Error("Must not prompt"); } }), /command-line/);
    assert.deepEqual(await readdir(path.dirname(users.usersFile)), ["users.json"]);
    if (process.platform !== "win32") assert.equal((await stat(users.usersFile)).mode & 0o777, 0o600);
    else {
      const script = "$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($owner,'S-1-5-18','S-1-5-32-544'); foreach($item in @($env:ACL_AUTH_DIR,$env:ACL_AUTH_FILE)) { $acl=Get-Acl -LiteralPath $item; if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner) {exit 2}; foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {if($rule.IdentityReference.Value -notin $allowed) {exit 3}} }; Write-Output 'restricted'";
      assert.equal(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, ACL_AUTH_DIR: path.dirname(users.usersFile), ACL_AUTH_FILE: users.usersFile } }).trim(), "restricted");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy plaintext migration is idempotent, removes secret fields and requires reset for unknown hashes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "btv-migration-security-"));
  try {
    const users = createUserRepository({ storageRoot: dir });
    await users.listPublicUsers();
    const password = "Legacy-Isolated#1829";
    await writeFile(users.usersFile, JSON.stringify({ users: [{ id: "legacy", shortId: "legacya", password, confirmPassword: password, role: "user", status: "approved" }, { id: "unknown", shortId: "unknown", passwordHash: "unsupported-digest", encryptedPassword: "fake-ciphertext" }] }));
    assert.equal((await users.migrateLegacyCredentials()).affected, 2);
    const first = await readFile(users.usersFile, "utf8");
    assert.ok(!first.includes(password));
    assert.ok(!first.includes("fake-ciphertext"));
    assert.ok(!first.includes("unsupported-digest"));
    assert.equal(await verifyPassword(password, JSON.parse(first).users[0].passwordHash), true);
    assert.equal(JSON.parse(first).users[1].passwordResetRequired, true);
    assert.equal((await users.migrateLegacyCredentials()).affected, 0);
    assert.equal(await readFile(users.usersFile, "utf8"), first);
    assert.deepEqual(await readdir(path.dirname(users.usersFile)), ["users.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session payload uses identity only and revoked credential versions cannot authorize", async () => {
  const user = { id: "usr_session", shortId: "session", displayName: "Session", email: "session@example.invalid", role: "user", status: "approved", credentialVersion: 0 };
  const repository = { authenticate: async () => ({ ok: true, user }), findById: async () => user };
  const dir = await mkdtemp(path.join(os.tmpdir(), "btv-session-security-"));
  try {
    const router = createLocalAuthRouter({ users: repository, storageRoot: dir });
    const route = router.stack.find((layer) => layer.route?.path === "/login");
    const session = { regenerate: (callback) => callback(), save: (callback) => callback() };
    const req = { body: { identifier: "session", password: "PrivateSession#1829" }, session };
    const res = { json: () => {}, status: () => res };
    await route.route.stack[0].handle(req, res, (error) => { if (error) throw error; });
    const serialized = JSON.stringify(session);
    assert.ok(!serialized.includes("PrivateSession#1829"));
    assert.ok(!serialized.includes("passwordHash"));
    assert.equal(session.auth.credentialVersion, 0);
    user.credentialVersion = 1;
    let status;
    await createRequireAuth(repository)(req, { status: (value) => { status = value; return res; } }, () => assert.fail("Revoked session authorized"));
    assert.equal(status, 401);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bcrypt generates unique salts, rejects hash replay and prevents UTF-8 truncation", async () => {
  const password = "Isolated-Security-Test#9471";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, password);
  assert.notEqual(first, second);
  assert.match(first, /^\$2[aby]\$12\$/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("Wrong-Isolated#9471", first), false);
  assert.equal(await verifyPassword(first, first), false);
  assert.equal(isStrongPassword(`Aa1!${"x".repeat(69)}`), false);
  assert.equal(isStrongPassword(`Aa1!${"\u00e9".repeat(35)}`), false);
  assert.equal(await verifyPassword(`Aa1!${"x".repeat(100)}`, first), false);
});

test("normalizers enforce shortId and email shape", () => {
  assert.equal(normalizeShortId(" Abc-DEfg9 "), "abcdefg");
  assert.equal(normalizeShortId("abc"), "");
  assert.equal(normalizeEmail(" USER@EXAMPLE.COM "), "user@example.com");
  assert.equal(normalizeEmail("bad"), "");
});

test("registration payload validation requires strong password", () => {
  const weak = validateRegistrationPayload({ shortId: "abcdefg", displayName: "A", email: "a@b.com", password: "weak" });
  assert.ok(weak.error);
  const strong = validateRegistrationPayload({ shortId: "abcdefg", displayName: "A", email: "a@b.com", password: "Strong#1234" });
  assert.ok(strong.value);
});

test("user repository register/authenticate/status flow", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "btv-local-auth-"));
  try {
    const users = createUserRepository({ storageRoot: dir });

    const created = await users.register({ shortId: "pilotaa", displayName: "Pilot", email: "pilot@example.com", password: "Strong#1234" });
    assert.equal(created.ok, true);
    assert.equal(created.user.status, "pending");
    const persisted = JSON.parse(await readFile(users.usersFile, "utf8")).users[0];
    assert.match(persisted.passwordHash, /^\$2[aby]\$12\$/);
    assert.equal(Object.hasOwn(persisted, "password"), false);
    assert.equal(Object.hasOwn(persisted, "confirmPassword"), false);
    assert.ok(!JSON.stringify(created).includes(persisted.passwordHash));

    const pendingLogin = await users.authenticate({ identifier: "pilotaa", password: "Strong#1234" });
    assert.equal(pendingLogin.ok, false);
    assert.equal(pendingLogin.code, "NOT_APPROVED");

    const admin = await users.bootstrapAdmin({ shortId: "adminaa", displayName: "Admin", email: "admin@example.com", password: "Strong#1234" });
    assert.equal(admin.ok, true);

    const approved = await users.setStatus({ userId: created.user.id, status: "approved", actorUserId: admin.user.id });
    assert.equal(approved.ok, true);
    assert.equal(approved.user.status, "approved");

    const login = await users.authenticate({ identifier: "pilot@example.com", password: "Strong#1234" });
    assert.equal(login.ok, true);
    assert.equal(login.user.shortId, "pilotaa");
    for (const status of ["rejected", "disabled", "pending"]) {
      await users.setStatus({ userId: created.user.id, status, actorUserId: admin.user.id });
      assert.equal((await users.authenticate({ identifier: "pilotaa", password: "Strong#1234" })).code, "NOT_APPROVED");
    }
    await users.setStatus({ userId: created.user.id, status: "approved", actorUserId: admin.user.id });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await users.authenticate({ identifier: "pilotaa", password: "Wrong#9827" });
      assert.equal(failure.code, attempt === 4 ? "LOCKED" : "INVALID_CREDENTIALS");
    }
    assert.equal((await users.authenticate({ identifier: "pilotaa", password: "Strong#1234" })).code, "LOCKED");
    await users.unlock({ userId: created.user.id });
    assert.equal((await users.authenticate({ identifier: "pilotaa", password: "Strong#1234" })).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
