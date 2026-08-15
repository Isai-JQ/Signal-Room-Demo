import assert from "node:assert/strict";
import test from "node:test";
import type { db as Db } from "./db";
import { decide, PipelineError, shippableVariantIds, start, worstVerdict } from "./pipeline";
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

// --- resuming a rate-limited run ---------------------------------------------

/**
 * Parked at `rate_limited` with the brief already done — the shape of the run
 * that used to be lost. The variants are missing because that is where it died.
 */
const rateLimitedState = () =>
  CampaignState.parse({
    campaign_id: "44444444-4444-4444-8444-444444444444",
    status: "rate_limited",
    error: "Rate limit reached on groq's free tier (8000 tokens/min, 7481 used).",
    signals: blockedState().signals,
    brief: {
      headline: "put them on",
      audience: "sneaker buyers who want fit, not packaging",
      angle: "wear the shoe on camera",
      format: "TikTok, 30-45s, vertical",
      key_messages: ["show the crease"],
      signal_ids: ["sig-1"],
    },
  });

/** One canned body that satisfies both a draft and a gate call — Zod strips the rest. */
function stubDraftAndGate() {
  const real = globalThis.fetch;
  process.env.LLM_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              hooks: ["lace up", "day one"],
              body: "walk to the corner and back",
              hashtags: [],
              violations: [],
            }),
          },
        },
      ],
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

test("a resumed run picks up at the drafts and never re-pays for the brief", async () => {
  const restore = stubDraftAndGate();
  const { db, events } = fakeDb(rateLimitedState(), RULES);
  try {
    const state = await start(db, { campaign_id: rateLimitedState().campaign_id });

    // The proof that the analyst and the brief were skipped is that the run
    // finished at all: neither one can reach a comments table or an embedding
    // endpoint through this stub, so running either would have thrown.
    // Sorted: both halves fan out, so which of the three lands first is theirs
    // to decide. What matters is which agents ran at all, and which did not.
    assert.deepEqual(
      events.map((e) => e.agent).sort(),
      ["creative:demo", "creative:proof", "creative:story", "guardian", "guardian", "guardian"],
      "only the stages with nothing on the state should have run",
    );
    // Promise.all keeps its input order, so a variant still matches its treatment.
    assert.deepEqual(
      state.variants.map((v) => v.treatment),
      ["demo", "story", "proof"],
    );
    assert.equal(state.brief?.headline, "put them on", "the brief that survived is the one reused");
    assert.equal(state.status, "awaiting_approval");
  } finally {
    restore();
  }
});
