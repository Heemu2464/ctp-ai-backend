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

function linkedToolingSpans(milestones, source) {
  const getDate = (key) => source === "rule"
    ? milestones?.[key]?.overrideDate || milestones?.[key]?.plannedDate || ""
    : milestones?.[key]?.plannedDate || "";
  return [
    { name: "Proto Tooling", startKey: "protoToolStart", endKey: "protoParts" },
    { name: "Series Tooling", startKey: "seriesToolStart", endKey: "eswft" }
  ].flatMap((span) => {
    const startDate = getDate(span.startKey);
    const endDate = getDate(span.endKey);
    return startDate && endDate && endDate >= startDate
      ? [{ name: span.name, startDate, endDate, type: "duration" }]
      : [];
  });
}

export function buildReadLanes(plan) {
  const lanes = [
    { rowId: "build-plan", name: "Build Plan", items: (plan.builds || []).map((build) => ({ name: build.name || build.label || "Build", startDate: build.start || build.date || "", endDate: build.end || build.endDate || build.start || build.date || "", type: "build" })) },
    { rowId: "rule-plan", name: "BTV Rule Plan", items: milestoneItems(plan.milestones, "rule") },
    { rowId: "my-plan", name: "My Plan", items: plan.customPlan?.active ? [...milestoneItems(plan.customPlan.milestones, "custom"), ...linkedToolingSpans(plan.customPlan.milestones, "custom")] : [] },
    { rowId: "my-plan-2", name: "My Plan 2", items: plan.customPlan2?.active ? [...milestoneItems(plan.customPlan2.milestones, "custom"), ...linkedToolingSpans(plan.customPlan2.milestones, "custom")] : [] },
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

const ALL_ROWS_PATTERN = /^(?:|all|any|every|everything|\*|all rows|all lanes|whole plan|entire plan|complete|mom|journal|all mom|all journals?)$/i;

export function isAllJournalRows(rowQuery) {
  return ALL_ROWS_PATTERN.test(String(rowQuery || "").trim());
}

const compactName = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// A bare carline ("X591") covers every commodity plan of that carline.
export function plansForCarline(query, plans) {
  const compactQuery = compactName(query);
  if (compactQuery.length < 3) return [];
  return plans.filter((plan) => {
    const carline = compactName(plan.carline);
    return carline.length >= 3 && (compactQuery === carline || compactQuery.includes(carline));
  });
}

export function journalRowName(plan, rowId) {
  const fixed = { "build-plan": "Build Plan", "rule-plan": "BTV Rule Plan", "ai-optimized": "AI Optimized", "supplier-imports": "Supplier Imported Milestones", "my-plan": "My Plan" };
  if (fixed[rowId]) return fixed[rowId];
  const myPlan = /^my-plan-(\d+)$/.exec(rowId);
  if (myPlan) return `My Plan ${myPlan[1]}`;
  if (rowId.startsWith("sub-activity-")) {
    const activity = (plan.subActivities || []).find((candidate) => `sub-activity-${candidate.id}`.replace(/[^a-zA-Z0-9._-]+/g, "_") === rowId || `sub-activity-${candidate.id}` === rowId);
    if (activity) return String(activity.name || "Sub-Activity").replace(/\s+/g, " ").trim();
  }
  if (rowId.startsWith("actual-")) {
    const execution = [...(plan.actualExecutionHistory || []), plan.actualExecution].find((candidate) => candidate && `actual-${candidate.id}` === rowId);
    return execution?.name || "Actual Execution";
  }
  return rowId;
}

const SEARCH_STOP_WORDS = new Set(["the", "and", "for", "with", "what", "which", "when", "where", "who", "how", "should", "would", "could", "about", "from", "this", "that", "there", "have", "has", "are", "was", "were", "topic", "row", "lane", "plan", "mom", "journal", "entry", "entries", "email", "mail", "der", "die", "das", "und", "mit", "für", "von"]);

// Word stems (first 5 letters) so "stakeholders alignment" also hits "stakeholder" and "align on".
function searchStems(search) {
  return [...new Set(String(search || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 && !SEARCH_STOP_WORDS.has(word)).map((word) => word.slice(0, 5)))];
}

// Keywords only rank entries (best match first, then newest); nothing is dropped, because exact wording rarely matches the question.
export function selectJournalEntries(entries, { search = "", fromDate = "", toDate = "", limit = 40, maxChars = 120000, maxEntryChars = 40000 } = {}) {
  const stems = searchStems(search);
  const inRange = entries.filter((entry) => (!fromDate || String(entry.entryDate || "") >= fromDate) && (!toDate || String(entry.entryDate || "") <= toDate));
  const scored = inRange.map((entry) => {
    const haystack = `${entry.text || ""} ${entry.lane || ""}`.toLowerCase();
    return { entry, score: stems.filter((stem) => haystack.includes(stem)).length };
  });
  const matching = scored
    .sort((left, right) => right.score - left.score || String(right.entry.entryDate || "").localeCompare(String(left.entry.entryDate || "")) || String(right.entry.createdAt || "").localeCompare(String(left.entry.createdAt || "")))
    .map((item) => item.entry);
  const matchedCount = scored.filter((item) => item.score > 0).length;
  const selected = [];
  let used = 0;
  let shortened = false;
  for (const entry of matching.slice(0, Math.max(1, Math.min(Number(limit) || 40, 100)))) {
    const room = Math.min(maxEntryChars, maxChars - used);
    if (room < 200) break;
    const text = String(entry.text || "");
    const clipped = text.length > room ? `${text.slice(0, room)} [entry shortened]` : text;
    shortened ||= clipped !== text;
    used += clipped.length;
    selected.push({ plan: entry.plan, lane: entry.lane, entryDate: entry.entryDate, text: clipped, attachments: entry.attachments || [] });
  }
  return {
    entries: selected,
    total: matching.length,
    returned: selected.length,
    keywordMatches: stems.length ? matchedCount : undefined,
    truncated: shortened || selected.length < matching.length,
    guidance: "Entries are ranked by keyword overlap, not filtered. Read every returned entry and answer from its meaning, even when the user's wording differs from the text."
  };
}