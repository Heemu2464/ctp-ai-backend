import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { buildReadLanes } from "./read-lanes.js";
import { getMyPlanSlot } from "../../timing-planner/src/myPlans.js";

export function resolveReminderSender(users, configuredFrom = "") {
  if (String(configuredFrom).trim()) return String(configuredFrom).trim();
  return users
    .filter((user) => user.role === "admin" && user.status === "approved" && !user.passwordResetRequired && /^[^\s@<>(),;:]+@[^\s@<>(),;:]+$/.test(String(user.email || "")))
    .sort((left, right) => String(left.shortId).localeCompare(String(right.shortId)))[0]?.email || "";
}

export function validateReminderSettings(value) {
  if (typeof value?.enabled !== "boolean" || !Number.isInteger(value?.daysBefore) || value.daysBefore < 0 || value.daysBefore > 365) {
    return { error: "Choose whether reminders are enabled and a whole number of days from 0 to 365." };
  }
  return { value: { enabled: value.enabled, daysBefore: value.daysBefore } };
}

function dateMillis(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return NaN;
  const millis = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value ? millis : NaN;
}

export function collectReminderEvents(plans, user, today, daysBefore) {
  const events = new Map();
  const todayMillis = dateMillis(today);
  for (const plan of plans) {
    if (String(plan.ownerUserId || "") !== String(user.id) || plan.isWalkthroughDemo || plan.readOnly || plan.sharedFolder) continue;
    const slot = getMyPlanSlot(plan.finalPlanSource);
    const finalCustom = slot && plan[slot.field]?.active ? plan[slot.field] : null;
    const finalLane = finalCustom ? "my-plan" : ["ai", "aiPlan"].includes(plan.finalPlanSource) && plan.aiPlan?.active ? "ai-optimized" : "rule-plan";
    const lanes = buildReadLanes({ ...plan, customPlan: finalCustom || plan.customPlan });
    for (const lane of lanes.filter((entry) => entry.rowId === "build-plan" || entry.rowId === finalLane || entry.rowId.startsWith("sub-activity-"))) {
      for (const item of lane.items) {
        const daysUntil = (dateMillis(item.startDate) - todayMillis) / 86400000;
        if (!Number.isFinite(daysUntil) || daysUntil < 0 || daysUntil > daysBefore) continue;
        const key = crypto.createHash("sha256").update(JSON.stringify([user.id, plan.planId || plan.id, lane.rowId, item.name, item.startDate])).digest("hex");
        events.set(key, { key, name: item.name, date: item.startDate, daysUntil, lane: lane.name, carline: plan.carline, commodity: plan.commodity, partNumber: plan.planningScope === "partNumber" ? plan.componentInfo?.partNumber || "" : "" });
      }
    }
  }
  return [...events.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function createReminderStore(storageRoot) {
  const directory = path.join(storageRoot, "auth", "reminders");
  const queues = new Map();
  const fileFor = (userId) => path.join(directory, `${crypto.createHash("sha256").update(String(userId)).digest("hex")}.json`);
  async function read(userId) {
    try {
      const state = JSON.parse(await fs.readFile(fileFor(userId), "utf8"));
      if (!validateReminderSettings(state.settings).value || !state.sent || typeof state.sent !== "object" || Array.isArray(state.sent)) throw new Error("Invalid reminder storage.");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return { settings: { enabled: false, daysBefore: 3 }, sent: {} };
      throw error;
    }
  }
  async function update(userId, operation) {
    const previous = queues.get(userId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const state = await operation(await read(userId));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${fileFor(userId)}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        await fs.rename(temporaryPath, fileFor(userId));
      } finally {
        await fs.unlink(temporaryPath).catch(() => {});
      }
      return state;
    });
    queues.set(userId, next);
    try { return await next; } finally { if (queues.get(userId) === next) queues.delete(userId); }
  }
  return {
    read,
    async saveSettings(userId, settings) {
      const checked = validateReminderSettings(settings);
      if (!checked.value) throw new Error(checked.error);
      return update(userId, (state) => ({ ...state, settings: checked.value }));
    },
    markSent(userId, events, today) {
      return update(userId, (state) => ({ ...state, sent: { ...Object.fromEntries(Object.entries(state.sent).filter(([, date]) => date >= today)), ...Object.fromEntries(events.map((event) => [event.key, event.date])) } }));
    }
  };
}

export function createReminderRunner({ store, listUsers, getPlans, sendMail, now = () => new Date(), onError = () => {} }) {
  let running = false;
  return async function checkReminders() {
    if (running) return;
    running = true;
    try {
      const today = now().toISOString().slice(0, 10);
      for (const user of await listUsers()) {
        if (user.status !== "approved" || !/^[^\s@<>(),;:]+@[^\s@<>(),;:]+$/.test(String(user.email || "")) || user.passwordResetRequired) continue;
        try {
          const state = await store.read(user.id);
          if (!state.settings.enabled) continue;
          const plans = await getPlans(user);
          const latest = await store.read(user.id);
          if (!latest.settings.enabled) continue;
          const events = collectReminderEvents(plans, user, today, latest.settings.daysBefore).filter((event) => !latest.sent[event.key]);
          if (!events.length) continue;
          await sendMail({
            to: user.email,
            subject: `BTV MITRA: ${events.length} upcoming event${events.length === 1 ? "" : "s"}`,
            text: `Upcoming events for ${user.displayName || user.shortId}:\n\n${events.map((event) => `${event.date} (${event.daysUntil === 0 ? "today" : `in ${event.daysUntil} days`}) - ${event.name}\n${event.carline} / ${event.commodity}${event.partNumber ? ` / ${event.partNumber}` : ""} - ${event.lane}`).join("\n\n")}\n\nReminder lead time: ${latest.settings.daysBefore} days (UTC calendar dates).`
          });
          await store.markSent(user.id, events, today);
        } catch (error) { onError(error); }
      }
    } catch (error) { onError(error); } finally { running = false; }
  };
}