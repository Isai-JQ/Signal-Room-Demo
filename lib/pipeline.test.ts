import assert from "node:assert/strict";
import test from "node:test";
import { worstVerdict } from "./pipeline";
import { CampaignStatus, type Approval } from "./schemas";

const a = (verdict: Approval["verdict"]): Approval => ({
  variant_id: verdict,
  verdict,
  violations: [],
  reviewer: "agent",
});

test("one blocked variant blocks the campaign", () => {
  assert.equal(worstVerdict([a("approved"), a("rejected"), a("needs_human")]), "rejected");
  assert.equal(worstVerdict([a("approved"), a("needs_human")]), "needs_human");
  assert.equal(worstVerdict([a("approved"), a("approved")]), "approved");
});

test("every verdict is also a campaign status, so nothing has to be translated", () => {
  for (const v of ["approved", "rejected", "needs_human"] as const) {
    assert.equal(CampaignStatus.safeParse(v).success, true, v);
  }
});
