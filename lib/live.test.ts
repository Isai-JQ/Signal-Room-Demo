// Pure: no DOM, no EventSource, no database. Everything the stream does to the
// page is in applyEvent, and everything the approval panel reads is in
// gateVerdicts — so both are testable as plain functions, and are.
import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, gateVerdicts, isBlocked, lastGateVerdict, liveFrom } from "./live";
import { Approval, CampaignState, StreamEvent, Variant, type CampaignStatus } from "./schemas";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const state = (campaign_id: string, status: CampaignStatus, extra: object = {}) =>
  CampaignState.parse({ campaign_id, status, ...extra });

const frame = (campaign_id: string, status: CampaignStatus, extra: object = {}) =>
  StreamEvent.parse({ status, state: state(campaign_id, status, extra) });

const variant = (id: string, treatment: "demo" | "story" | "proof") =>
  Variant.parse({ id, platform: "tiktok", treatment, hooks: ["a", "b"], body: "x" });

const verdict = (variant_id: string, v: "approved" | "rejected" | "needs_human", reviewer = "agent") =>
  Approval.parse({ variant_id, verdict: v, reviewer });

test("frames replace the state and build the timeline", () => {
  let live = liveFrom(state(ID, "collecting"));
  for (const s of ["signals", "brief", "variants"] as const) live = applyEvent(live, frame(ID, s));
  assert.equal(live.status, "variants");
  assert.deepEqual(live.history, ["collecting", "signals", "brief", "variants"]);
});

test("a replayed frame changes nothing", () => {
  const live = applyEvent(liveFrom(state(ID, "collecting")), frame(ID, "signals"));
  assert.deepEqual(applyEvent(live, frame(ID, "signals")), live);
});

test("frames from another campaign are ignored", () => {
  const live = liveFrom(state(ID, "collecting"));
  assert.deepEqual(applyEvent(live, frame(OTHER, "scheduled")), live);
});

test("nothing arrives after a terminal status", () => {
  const done = applyEvent(liveFrom(state(ID, "variants")), frame(ID, "scheduled"));
  assert.deepEqual(applyEvent(done, frame(ID, "brief")), done);
});

test("the error rides on the frame or on the state", () => {
  const live = liveFrom(state(ID, "collecting"));
  assert.equal(applyEvent(live, { ...frame(ID, "needs_human"), error: "boom" }).error, "boom");
  assert.equal(applyEvent(live, frame(ID, "needs_human", { error: "stored" })).error, "stored");
});

test("each variant gets its own verdict, never its neighbour's", () => {
  const variants = [variant("v1", "demo"), variant("v2", "story"), variant("v3", "proof")];
  // Deliberately out of order: the approvals array is append-only, so position
  // is not identity. Zipping by index would hand v1 the verdict meant for v3.
  const approvals = [verdict("v3", "rejected"), verdict("v1", "approved"), verdict("v2", "needs_human")];
  const map = gateVerdicts(variants, approvals);
  assert.equal(map.get("v1")?.verdict, "approved");
  assert.equal(map.get("v2")?.verdict, "needs_human");
  assert.equal(map.get("v3")?.verdict, "rejected");
  assert.equal(map.size, 3);
});

test("the gate's last word wins, and only the gate's", () => {
  const approvals = [
    verdict("v1", "rejected"),
    verdict("v1", "approved", "human"), // a human override is not a gate verdict
    verdict("v1", "needs_human"), // the re-gate after an edit
  ];
  assert.equal(lastGateVerdict(approvals, "v1")?.verdict, "needs_human");
  assert.equal(lastGateVerdict(approvals, "v2"), null);
});

test("anything but a clean pass is an override", () => {
  assert.equal(isBlocked(verdict("v1", "approved")), false);
  assert.equal(isBlocked(verdict("v1", "needs_human")), true);
  assert.equal(isBlocked(verdict("v1", "rejected")), true);
  // Never judged is not the same as cleared.
  assert.equal(isBlocked(null), true);
});
