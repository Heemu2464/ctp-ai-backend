const DAY_MS = 86400000;
const SPAN_TYPES = new Set(["proto", "series", "pro", "tooling", "validation"]);
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

const toUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const fromUtc = (millis) => new Date(millis).toISOString().slice(0, 10);

// "20 days", "6 wks", "3 Monate", "2 Wochen" -> inclusive end date; null when it is not a usable span.
export function endFromDuration(startIso, durationText) {
  if (!isoDay.test(String(startIso || ""))) return null;
  const match = /(\d+(?:[.,]\d+)?)\s*(days?|tage[n]?|d|weeks?|wks?|wochen?|w|months?|monate[n]?|monat|mo)\b/i.exec(String(durationText || ""));
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  const unit = match[2].toLowerCase();
  if (!(amount > 0)) return null;
  const start = toUtc(startIso);
  if (/^(w|wk|week|wochen?)/.test(unit)) return fromUtc(start + (Math.round(amount * 7) - 1) * DAY_MS);
  if (/^(m|mo|month|monat)/.test(unit)) {
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + Math.round(amount));
    return fromUtc(end.getTime() - DAY_MS);
  }
  const days = Math.round(amount);
  return days > 1 ? fromUtc(start + (days - 1) * DAY_MS) : null;
}

// Vehicle builds, tooling, and validation phases are spans; rows of those types with zero length mean the bar extent was not read.
export function collapsedBars(rows) {
  return (rows || []).filter((row) => SPAN_TYPES.has(row?.type || row?.role) && isoDay.test(row.start || "") && (!row.end || row.end === row.start));
}

export function needsBarVerification(rows) {
  const spans = (rows || []).filter((row) => SPAN_TYPES.has(row?.type || row?.role) && isoDay.test(row.start || ""));
  return spans.length >= 2 && collapsedBars(rows).length / spans.length >= 0.5;
}

export const BAR_VERIFICATION_REMINDER = [
  "Verification pass for graphical timeline bars: this image is a Gantt-style chart, so every bar has a LEFT edge and a RIGHT edge on the time axis.",
  "For each bar, read the time-axis header (year row, month row, calendar-week row) and find which column the bar's left edge starts in and which column its right edge ends in.",
  "start = the date at the left edge; end = the last day of the column where the right edge ends. A bar that is several columns wide must have an end date clearly after its start date.",
  "A date written inside or beside the bar (for example 'IB 6/2', 'IB: 5/25') is the date that belongs to that bar's start or key date; keep it as start when it matches the left edge, and still take the END from the right edge.",
  "Never copy the start date into the end date for a bar that has visible width. Only thin markers, diamonds, and flags are single-day milestones (start = end).",
  "If a bar label is cut off with '...', still measure the bar on the axis and set confidence to 'medium'."
].join(" ");
