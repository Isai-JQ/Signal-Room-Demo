import assert from "node:assert/strict";
import test from "node:test";
import type { db as Db } from "../db";
import { analyze, densestCluster, type Embedded } from "./analyst";

const okBody = (content: string) => Response.json({ choices: [{ message: { content } }] });

function stubFetch(impl: () => Promise<Response>) {
  const real = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Drizzle's builders are thenable, so awaiting the chain is all analyst needs. */
function fakeDb(rows: unknown[]) {
  const events: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        events.push(v);
      },
    }),
  } as unknown as typeof Db;
  return { db, events };
}

/**
 * `axis(0)` is a unit vector; `axis(0, [2, 0.35])` leans it 0.35 towards axis 2.
 * Each lean gets its own axis so members of a group are near the anchor without
 * being near-copies of each other — the whole point of the density score.
 */
const DIMS = 12;
const axis = (i: number, ...lean: [number, number][]) =>
  Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : (lean.find(([d]) => d === k)?.[1] ?? 0)));

// Two directions far apart, plus differently-worded members of each. Group A is
// bigger, so group A wins regardless of which comment the scan seeds from.
const corpus: Embedded[] = [
  { id: "b1", text: "shipping took forever", platform: "x", embedding: axis(1) },
  { id: "a1", text: "on-feet pics?", platform: "tiktok", embedding: axis(0) },
  {
    id: "b2",
    text: "still waiting on my order",
    platform: "x",
    embedding: axis(1, [2, 0.35]),
  },
  {
    id: "a2",
    text: "show them in the street",
    platform: "instagram",
    embedding: axis(0, [3, 0.35]),
  },
  { id: "a3", text: "lace em up already", platform: "tiktok", embedding: axis(0, [4, 0.4]) },
  {
    id: "a4",
    text: "wear test or it didn't happen",
    platform: "youtube",
    embedding: axis(0, [5, 0.45]),
  },
];

test("densest cluster wins, and comes back closest-first", () => {
  const picked = densestCluster(corpus, 0.9, 3);
  assert.deepEqual(
    picked.map((c) => c.id),
    ["a1", "a2", "a3"],
    "biggest neighbourhood, most similar members first",
  );
});

test("eleven near-duplicates lose to eight distinct wordings", () => {
  // Same sentence, eleven times, with the punctuation moved around.
  const copies: Embedded[] = Array.from({ length: 11 }, (_, i) => ({
    id: `dup-${i}`,
    text: "part 2 when",
    platform: "tiktok" as const,
    embedding: axis(0, [1, i * 0.002]),
  }));
  // Eight ways of asking for the same thing: each near the anchor, none a copy.
  const distinct: Embedded[] = Array.from({ length: 8 }, (_, i) => ({
    id: `alt-${i}`,
    text: `wording ${i}`,
    platform: "x" as const,
    embedding: i === 0 ? axis(2) : axis(2, [3 + i, 0.4]),
  }));

  assert.equal(
    densestCluster([...copies, ...distinct], 0.9, 30, 1).length,
    11,
    "without the dampener the eleven copies are simply the bigger neighbourhood",
  );
  const picked = densestCluster([...copies, ...distinct], 0.9, 30);
  assert.deepEqual(
    picked.map((c) => c.id).sort(),
    distinct.map((c) => c.id).sort(),
    "eight distinct wordings outweigh eleven copies of one",
  );
});

test("invented evidence ids are dropped and confidence falls to low", async () => {
  process.env.LLM_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  const restore = stubFetch(async () =>
    okBody(
      JSON.stringify({
        claim: "on-feet footage",
        summary: "The audience wants the shoes worn, not boxed.",
        sentiment: "mixed",
        // a1 and a2 were sent; the other two the model reached for on its own.
        evidence_ids: ["a1", "a2", "a2", "c9-not-real", "b1"],
        confidence: "high",
        // volume and platforms aren't in the model's schema; if it sends them
        // anyway they must not survive into the Signal.
        volume: 99,
        platforms: ["youtube"],
      }),
    ),
  );
  const { db, events } = fakeDb(corpus);
  try {
    const signal = await analyze(db, { threshold: 0.9, take: 3 });
    // b1 exists in the corpus but was never in the cluster the model was sent.
    assert.deepEqual(signal.evidence_ids, ["a1", "a2"]);
    assert.equal(signal.volume, 2, "counted here, not taken from the model");
    assert.deepEqual(signal.platforms, ["instagram", "tiktok"]);
    assert.equal(signal.confidence, "low", "partly invented evidence is not confident evidence");
    assert.ok(signal.id.length > 0, "the id is minted here, never by the model");
    assert.equal(events.length, 1, "claude.md: every run writes exactly one agent_event");
    assert.equal(events[0]?.agent, "analyst");
    assert.equal(events[0]?.task, "reasoning");
    assert.equal(events[0]?.schema_honored, true);
  } finally {
    restore();
  }
});

test("all-invented evidence is a hard failure, not a low-confidence signal", async () => {
  process.env.LLM_PROVIDER = "groq";
  const restore = stubFetch(async () =>
    okBody(
      JSON.stringify({
        claim: "on-feet footage",
        summary: "The audience wants the shoes worn.",
        sentiment: "mixed",
        evidence_ids: ["nope-1", "nope-2"],
        confidence: "high",
      }),
    ),
  );
  const { db } = fakeDb(corpus);
  try {
    await assert.rejects(analyze(db, { threshold: 0.9, take: 3 }), /none of them real/);
  } finally {
    restore();
  }
});
