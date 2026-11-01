import assert from "node:assert/strict";
import { generateRecoveryScenarios } from "../../../timing-planner/src/recoveryService.js";
import { MY_PLAN_SLOTS } from "../../../timing-planner/src/myPlans.js";
import { mockUser, startTestServer } from "./helpers/testServer.mjs";

const USER = "rectest";
const server = await startTestServer({ users: [mockUser(USER)] });
const { api } = server;
const headers = { "Content-Type": "application/json", cookie: await server.login(USER) };
const planId = "x591-recovery";
const basePlan = (duplicateRuleBuild = true) => ({
  id: planId,
  planId,
  owner: USER,
  createdBy: USER,
  lastModifiedBy: USER,
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

  for (const slot of MY_PLAN_SLOTS) {
    const target = await chat(`Use ${slot.label}`, activeSession);
    assert.equal(target.recoveryAction.type, "set-target-lane");
    assert.equal(target.recoveryAction.targetLaneId, slot.laneId);
  }

  const apply = await chat("Apply it", activeSession);
  assert.equal(apply.structuredResponse.type, "recovery_confirmation");
  assert.equal(apply.recoveryAction.operation, "apply");
  assert.equal(apply.recoveryAction.targetLaneId, "my-plan");

  for (const slot of MY_PLAN_SLOTS) {
    const copy = await chat(`Copy it to ${slot.label}`, { ...activeSession, targetLaneId: slot.laneId });
    assert.equal(copy.structuredResponse.type, "recovery_confirmation");
    assert.equal(copy.recoveryAction.operation, "copy");
    assert.equal(copy.recoveryAction.targetLaneId, slot.laneId);
    assert.ok(copy.reply.includes(`to ${slot.label}?`));
  }

  const invalidTarget = await chat("Copy it to My Plan 6", activeSession);
  assert.equal(invalidTarget.recoveryAction.type, "invalid-target");
  assert.match(invalidTarget.reply, /choose My Plan, My Plan 2, My Plan 3, My Plan 4, My Plan 5/i);

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
  await server.stop();
}