import assert from "node:assert/strict";
import test from "node:test";
import { buildReadLanes, queryOpenAndOverduePlanItems, queryReadItems } from "../read-lanes.js";

const plan = {
  builds: [{ name: "E-Build", start: "2026-10-01", end: "2026-10-03" }],
  milestones: {
    before: { name: "Before window", plannedDate: "2026-09-25" },
    after: { name: "After window", plannedDate: "2026-10-27" },
    spanning: { name: "Spans whole window", plannedDate: "2026-09-01", endDate: "2026-11-01", isDuration: true },
    start: { name: "At window start", plannedDate: "2026-09-26" },
    end: { name: "At window end", plannedDate: "2026-10-26" }
  },
  customPlan: { active: true, milestones: { custom: { name: "My Plan item", plannedDate: "2026-10-10" } } },
  customPlan2: { active: true, milestones: { custom2: { name: "My Plan 2 item", plannedDate: "2026-10-11" } } },
  aiPlan: { active: true, aiMilestones: { ai: { name: "AI item", plannedDate: "2026-10-12" } } },
  subActivities: [{
    id: "stone-chipping",
    name: "Stone Chipping",
    steps: [
      { name: "E.C Approval", weekDate: "2026-09-23", type: "duration", durationWeeks: 3 },
      { name: "Parts Delivery", weekDate: "2026-09-23" }
    ]
  }]
};

const lanes = buildReadLanes(plan);
const query = (fromDate, toDate) => queryReadItems(lanes, { fromDate, toDate });

test("queries inclusive date-range intersections across every planned lane", () => {
  const result = query("2026-09-26", "2026-10-26");
  const names = result.items.map((item) => item.name).sort();

  assert.deepEqual(names, [
    "AI item", "At window end", "At window start", "E-Build", "E.C Approval",
    "My Plan 2 item", "My Plan item", "Spans whole window"
  ]);
  assert.deepEqual(result.lanesQueried, ["Build Plan", "BTV Rule Plan", "My Plan", "My Plan 2", "AI Optimized", "Stone Chipping"]);
  assert.equal(result.truncated, false);
  assert.equal(result.filteredOutCount, 3);
  assert.equal(result.items.find((item) => item.name === "E.C Approval")?.endDate, "2026-10-14");
});

test("includes range and milestone boundary dates while excluding disjoint items", () => {
  assert.ok(query("2026-09-26", "2026-10-26").items.some((item) => item.name === "E.C Approval"));
  assert.equal(query("2026-09-26", "2026-10-26").items.some((item) => item.name === "Parts Delivery"), false);
  assert.equal(query("2026-09-26", "2026-10-26").items.some((item) => item.name === "Before window"), false);
  assert.equal(query("2026-09-26", "2026-10-26").items.some((item) => item.name === "After window"), false);
  assert.ok(query("2026-09-26", "2026-10-26").items.some((item) => item.name === "Spans whole window"));
  assert.ok(query("2026-09-26", "2026-09-26").items.some((item) => item.name === "At window start"));
  assert.ok(query("2026-10-26", "2026-10-26").items.some((item) => item.name === "At window end"));
});

test("includes derived tooling spans in My Plan read results", () => {
  const toolingPlan = {
    ...plan,
    customPlan: {
      active: true,
      milestones: {
        protoToolStart: { name: "Proto Tool Start", plannedDate: "2027-02-08" },
        protoParts: { name: "Proto Parts", plannedDate: "2027-04-19" }
      }
    }
  };
  const result = queryReadItems(buildReadLanes(toolingPlan), { search: "proto tooling", fromDate: "2027-02-01", toDate: "2027-04-30" });

  assert.deepEqual(result.items, [{ name: "Proto Tooling", startDate: "2027-02-08", endDate: "2027-04-19", type: "duration", lane: "My Plan" }]);
});

test("returns the nearest real item when a date window has no results", () => {
  const result = queryReadItems(lanes, { search: "after", fromDate: "2026-10-20", toDate: "2026-10-25" });

  assert.equal(result.items.length, 0);
  assert.equal(result.nearestItemRelation, "next");
  assert.deepEqual(result.nearestItem, {
    name: "After window",
    startDate: "2026-10-27",
    endDate: "2026-10-27",
    type: "milestone",
    lane: "BTV Rule Plan"
  });
});

test("date-only overlap results do not shift at UTC+13 or UTC-8", () => {
  const originalTimeZone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Auckland";
    const auckland = query("2026-09-26", "2026-10-26").items.map((item) => item.name).sort();
    process.env.TZ = "America/Los_Angeles";
    const losAngeles = query("2026-09-26", "2026-10-26").items.map((item) => item.name).sort();
    assert.deepEqual(auckland, losAngeles);
  } finally {
    process.env.TZ = originalTimeZone;
  }
});

test("groups open and overdue items across plans and pages the result", () => {
  const result = queryOpenAndOverduePlanItems([
    { plan: "X192 - Brake Hose", lanes, closedNames: new Set(["my plan item"]) },
    { plan: "X591 - Trailer Hitch", lanes: [{ name: "Build Plan", items: [{ name: "Open build", startDate: "2026-10-01", endDate: "2026-10-03", type: "build" }] }], closedNames: new Set() }
  ], { status: "open_and_overdue", page: 1, pageSize: 2 }, "2026-09-26");

  assert.equal(result.total, 11);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, true);
  assert.ok(result.groups.every((group) => group.plan));
  assert.equal(result.groups.flatMap((group) => group.items).some((item) => item.name === "My Plan item"), false);
});