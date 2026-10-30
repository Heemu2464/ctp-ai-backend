import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { SMTPServer } from "smtp-server";
import { collectReminderEvents, createReminderRunner, createReminderStore, resolveReminderSender, validateReminderSettings } from "../reminderService.js";
import { mockUser, startTestServer } from "./helpers/testServer.mjs";

const user = { id: "alice-id", shortId: "alicexx", email: "alice@example.com", status: "approved" };
const plan = { id: "plan", ownerUserId: user.id, carline: "X192", commodity: "Hose", builds: [{ name: "E-Build", start: "2027-01-04" }], milestones: { rule: { name: "Rule event", plannedDate: "2027-01-03" } }, finalPlanSource: "myPlan3", customPlan3: { active: true, milestones: { gate: { name: "Final gate", plannedDate: "2027-01-02" } } }, subActivities: [{ id: "supplier", name: "Supplier", steps: [{ name: "Review", weekDate: "2027-01-01" }] }] };

test("sender defaults to an approved admin email, never a regular or disabled account", () => {
  const admin = { ...user, role: "admin", email: "admin@example.com" };
  assert.equal(resolveReminderSender([user, admin]), admin.email);
  assert.equal(resolveReminderSender([user, { ...admin, status: "disabled" }]), "");
  assert.equal(resolveReminderSender([{ ...admin, passwordResetRequired: true }]), "");
  assert.equal(resolveReminderSender([admin], "sender@example.com"), "sender@example.com");
});

test("reminders validate lead time and enabled state without accepting recipient overrides", () => {
  for (const daysBefore of [-1, 366, 1.5, "3", null]) assert.ok(validateReminderSettings({ enabled: true, daysBefore }).error);
  assert.ok(validateReminderSettings({ enabled: "true", daysBefore: 3 }).error);
  assert.deepEqual(validateReminderSettings({ enabled: true, daysBefore: 0, email: "other@example.com" }).value, { enabled: true, daysBefore: 0 });
});

test("events use owned finalized lanes, include day boundaries and exclude shared, demo, past and invalid events", () => {
  const events = collectReminderEvents([plan, { ...plan, ownerUserId: "bob-id" }, { ...plan, isWalkthroughDemo: true }], user, "2027-01-01", 3);
  assert.deepEqual(events.map((event) => event.name), ["Review", "Final gate", "E-Build"]);
  assert.deepEqual(collectReminderEvents([plan], user, "2027-01-01", 0).map((event) => event.name), ["Review"]);
  assert.deepEqual(collectReminderEvents([plan], user, "2027-01-05", 3), []);
  assert.deepEqual(collectReminderEvents([{ ...plan, builds: [{ name: "Invalid", start: "2027-02-30" }], milestones: {}, customPlan3: null, subActivities: [] }], user, "2027-03-01", 365), []);
});

test("preferences persist per account and runner emails the registered address once across restarts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "btv-reminders-"));
  try {
    const store = createReminderStore(root);
    assert.deepEqual((await store.read(user.id)).settings, { enabled: false, daysBefore: 3 });
    await store.saveSettings(user.id, { enabled: true, daysBefore: 3 });
    assert.equal((await store.read("bob-id")).settings.enabled, false);
    const messages = [];
    const options = { store, listUsers: async () => [user, { ...user, id: "bob-id" }, { ...user, id: "disabled-id", status: "disabled" }], getPlans: async () => [plan], sendMail: async (message) => messages.push(message), now: () => new Date("2027-01-01T12:00:00Z") };
    const run = createReminderRunner(options);
    await Promise.all([run(), run()]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, user.email);
    assert.match(messages[0].text, /Final gate/);
    await createReminderRunner({ ...options, store: createReminderStore(root) })();
    assert.equal(messages.length, 1);
    await store.saveSettings(user.id, { enabled: false, daysBefore: 3 });
    await run();
    assert.equal(messages.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed mail remains retryable and never marks events sent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "btv-reminders-"));
  try {
    const store = createReminderStore(root);
    await store.saveSettings(user.id, { enabled: true, daysBefore: 3 });
    let attempts = 0;
    const run = createReminderRunner({ store, listUsers: async () => [user], getPlans: async () => [plan], now: () => new Date("2027-01-01T12:00:00Z"), sendMail: async () => { attempts += 1; throw new Error("Mail unavailable"); } });
    await run();
    await run();
    assert.equal(attempts, 2);
    assert.deepEqual((await store.read(user.id)).sent, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("settings API requires login, persists preferences and uses only the signed-in account", async () => {
  const alice = mockUser("alicexx");
  const bob = mockUser("bobbyxx");
  const server = await startTestServer({ users: [alice, bob], env: { SMTP_HOST: "", MAIL_FROM: "" } });
  try {
    assert.equal((await server.call("/api/reminders/settings")).status, 401);
    assert.equal((await server.call("/api/reminders/settings", { method: "PUT", body: { enabled: true, daysBefore: 7 } })).status, 401);
    const cookie = await server.login(alice.shortId);
    const initial = await server.call("/api/reminders/settings", { cookie });
    assert.deepEqual(initial.json.settings, { enabled: false, daysBefore: 3 });
    assert.equal(initial.json.email, alice.email);
    assert.equal(initial.json.deliveryConfigured, false);
    const saved = await server.call("/api/reminders/settings", { method: "PUT", cookie, body: { enabled: true, daysBefore: 7, userId: bob.id, email: bob.email } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.email, alice.email);
    assert.equal((await server.call("/api/reminders/settings", { cookie: await server.login(bob.shortId) })).json.settings.enabled, false);
    assert.equal((await server.call("/api/reminders/settings", { method: "PUT", cookie, body: { enabled: true, daysBefore: 3.5 } })).status, 400);
    await server.restart();
    assert.deepEqual((await server.call("/api/reminders/settings", { cookie })).json.settings, { enabled: true, daysBefore: 7 });
  } finally { await server.stop(); }
});

test("opting out during a plan scan prevents the pending email", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "btv-reminders-"));
  try {
    const store = createReminderStore(root);
    await store.saveSettings(user.id, { enabled: true, daysBefore: 3 });
    let sent = false;
    const run = createReminderRunner({ store, listUsers: async () => [user], getPlans: async () => { await store.saveSettings(user.id, { enabled: false, daysBefore: 3 }); return [plan]; }, sendMail: async () => { sent = true; }, now: () => new Date("2027-01-01T12:00:00Z") });
    await run();
    assert.equal(sent, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured scheduler hands a reminder to SMTP for the registered address without a browser session", async () => {
  const alice = mockUser("alicexx");
  const admin = mockUser("adminxx", { role: "admin" });
  let resolveMessage;
  const received = new Promise((resolve) => { resolveMessage = resolve; });
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, session, callback) {
      let raw = "";
      stream.on("data", (chunk) => { raw += chunk.toString(); });
      stream.on("end", () => {
        const recipients = session.envelope.rcptTo.map((entry) => entry.address);
        callback();
        resolveMessage({ raw, recipients });
      });
    }
  });
  await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  let server;
  let timer;
  try {
    server = await startTestServer({
      users: [alice, admin],
      env: { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.server.address().port), SMTP_SECURE: "false", SMTP_REQUIRE_TLS: "false", SMTP_USER: "", SMTP_PASS: "", MAIL_FROM: "" },
      prepare: async (root) => {
        const directory = path.join(root, "auth", "reminders");
        await mkdir(directory, { recursive: true });
        const file = `${crypto.createHash("sha256").update(alice.id).digest("hex")}.json`;
        await writeFile(path.join(directory, file), JSON.stringify({ settings: { enabled: true, daysBefore: 3 }, sent: {} }));
        await mkdir(path.join(root, "users", alice.shortId), { recursive: true });
        const eventDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
        await writeFile(path.join(root, "users", alice.shortId, "smtp-plan.json"), JSON.stringify({ id: "smtp-plan", planId: "smtp-plan", owner: alice.shortId, ownerUserId: alice.id, carline: "X192", commodity: "Brake Hose", builds: [{ name: "SMTP build", start: eventDate }], milestones: {} }));
      }
    });
    const message = await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No SMTP reminder received")), 30000); })]);
    assert.deepEqual(message.recipients, [alice.email]);
    assert.ok(message.raw.includes(`From: ${admin.email}`));
    assert.match(message.raw, /Subject: BTV MITRA: 1 upcoming event/);
    assert.match(message.raw, /SMTP build/);
    assert.match(message.raw, /X192/);
  } finally {
    clearTimeout(timer);
    if (server) await server.stop();
    await new Promise((resolve) => smtp.close(resolve));
  }
});