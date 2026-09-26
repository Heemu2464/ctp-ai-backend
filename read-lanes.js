function shiftDateOnly(value, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const millis = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + Number(days) * 86400000;
  return new Date(millis).toISOString().slice(0, 10);
}

function durationEndDate(item, startDate) {
  const durationWeeks = Math.max(1, Number(item?.durationWeeks || 1));
  const isDuration = item?.isDuration || item?.type === "duration" || durationWeeks > 1;
  if (!isDuration) return startDate;
  return item?.endDate || shiftDateOnly(startDate, durationWeeks * 7) || startDate;
}

function milestoneItems(milestones, source) {
  return Object.values(milestones || {}).map((item) => {
    const startDate = source === "rule" ? item.overrideDate || item.plannedDate || "" : item.plannedDate || "";
    return {
      name: item.name || "Milestone",
      startDate,
      endDate: durationEndDate(item, startDate),
      type: item.isDuration || item.type === "duration" || Number(item.durationWeeks || 1) > 1 ? "duration" : "milestone"
    };
  });
}

export function buildReadLanes(plan) {
  const lanes = [
    { rowId: "build-plan", name: "Build Plan", items: (plan.builds || []).map((build) => ({ name: build.name || build.label || "Build", startDate: build.start || build.date || "", endDate: build.end || build.endDate || build.start || build.date || "", type: "build" })) },
    { rowId: "rule-plan", name: "BTV Rule Plan", items: milestoneItems(plan.milestones, "rule") },
    { rowId: "my-plan", name: "My Plan", items: plan.customPlan?.active ? milestoneItems(plan.customPlan.milestones, "custom") : [] },
    { rowId: "my-plan-2", name: "My Plan 2", items: plan.customPlan2?.active ? milestoneItems(plan.customPlan2.milestones, "custom") : [] },
    { rowId: "ai-optimized", name: "AI Optimized", items: plan.aiPlan?.active ? milestoneItems(plan.aiPlan.aiMilestones, "custom") : [] }
  ];

  for (const activity of plan.subActivities || []) {
    lanes.push({
      rowId: `sub-activity-${activity.id}`,
      name: activity.name || "Sub-Activity",
      items: (activity.steps || []).map((step) => {
        const startDate = step.weekDate || "";
        return { name: step.name || "Step", startDate, endDate: durationEndDate(step, startDate), type: step.type === "duration" || Number(step.durationWeeks || 1) > 1 ? "duration" : "milestone" };
      })
    });
  }

  return lanes.map((lane) => ({ ...lane, items: lane.items.filter((item) => item.startDate && item.endDate) })).filter((lane) => lane.items.length || lane.rowId.startsWith("sub-activity-"));
}

export function queryReadItems(lanes, filter = {}) {
  const search = String(filter.search || "").trim().toLowerCase();
  const selectedLanes = filter.laneId ? lanes.filter((lane) => lane.rowId === filter.laneId) : lanes;
  const sourceItemCount = selectedLanes.reduce((count, lane) => count + lane.items.length, 0);
  const items = selectedLanes.flatMap((lane) => lane.items
    .filter((item) => (!search || item.name.toLowerCase().includes(search)) && (!filter.fromDate || item.endDate >= filter.fromDate) && (!filter.toDate || item.startDate <= filter.toDate))
    .map((item) => ({ ...item, lane: lane.name })));
  const candidates = selectedLanes.flatMap((lane) => lane.items
    .filter((item) => !search || item.name.toLowerCase().includes(search))
    .map((item) => ({ ...item, lane: lane.name })));
  const nextItem = filter.toDate ? candidates.filter((item) => item.startDate > filter.toDate).sort((left, right) => left.startDate.localeCompare(right.startDate))[0] : null;
  const previousItem = filter.fromDate ? candidates.filter((item) => item.endDate < filter.fromDate).sort((left, right) => right.endDate.localeCompare(left.endDate))[0] : null;
  const nearestItem = nextItem || previousItem || null;
  const nearestItemRelation = nextItem ? "next" : previousItem ? "previous" : null;
  return { items, sourceItemCount, filteredOutCount: sourceItemCount - items.length, lanesQueried: selectedLanes.map((lane) => lane.name), nearestItem, nearestItemRelation, truncated: false };
}

export function queryOpenAndOverduePlanItems(planEntries, filter = {}, today) {
  const search = String(filter.search || "").trim().toLowerCase();
  const status = ["open", "overdue", "open_and_overdue"].includes(filter.status) ? filter.status : "open_and_overdue";
  const page = Math.max(1, Number(filter.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(filter.pageSize) || 25));
  const items = [];

  for (const entry of planEntries) {
    for (const lane of entry.lanes || []) {
      for (const item of lane.items || []) {
        if (entry.closedNames?.has(item.name.toLowerCase()) || (search && !item.name.toLowerCase().includes(search))) continue;
        if (filter.fromDate && item.endDate < filter.fromDate) continue;
        if (filter.toDate && item.startDate > filter.toDate) continue;
        const itemStatus = item.endDate < today ? "overdue" : "open";
        if (status !== "open_and_overdue" && itemStatus !== status) continue;
        items.push({ ...item, status: itemStatus, lane: lane.name, plan: entry.plan });
      }
    }
  }

  items.sort((left, right) => left.status.localeCompare(right.status) || left.startDate.localeCompare(right.startDate) || left.plan.localeCompare(right.plan));
  const total = items.length;
  const pageItems = items.slice((page - 1) * pageSize, page * pageSize);
  const groups = Object.values(pageItems.reduce((grouped, item) => {
    const group = grouped[item.plan] || { plan: item.plan, items: [] };
    group.items.push(item);
    grouped[item.plan] = group;
    return grouped;
  }, {}));
  return { groups, total, page, pageSize, hasMore: page * pageSize < total, truncated: page * pageSize < total };
}