import assert from "node:assert/strict";
import test from "node:test";
import { collapsedBars, endFromDuration, needsBarVerification } from "../planImport.js";

test("derives an inclusive end date from a stated duration", () => {
  assert.equal(endFromDuration("2026-06-02", "6 wks"), "2026-07-13");
  assert.equal(endFromDuration("2026-06-02", "20 days"), "2026-06-21");
  assert.equal(endFromDuration("2026-06-02", "3 Monate"), "2026-09-01");
  assert.equal(endFromDuration("2026-06-02", "2 Wochen"), "2026-06-15");
  assert.equal(endFromDuration("2026-06-02", "0 days"), null);
  assert.equal(endFromDuration("2026-06-02", "1 day"), null);
  assert.equal(endFromDuration("2026-06-02", ""), null);
  assert.equal(endFromDuration("", "4 wks"), null);
});

test("detects Gantt bars that all collapsed to a single day", () => {
  const bar = (name, type, start, end) => ({ name, type, start, end });
  const collapsed = [
    bar("AF BL 2", "series", "2026-06-02", "2026-06-02"),
    bar("BF BL 1", "series", "2027-03-02", "2027-03-02"),
    bar("PT 1", "pro", "2028-02-01", "2028-02-01"),
    bar("SOP", "sop", "2028-06-01", "2028-06-01")
  ];
  assert.equal(collapsedBars(collapsed).length, 3);
  assert.equal(needsBarVerification(collapsed), true);

  const measured = [
    bar("AF BL 2", "series", "2026-06-02", "2026-10-08"),
    bar("BF BL 1", "series", "2027-03-02", "2027-04-20"),
    bar("PT 1", "pro", "2028-02-01", "2028-02-01"),
    bar("SOP", "sop", "2028-06-01", "2028-06-01")
  ];
  assert.equal(needsBarVerification(measured), false);
  assert.equal(needsBarVerification([bar("Only", "series", "2026-06-02", "2026-06-02")]), false);
  assert.equal(needsBarVerification([bar("SOP", "sop", "2028-06-01", "2028-06-01"), bar("Gate", "milestone", "2028-02-01", "2028-02-01")]), false);
});
