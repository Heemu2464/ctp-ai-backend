import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { mockUser, startTestServer } from "./helpers/testServer.mjs";

const ALICE = "alicexx";
const BOB = "bobbyxx";
const NEW_USER = "newuser";

const server = await startTestServer({ users: [mockUser(ALICE), mockUser(BOB), mockUser(NEW_USER)] });
const { api, root } = server;
const cookies = {};
const auth = (user) => ({ cookie: cookies[user] });
const headers = (user) => ({ "Content-Type": "application/json", cookie: cookies[user] });
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

try {
  let response = await fetch(`${api}/api/plans/my`);
  assert.equal(response.status, 401);

  response = await fetch(`${api}/ai-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "What is planned?" }] })
  });
  assert.equal(response.status, 401);

  cookies[NEW_USER] = await server.login(NEW_USER);
  response = await fetch(`${api}/api/session`, { headers: auth(NEW_USER) });
  const newUserSession = await response.json();
  assert.equal(response.status, 200);
  assert.equal(newUserSession.user, NEW_USER);
  assert.deepEqual(await readdir(path.join(root, "users", NEW_USER)), []);

  cookies[ALICE] = await server.login(ALICE);
  cookies[BOB] = await server.login(BOB);

  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify(plan(ALICE, "alice-x192-brake-hose"))
  });
  assert.equal(response.status, 200);

  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({ ...plan(ALICE, "alice-x192-brake-hose"), commodity: "Updated Brake Hose" })
  });
  assert.equal(response.status, 200);

  const planWithSubActivities = {
    ...plan(ALICE, "alice-x192-brake-hose"),
    commodity: "Updated Brake Hose",
    builds: [{ id: 1, name: "E-Build", start: "2026-10-01", end: "2026-10-03" }],
    milestones: {
      protoParts: { name: "Proto parts", plannedDate: "2026-10-01" },
      ppap: { name: "PPAP", plannedDate: "2026-10-20" }
    },
    subActivities: [{ id: "supplier-alignment", name: "Supplier alignment", steps: [{ id: "review", name: "Review timing", weekDate: "2026-09-24" }] }]
  };
  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify(planWithSubActivities)
  });
  assert.equal(response.status, 200);

  response = await fetch(`${api}/ai-chat`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({
      messages: [{ role: "user", content: "Create My Plan" }],
      selectedPlanRef: "alice-x192-brake-hose",
      planCount: 1
    })
  });
  const createMyPlanProposal = await response.json();
  assert.equal(response.status, 200);
  assert.equal(createMyPlanProposal.writeProposal.action, "createPlanLane");
  assert.equal(createMyPlanProposal.writeProposal.sourceName, "Rule-Based Plan");
  assert.equal(createMyPlanProposal.writeProposal.targetName, "My Plan");
  assert.equal(createMyPlanProposal.writeProposal.copiedCount, 2);

  const planPath = path.join(root, "users", ALICE, "alice-x192-brake-hose.json");
  const planBeforeJournalWrites = await readFile(planPath, "utf8");
  const journalBase = `${api}/api/plans/alice-x192-brake-hose/rows`;
  response = await fetch(`${journalBase}/build-plan/journal`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({
      entryDate: "2026-09-25",
      text: "Supplier confirmed samples.\nTesting remains open.",
      attachments: [
        { id: "test-image", name: "evidence.png", type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
        { id: "test-document", name: "supplier-notes.pdf", type: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0=" }
      ]
    })
  });
  const firstJournalCreate = await response.json();
  assert.equal(response.status, 201);
  assert.equal(firstJournalCreate.entry.rowId, "build-plan");
  assert.equal(firstJournalCreate.entry.attachments[0].name, "evidence.png");
  assert.equal(firstJournalCreate.entry.attachments[1].name, "supplier-notes.pdf");

  response = await fetch(`${journalBase}/rule-plan/journal`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({ entryDate: "2026-09-25", text: "Rule row only." })
  });
  assert.equal(response.status, 201);

  response = await fetch(`${journalBase}/build-plan/journal`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({ entryDate: "not-a-date", text: "Invalid." })
  });
  assert.equal(response.status, 400);

  response = await fetch(`${journalBase}/build-plan/journal`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({ entryDate: "2026-09-26", text: "Second build entry." })
  });
  assert.equal(response.status, 201);

  response = await fetch(`${journalBase}/build-plan/journal?page=1&pageSize=1&sort=desc`, { headers: auth(ALICE) });
  const firstJournalPage = await response.json();
  assert.equal(response.status, 200);
  assert.equal(firstJournalPage.total, 2);
  assert.equal(firstJournalPage.items.length, 1);
  assert.equal(firstJournalPage.hasMore, true);
  response = await fetch(`${journalBase}/build-plan/journal?page=2&pageSize=1&sort=desc`, { headers: auth(ALICE) });
  const secondJournalPage = await response.json();
  assert.equal(secondJournalPage.items.find((entry) => entry.id === firstJournalCreate.entry.id).attachments[0].id, "test-image");

  response = await fetch(`${api}/api/plans/my`, { headers: auth(ALICE) });
  const listedPlans = await response.json();
  assert.equal(response.status, 200);
  assert.equal(listedPlans.plans.length, 1);
  assert.equal(listedPlans.plans[0].carline, "X192");
  assert.equal(listedPlans.plans[0].commodity, "Updated Brake Hose");

  response = await fetch(`${journalBase}/rule-plan/journal?page=1&pageSize=50`, { headers: auth(ALICE) });
  const isolatedJournal = await response.json();
  assert.equal(isolatedJournal.total, 1);
  assert.equal(isolatedJournal.items[0].text, "Rule row only.");

  response = await fetch(`${journalBase}/build-plan/journal/${firstJournalCreate.entry.id}`, {
    method: "PUT",
    headers: headers(ALICE),
    body: JSON.stringify({ entryDate: "2026-09-27", text: "Supplier update corrected." })
  });
  const updatedJournalEntry = await response.json();
  assert.equal(response.status, 200);
  assert.equal(updatedJournalEntry.entry.id, firstJournalCreate.entry.id);
  assert.equal(updatedJournalEntry.entry.text, "Supplier update corrected.");

  response = await fetch(`${journalBase}/build-plan/journal/${firstJournalCreate.entry.id}`, { method: "DELETE", headers: auth(ALICE) });
  assert.equal(response.status, 200);
  response = await fetch(`${journalBase}/build-plan/journal/count`, { headers: auth(ALICE) });
  assert.equal((await response.json()).count, 1);

  const rapidSaves = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(`${journalBase}/rapid-save/journal`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({ entryDate: "2026-09-26", text: `Rapid save ${index + 1}` })
  })));
  assert.ok(rapidSaves.every((result) => result.status === 201));
  const rapidEntries = await Promise.all(rapidSaves.map((result) => result.json()));
  assert.equal(new Set(rapidEntries.map((result) => result.entry.id)).size, 8);
  response = await fetch(`${journalBase}/rapid-save/journal?page=1&pageSize=50`, { headers: auth(ALICE) });
  const rapidJournal = await response.json();
  assert.equal(rapidJournal.total, 8);
  assert.equal(rapidJournal.items.length, 8);
  assert.equal(await readFile(planPath, "utf8"), planBeforeJournalWrites);

  // A later build-plan/DAPS update must not modify user-managed subactivities.
  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({ ...planWithSubActivities, builds: [{ id: 1, name: "E-Build", start: "2026-10-08", end: "2026-10-10" }] })
  });
  const buildUpdatedPlan = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(buildUpdatedPlan.plan.subActivities, planWithSubActivities.subActivities);

  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers(BOB),
    body: JSON.stringify(plan(BOB, "bob-x591-hitch", "X591", "Trailer Hitch"))
  });
  assert.equal(response.status, 200);
  await writeFile(
    path.join(root, "users", BOB, "stray-copy.json"),
    JSON.stringify(plan(BOB, "bob-x591-hitch", "X591", "Trailer Hitch")),
    "utf8"
  );

  const aliceFiles = await readdir(path.join(root, "users", ALICE));
  assert.ok(aliceFiles.includes("alice-x192-brake-hose.json"));
  assert.ok(aliceFiles.includes("journals"));
  assert.equal(await stat(path.join(root, "users", ALICE, "alice-x192-brake-hose.json.tmp")).then(() => true).catch(() => false), false);

  // Legacy files can have a filename that does not match their plan ID. Deletion must use the
  // actual matched file path rather than reconstructing a new filename from plan metadata.
  await writeFile(
    path.join(root, "users", ALICE, "legacy-storage-name.json"),
    JSON.stringify(plan(ALICE, "legacy-plan-id", "X591", "Legacy Hitch")),
    "utf8"
  );
  response = await fetch(`${api}/api/plans/legacy-plan-id`, {
    method: "DELETE",
    headers: auth(ALICE)
  });
  assert.equal(response.status, 200);
  assert.equal(await stat(path.join(root, "users", ALICE, "legacy-storage-name.json")).then(() => true).catch(() => false), false);

  response = await fetch(`${api}/api/plans/shared`, { headers: auth(ALICE) });
  const shared = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(shared.plans.map((entry) => entry.planId), ["bob-x591-hitch"]);
  assert.equal(shared.plans[0].readOnly, true);
  assert.equal(shared.plans[0].ownerUserId, undefined);
  assert.equal(shared.plans[0]._filePath, undefined);

  response = await fetch(`${api}/ai-chat`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({
      messages: [{ role: "user", content: "What is planned?" }],
      selectedPlanRef: "missing-plan-id",
      planCount: 2
    })
  });
  const missingPlanReference = await response.json();
  assert.equal(response.status, 409);
  assert.match(missingPlanReference.error, /missing-plan-id could not be resolved/);

  await mkdir(path.join(root, "users", "charlie"), { recursive: true });
  await writeFile(path.join(root, "users", "charlie", "broken.json"), "{broken", "utf8");
  response = await fetch(`${api}/api/plans/shared`, { headers: auth(ALICE) });
  const withWarning = await response.json();
  assert.equal(withWarning.warningCount, 0);
  assert.equal(withWarning.plans.length, 1);

  response = await fetch(`${api}/api/plans/save`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify(plan(ALICE, "bob-x591-hitch"))
  });
  const forbiddenSave = await response.json();
  assert.equal(response.status, 403);
  assert.equal(forbiddenSave.code, "READ_ONLY_PLAN");

  response = await fetch(`${api}/api/plans/bob-x591-hitch`, {
    method: "DELETE",
    headers: auth(ALICE)
  });
  assert.equal(response.status, 403);

  response = await fetch(`${api}/api/plans/copy`, {
    method: "POST",
    headers: headers(ALICE),
    body: JSON.stringify({
      planId: "bob-x591-hitch",
      carline: "X192",
      commodity: "Trailer Hitch",
      planName: "X192_TrailerHitch"
    })
  });
  const copied = await response.json();
  assert.equal(response.status, 200);
  assert.equal(copied.plan.owner, ALICE);
  assert.equal(copied.plan.copiedFromPlanId, "bob-x591-hitch");
  assert.equal(copied.plan.readOnly, false);
  response = await fetch(`${api}/api/plans/bob-x591-hitch`, { headers: auth(BOB) });
  assert.equal((await response.json()).plan.owner, BOB);
  assert.equal((await readdir(path.join(root, "shared_templates"))).length, 0);

  response = await fetch(`${api}/api/plans/alice-x192-brake-hose`, {
    method: "DELETE",
    headers: auth(ALICE)
  });
  assert.equal(response.status, 200);
  assert.equal(await stat(path.join(root, "users", ALICE, "alice-x192-brake-hose.json")).then(() => true).catch(() => false), false);

  response = await fetch(`${api}/api/storage/status`, { headers: auth(ALICE) });
  const storageStatus = await response.json();
  assert.deepEqual(storageStatus, { available: true, writable: true, currentUserFolderAvailable: true });

  console.log("storage workflow tests passed");
} finally {
  await server.stop();
}
