import assert from "node:assert/strict";
import test from "node:test";
import type { db as Db } from "./db";
import {
  claimRateLimited,
  decide,
  PipelineError,
  resume,
  shippableVariantIds,
  start,
  worstVerdict,
} from "./pipeline";
import { brand_rules, campaigns, comments } from "./schema";
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

/**
 * The literal values a drizzle WHERE compares against, dug out of its query
 * chunks. Both conditional updates in the pipeline are compare-and-swaps, and a
 * stub that ignored what they compare would pass whatever it was handed.
 */
function conditionValues(cond: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ("value" in node && !("queryChunks" in node)) {
      return void found.push((node as { value: unknown }).value);
    }
    for (const chunk of (node as { queryChunks?: unknown[] }).queryChunks ?? []) walk(chunk);
  };
  walk(cond);
  return found.filter((v) => !Array.isArray(v)); // drop the SQL text chunks
}

/** Enough drizzle to run decide(): the campaigns row, the rules, and the writes. */
function fakeDb(initial: CampaignState, rules: Row[]) {
  let current = initial;
  // The row's version, as far as `awaiting()`'s CAS is concerned.
  let updatedAt = new Date("2024-01-01T00:00:00.000Z");
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
        query(
          table === brand_rules
            ? rules
            : table === comments
              ? // The cluster behind the signal — Distribution re-reads it for
                // the peak hour, so `resume()` reaches past the claim.
                [{ posted_at: new Date("2024-01-01T09:00:00.000Z") }]
              : [{ id: current.campaign_id, state: current, updated_at: updatedAt }],
        ),
    }),
    // Both conditional updates are compare-and-swaps: `claimRateLimited` swaps on
    // the status, `awaiting()` on `updated_at`. The stub grants the update only
    // when what the WHERE compares still matches the row, which is the whole
    // property under test — a stub that always granted it would pass forever.
    update: () => ({
      set: (v: Row) => ({
        where: (cond: unknown) => ({
          returning: async () => {
            const stale = conditionValues(cond).some((want) =>
              want instanceof Date
                ? want.getTime() !== updatedAt.getTime()
                : typeof want === "string" &&
                  CampaignStatus.safeParse(want).success &&
                  want !== current.status,
            );
            if (stale) return [];
            if (v.status) current = { ...current, status: v.status as CampaignState["status"] };
            if (v.updated_at instanceof Date) updatedAt = v.updated_at;
            return [{ id: current.campaign_id }];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => {
        if (table === campaigns) {
          current = v.state as CampaignState;
          if (v.updated_at instanceof Date) updatedAt = v.updated_at;
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
      // `rationale` rides along so the same stub answers Distribution: both
      // schemas are plain z.object, so each strips the key it wasn't asked for.
      choices: [{ message: { content: JSON.stringify({ violations, rationale: "peak hour" }) } }],
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

test("two resumes race for one parked run, and only one of them spends anything", async () => {
  const { db, commits } = fakeDb(rateLimitedState(), RULES);
  const id = rateLimitedState().campaign_id;

  // What a double-submitted Server Action does: both callers see `rate_limited`,
  // because nothing moves until an agent commits and that is an LLM call away.
  const [first, second] = await Promise.all([claimRateLimited(db, id), claimRateLimited(db, id)]);
  assert.deepEqual([first, second].sort(), [false, true], "exactly one caller may start the run");
  assert.equal(commits.length, 1, "and the losing claim writes nothing");

  // The run this claim started is still going: a third click is not a resume.
  assert.equal(await claimRateLimited(db, id), false);

  // And a campaign that was never parked cannot be resumed into at all.
  const parked = fakeDb(blockedState(), RULES);
  assert.equal(await claimRateLimited(parked.db, blockedState().campaign_id), false);
  assert.equal(parked.commits.length, 0);
});

test("two decisions race for one campaign, and the loser is told which way it went", async () => {
  const { db, commits } = fakeDb(blockedState(), RULES);
  const id = blockedState().campaign_id;
  // `reject` on purpose: it reaches no model, so what this measures is the claim
  // and not a stubbed completion.
  const decision = {
    action: "reject",
    variant_id: "v1",
    reviewed_by: "ana@example.com",
    reason: "off-brand",
  } as const;

  const [first, second] = await Promise.allSettled([
    decide(db, id, decision),
    decide(db, id, decision),
  ]);

  const won = [first, second].filter((r) => r.status === "fulfilled");
  const lost = [first, second].filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one decision may be recorded");
  assert.equal(commits.length, 1, "and the loser writes nothing");

  // Distinguishable, not silent: a 409 that says another decision got there.
  const err = (lost[0] as PromiseRejectedResult).reason as unknown;
  assert.ok(err instanceof PipelineError);
  assert.equal(err.status, 409);
  assert.match(err.message, /another decision/);

  // The claim is not a lock the caller has to release: once the winner has
  // committed, the campaign is simply no longer awaiting_approval.
  await assert.rejects(
    decide(db, id, decision),
    (e: unknown) => e instanceof PipelineError && e.status === 409 && /not awaiting_approval/.test(e.message),
  );
});

test("resume races decide for the same claim, and whichever loses is told so", async () => {
  // The other caller of `awaiting()`. `resume()` is the scripted yes and
  // `decide()` the UI's, and they claim the same row through the same CAS —
  // a campaign cannot both ship the gate's picks and record a human's.
  const restore = stubGate([]);
  try {
    // Cleared by the gate, so `resume()` has something to ship if it wins — a
    // campaign with nothing shippable would fail past the claim for its own
    // reasons and say nothing about who got there first.
    const cleared = { ...blockedState(), approvals: [a("approved", "v1")] };
    const { db, commits } = fakeDb(cleared, RULES);
    const id = cleared.campaign_id;

    const [first, second] = await Promise.allSettled([
      resume(db, id),
      decide(db, id, {
        action: "reject",
        variant_id: "v1",
        reviewed_by: "ana@example.com",
        reason: "off-brand",
      }),
    ]);

    const won = [first, second].filter((r) => r.status === "fulfilled");
    const lost = [first, second].filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one caller may claim the campaign");
    assert.equal(commits.length, 1, "and the loser writes nothing");

    const err = (lost[0] as PromiseRejectedResult).reason as unknown;
    assert.ok(err instanceof PipelineError);
    assert.equal(err.status, 409);
    assert.match(err.message, /another decision/);
  } finally {
    restore();
  }
});
