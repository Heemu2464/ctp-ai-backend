import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "btv-planner-test-"));
const port = 5127;
const server = spawn(process.execPath, [path.resolve("server.js")], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    PORT: String(port),
    BTV_STORAGE_ROOT: root,
    DEFAULT_USER: "alice",
    MB_GENAI_API_KEY: "test-key",
    MB_GENAI_API_VERSION: "2024-10-21",
    MB_GENAI_ENDPOINT: "https://example.invalid"
  },
  stdio: "ignore"
});

const api = `http://localhost:${port}`;
const headers = (user) => ({ "Content-Type": "application/json", "x-user": user });
const plan = (owner, planId, carline = "X192", commodity = "Brake Hose") => ({
  planId,
  id: planId,
  owner,
  createdBy: owner,
  lastModifiedBy: owner,
  carline,
  commodity,
  builds: [],
  milestones: {},
  subActivities: [],
  customPlan: { active: false, milestones: null },
  customPlan2: { active: false, milestones: null },
  aiPlan: { active: false, aiMilestones: null },
  finalPlanSource: "rule"
});

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${api}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Backend did not start");
}

try {
  await waitForServer();

  let response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers("alice"),
    body: JSON.stringify(plan("alice", "alice-x192-brake-hose"))
  });
  assert.equal(response.status, 200);

  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers("alice"),
    body: JSON.stringify({ ...plan("alice", "alice-x192-brake-hose"), commodity: "Updated Brake Hose" })
  });
  assert.equal(response.status, 200);

  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers("bob"),
    body: JSON.stringify(plan("bob", "bob-x591-hitch", "X591", "Trailer Hitch"))
  });
  assert.equal(response.status, 200);

  const aliceFiles = await readdir(path.join(root, "users", "alice"));
  assert.deepEqual(aliceFiles, ["alice-x192-brake-hose.json"]);
  assert.equal(await stat(path.join(root, "users", "alice", "alice-x192-brake-hose.json.tmp")).then(() => true).catch(() => false), false);

  response = await fetch(`${api}/api/plans/shared`, { headers: { "x-user": "alice" } });
  const shared = await response.json();
  assert.equal(response.status, 200);
  assert.equal(shared.plans.length, 1);
  assert.equal(shared.plans[0].owner, "bob");
  assert.equal(shared.plans[0].readOnly, true);
  assert.equal("_filePath" in shared.plans[0], false);

  await mkdir(path.join(root, "users", "charlie"), { recursive: true });
  await writeFile(path.join(root, "users", "charlie", "broken.json"), "{broken", "utf8");
  response = await fetch(`${api}/api/plans/shared`, { headers: { "x-user": "alice" } });
  const withWarning = await response.json();
  assert.equal(withWarning.warningCount, 1);
  assert.equal(withWarning.plans.length, 1);

  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers("alice"),
    body: JSON.stringify(plan("alice", "bob-x591-hitch"))
  });
  const forbiddenSave = await response.json();
  assert.equal(response.status, 403);
  assert.equal(forbiddenSave.code, "READ_ONLY_PLAN");

  response = await fetch(`${api}/api/plans/bob-x591-hitch`, {
    method: "DELETE",
    headers: { "x-user": "alice" }
  });
  assert.equal(response.status, 403);

  response = await fetch(`${api}/api/plans/copy`, {
    method: "POST",
    headers: headers("alice"),
    body: JSON.stringify({
      planId: "bob-x591-hitch",
      sourceOwner: "bob",
      carline: "X192",
      commodity: "Trailer Hitch",
      planName: "X192_TrailerHitch"
    })
  });
  const copied = await response.json();
  assert.equal(response.status, 200);
  assert.equal(copied.plan.owner, "alice");
  assert.equal(copied.plan.copiedFromOwner, "bob");
  assert.equal(copied.plan.copiedFromPlanId, "bob-x591-hitch");
  assert.equal((await readdir(path.join(root, "shared_templates"))).length, 0);

  response = await fetch(`${api}/api/plans/alice-x192-brake-hose`, {
    method: "DELETE",
    headers: { "x-user": "alice" }
  });
  assert.equal(response.status, 200);
  assert.equal(await stat(path.join(root, "users", "alice", "alice-x192-brake-hose.json")).then(() => true).catch(() => false), false);

  response = await fetch(`${api}/api/storage/status`, { headers: { "x-user": "alice" } });
  const storageStatus = await response.json();
  assert.deepEqual(storageStatus, { available: true, writable: true, currentUserFolderAvailable: true });

  console.log("storage workflow tests passed");
} finally {
  server.kill();
  await rm(root, { recursive: true, force: true });
}
