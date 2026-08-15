import assert from "node:assert/strict";
import test from "node:test";
import type { db as Db } from "./db";
import { decide, PipelineError, shippableVariantIds, worstVerdict } from "./pipeline";
import { brand_rules, campaigns } from "./schema";
import { CampaignState, CampaignStatus, HumanDecision, type Approval } from "./schemas";

const a = (
  verdict: Approval["verdict"],
  variant_id: string = verdict,
  reviewer: Approval["reviewer"] = "agent",
): Approval => ({
  variant_id,
  verdict,
  violations: [],
  reviewer,
  reviewed_by: reviewer === "human" ? "ana@example.com" : null,
  reason: null,
  overrode: null,
});

test("one blocked variant blocks the campaign", () => {
  assert.equal(worstVerdict([a("approved"), a("rejected"), a("needs_human")]), "rejected");
  assert.equal(worstVerdict([a("approved"), a("needs_human")]), "needs_human");
  assert.equal(worstVerdict([a("approved"), a("approved")]), "approved");
});

test("the human's pick beats the gate's blanket approval", () => {
  const gate = [a("approved", "v1"), a("approved", "v2"), a("approved", "v3")];
  // No human yet (pnpm pipeline): everything the gate cleared is shippable.
  assert.deepEqual(shippableVariantIds(gate), new Set(["v1", "v2", "v3"]));
  // A human picked v2, so v1 and v3 do not ship even though the gate liked them.
  assert.deepEqual(
    shippableVariantIds([...gate, a("approved", "v2", "human")]),
    new Set(["v2"]),
  );
  assert.deepEqual(shippableVariantIds([...gate, a("rejected", "v2", "human")]), new Set());
});

test("a human has to say who they are, and why when it is not a plain approve", () => {
  const base = { variant_id: "v1", reviewed_by: "ana@example.com" };
  assert.equal(HumanDecision.safeParse({ ...base, action: "approve" }).success, true);
  assert.equal(HumanDecision.safeParse({ action: "approve", variant_id: "v1" }).success, false);
  assert.equal(HumanDecision.safeParse({ ...base, action: "reject" }).success, false);
  assert.equal(
    HumanDecision.safeParse({ ...base, action: "reject", reason: "off-brand" }).success,
    true,
  );
  // edit needs both a reason and something actually changed.
  assert.equal(HumanDecision.safeParse({ ...base, action: "edit", reason: "tighten" }).success, false);
  assert.equal(
    HumanDecision.safeParse({ ...base, action: "edit", reason: "tighten", edits: { body: "x" } })
      .success,
    true,
  );
});

test("every verdict is also a campaign status, so nothing has to be translated", () => {
  for (const v of ["approved", "rejected", "needs_human"] as const) {
    assert.equal(CampaignStatus.safeParse(v).success, true, v);
  }
});

// --- the human gate, against a stub database ---------------------------------

type Row = Record<string, unknown>;

/** Enough drizzle to run decide(): the campaigns row, the rules, and the writes. */
function fakeDb(initial: CampaignState, rules: Row[]) {
  let current = initial;
  const commits: CampaignState[] = [];
  const events: Row[] = [];

  const query = (rows: unknown[]) => {
    const self = {
      where: () => self,
      limit: () => Promise.resolve(rows),
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return self;
  };

  const db = {
    select: () => ({
      from: (table: unknown) =>
        query(table === brand_rules ? rules : [{ id: current.campaign_id, state: current }]),
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => {
        if (table === campaigns) {
          current = v.state as CampaignState;
          commits.push(current);
        } else {
          events.push(v);
        }
        return {
          onConflictDoUpdate: async () => undefined,
          then: (resolve: (v: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      },
    }),
  } as unknown as typeof Db;

  return { db, commits, events };
}

/** One canned completion, whatever is asked. */
function stubGate(violations: { rule_id: string; detail: string }[]) {
  const real = globalThis.fetch;
  process.env.LLM_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify({ violations }) } }],
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const RULES = [{ id: "r1", rule: "never name a rival", severity: "block" as const }];

/** Parked at the gate with one variant the gate did not clear. */
const blockedState = () =>
  CampaignState.parse({
    campaign_id: "33333333-3333-4333-8333-333333333333",
    status: "awaiting_approval",
    signals: [
      {
        id: "sig-1",
        claim: "they want on-feet footage",
        summary: "s",
        sentiment: "mixed",
        evidence_ids: ["c1"],
        volume: 1,
        platforms: ["tiktok"],
        confidence: "high",
      },
    ],
    variants: [
      {
        id: "v1",
        platform: "tiktok",
        treatment: "demo",
        hooks: ["lace up", "day one"],
        body: "walk to the corner and back",
      },
    ],
    approvals: [
      { variant_id: "v1", verdict: "needs_human", violations: [{ rule_id: "r1", detail: "warned" }] },
    ],
  });

test("approving what the gate blocked needs a reason, and is stored as an override", async () => {
  const bare = fakeDb(blockedState(), RULES);
  await assert.rejects(
    decide(bare.db, blockedState().campaign_id, {
      action: "approve",
      variant_id: "v1",
      reviewed_by: "ana@example.com",
    }),
    (err: unknown) => err instanceof PipelineError && err.status === 400,
  );
  assert.equal(bare.commits.length, 0, "nothing is persisted when the override is refused");

  // With a reason, the same call is recorded as an override of the gate's
  // verdict — not as a plain approve. Routed through `edit` so the run stops at
  // the re-gate instead of going on to Distribution.
  const restore = stubGate([{ rule_id: "r1", detail: "names a rival" }]);
  const { db, commits } = fakeDb(blockedState(), RULES);
  try {
    const state = await decide(db, blockedState().campaign_id, {
      action: "edit",
      variant_id: "v1",
      reviewed_by: "ana@example.com",
      reason: "the rule does not apply to this shot",
      edits: { body: "walk to the corner, then film the crease" },
    });
    const human = state.approvals.filter((a) => a.reviewer === "human");
    assert.equal(human.length, 1);
    assert.equal(human[0]?.overrode, "needs_human");
    assert.equal(human[0]?.reason, "the rule does not apply to this shot");
    assert.equal(commits.length, 1);
  } finally {
    restore();
  }
});

test("an edit is re-gated, and a blocked rewrite is not persisted as approved", async () => {
  const restore = stubGate([{ rule_id: "r1", detail: "names a rival" }]);
  const { db } = fakeDb(blockedState(), RULES);
  try {
    const state = await decide(db, blockedState().campaign_id, {
      action: "edit",
      variant_id: "v1",
      reviewed_by: "ana@example.com",
      reason: "tighter",
      edits: { body: "cut to the wear test" },
    });

    // The edited copy is what was judged, the new verdict is stored next to the
    // human's yes, and the campaign ends at the gate's word rather than shipping.
    assert.equal(state.variants[0]?.body, "cut to the wear test");
    assert.equal(state.status, "rejected");
    assert.equal(state.schedule.length, 0);
    const agentVerdicts = state.approvals.filter((a) => a.reviewer === "agent");
    assert.equal(agentVerdicts.length, 2);
    assert.equal(agentVerdicts[1]?.verdict, "rejected");
  } finally {
    restore();
  }
});
