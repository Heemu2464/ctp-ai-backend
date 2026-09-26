import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { generateRecoveryScenarios } from "../../../timing-planner/src/recoveryService.js";

const root = await mkdtemp(path.join(os.tmpdir(), "btv-recovery-endpoint-"));
const port = 6200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [path.resolve("server.js")], {
  cwd: path.resolve("."),
  env: { ...process.env, PORT: String(port), BTV_STORAGE_ROOT: root, ALLOW_TEST_USER_HEADER: "true", MB_GENAI_API_KEY: "test-key", MB_GENAI_API_VERSION: "2024-10-21", MB_GENAI_ENDPOINT: "https://example.invalid" },
  stdio: "ignore"
});
const api = `http://localhost:${port}`;
const headers = { "Content-Type": "application/json", "x-user": "recovery-tester" };
const planId = "x591-recovery";
const basePlan = (duplicateRuleBuild = true) => ({
  id: planId,
  planId,
  owner: "recovery-tester",
  createdBy: "recovery-tester",
  lastModifiedBy: "recovery-tester",
  carline: "X591",
  commodity: "Recovery test",
  builds: [{ id: "b-build", name: "B-Build", start: "2026-10-20", end: "2026-10-20" }],
  milestones: duplicateRuleBuild ? { ruleBuild: { key: "ruleBuild", name: "B-Build", plannedDate: "2026-10-20" } } : {},
  customPlan: { active: true, milestones: { pv: { key: "pv", name: "PV", plannedDate: "2026-10-01" }, ppap: { key: "ppap", name: "PPAP", plannedDate: "2026-10-03", predecessorIds: ["custom:customPlan:pv"] } } },
  customPlan2: { active: false, milestones: {} },
  aiPlan: { active: false, aiMilestones: {} },
  subActivities: [],
  actuals: { "custom:customPlan:pv": { date: "2026-10-02", delayReason: "Supplier" } }
});

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${api}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Recovery endpoint test server did not start");
}

async function save(plan) {
  const response = await fetch(`${api}/api/plans/save`, { method: "POST", headers, body: JSON.stringify(plan) });
  assert.equal(response.status, 200);
}

async function chat(message, recoverySession) {
  const response = await fetch(`${api}/ai-chat`, { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: message }], selectedPlanRef: planId, selectedPlanName: "X591 - Recovery test", planCount: 1, agentContext: { selectedLane: "my-plan" }, recoverySession }) });
  assert.equal(response.status, 200);
  return response.json();
}

function sessionFor(plan, constraints = []) {
  const recovery = generateRecoveryScenarios(plan, { laneId: "my-plan", sourceItemId: "custom:customPlan:pv", delayDays: 5, objective: "protect-finish", constraints });
  const selected = recovery.scenarios.find((scenario) => scenario.feasible) || recovery.scenarios[0];
  return { sessionId: "recovery-session", planId, sourceLane: "my-plan", sourceItemId: "custom:customPlan:pv", delayDays: 5, scenarios: recovery.scenarios, selectedScenarioId: selected.scenarioId, targetLaneId: "my-plan", status: "ready", expiresAt: new Date(Date.now() + 600000).toISOString() };
}

try {
  await waitForServer();
  const duplicated = basePlan(true);
  await save(duplicated);
  const duplicateResponse = await chat("Protect B-Build", sessionFor(duplicated));
  assert.match(duplicateResponse.reply, /multiple sources/i);
  assert.equal(duplicateResponse.writeProposal, undefined);

  const unique = basePlan(false);
  await save(unique);
  const activeSession = sessionFor(unique);
  const protectedResponse = await chat("Protect B-Build", activeSession);
  assert.equal(protectedResponse.recoveryScenarios.ok, true);
  assert.equal(protectedResponse.recoveryScenarios.scenarios[0].protectedConstraints[0].targetItemId, "build:b-build");

  const alternative = await chat("Show another option", activeSession);
  assert.equal(alternative.structuredResponse.type, "recovery_follow_up");
  assert.equal(alternative.structuredResponse.intent, "SHOW_ANOTHER_RECOVERY_OPTION");
  assert.equal(alternative.recoveryAction.type, "select-option");

  const target = await chat("Use My Plan 2", activeSession);
  assert.equal(target.recoveryAction.type, "set-target-lane");
  assert.equal(target.recoveryAction.targetLaneId, "my-plan-2");

  const apply = await chat("Apply it", activeSession);
  assert.equal(apply.structuredResponse.type, "recovery_confirmation");
  assert.equal(apply.recoveryAction.operation, "apply");
  assert.equal(apply.recoveryAction.targetLaneId, "my-plan");

  const copySession = { ...activeSession, targetLaneId: "my-plan-2" };
  const copy = await chat("Copy it to My Plan 2", copySession);
  assert.equal(copy.structuredResponse.type, "recovery_confirmation");
  assert.equal(copy.recoveryAction.operation, "copy");
  assert.equal(copy.recoveryAction.targetLaneId, "my-plan-2");

  const cancel = await chat("Cancel recovery", activeSession);
  assert.equal(cancel.recoveryAction.type, "cancel");

  const expired = await chat("Apply it", { ...activeSession, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(expired.recoveryAction.type, "expired");

  const changedBuild = { ...unique, builds: [{ ...unique.builds[0], start: "2026-10-21", end: "2026-10-21" }] };
  await save(changedBuild);
  const staleSession = sessionFor(unique, [{ type: "NOT_AFTER", targetItemId: "build:b-build", targetDate: "2026-10-20", protected: true }]);
  const stale = await chat("Apply it", staleSession);
  assert.equal(stale.recoveryAction.type, "stale");
  console.log("recovery endpoint tests passed");
} finally {
  server.kill();
  await rm(root, { recursive: true, force: true });
}