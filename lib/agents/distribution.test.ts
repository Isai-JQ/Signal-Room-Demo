import assert from "node:assert/strict";
import test from "node:test";
import { nextOccurrence, peakHour } from "./distribution";

const at = (day: number, hour: number) =>
  new Date(Date.UTC(2026, 0, day, hour, 30)).toISOString();

test("the peak is the densest hour of day, not the busiest day", () => {
  // 19:00 wins on the fold even though no single day has more than two.
  const peak = peakHour([at(1, 19), at(2, 19), at(3, 19), at(1, 9), at(1, 9), at(4, 2)]);
  assert.equal(peak.hour, 19);
  assert.equal(peak.count, 3);
  assert.equal(peak.total, 6);
  assert.equal(peak.histogram.reduce((a, b) => a + b, 0), 6);
});

test("ties go to the earlier hour, whatever the row order", () => {
  const a = peakHour([at(1, 21), at(1, 6), at(2, 21), at(2, 6)]);
  const b = peakHour([at(2, 6), at(1, 21), at(2, 21), at(1, 6)]);
  assert.equal(a.hour, 6);
  assert.equal(b.hour, 6);
});

test("an empty cluster is an error, not hour zero", () => {
  assert.throws(() => peakHour([]), /no usable timestamps/);
});

test("the publish slot is always in the future", () => {
  const now = new Date("2026-01-10T14:00:00.000Z");
  assert.equal(nextOccurrence(19, now), "2026-01-10T19:00:00.000Z");
  // Already past today, and 14:00 exactly counts as past: never schedule at now.
  assert.equal(nextOccurrence(9, now), "2026-01-11T09:00:00.000Z");
  assert.equal(nextOccurrence(14, now), "2026-01-11T14:00:00.000Z");
});
