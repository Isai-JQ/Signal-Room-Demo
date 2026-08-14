import assert from "node:assert/strict";
import test from "node:test";
import type { db as Db } from "../db";
import type { Signal } from "../schemas";
import { buildBrief } from "./brief";

/** select().from().where().orderBy().limit() — thenable at every step, like drizzle. */
type Chain = {
  from: () => Chain;
  where: () => Chain;
  orderBy: () => Chain;
  limit: () => Chain;
  then: (resolve: (rows: unknown[]) => void) => void;
};

function fakeDb(rows: unknown[]) {
  const events: Record<string, unknown>[] = [];
  const chain: Chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve) => resolve(rows),
  };
  const db = {
    select: () => chain,
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        events.push(v);
      },
    }),
  } as unknown as typeof Db;
  return { db, events };
}

/** Embeddings and completions both go through fetch; the URL says which. */
function stubFetch(completion: string) {
  const real = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes("/embeddings")) {
      return Response.json({ data: [{ index: 0, embedding: Array(768).fill(0.1) }] });
    }
    prompts.push(String(init.body));
    return Response.json({ choices: [{ message: { content: completion } }] });
  }) as unknown as typeof fetch;
  return {
    prompts,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const signal: Signal = {
  id: "sig-1",
  claim: "The audience wants the shoes worn, not boxed.",
  summary: "Repeated requests for on-feet footage instead of packaging shots.",
  sentiment: "mixed",
  evidence_ids: ["comment-a1-raw", "comment-a2-raw"],
  volume: 2,
  platforms: ["instagram", "tiktok"],
  confidence: "high",
};

const rules = [
  { id: "r1", rule: "Never promise a date for a follow-up video.", severity: "warn" },
  { id: "r2", rule: "No claims about fit or comfort until someone has worn them.", severity: "block" },
];

const draft = {
  headline: "On feet, on the street",
  audience: "Sneaker buyers who distrust unboxings",
  angle: "Show the shoe being worn, not displayed",
  format: "TikTok, 30-45s, vertical",
  key_messages: ["Wear test coming from the creator", "No packaging talk"],
  brand_rules_applied: ["r2", "r9-not-real"],
  // signal_ids is not in the model's schema; if it sends one it must not survive.
  signal_ids: ["made-up"],
};

test("the model sees the signal and the rules, never the comments", async () => {
  process.env.LLM_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  process.env.EMBEDDING_PROVIDER = "ollama";
  process.env.EMBEDDING_DIM = "768";
  const { prompts, restore } = stubFetch(JSON.stringify(draft));
  const { db, events } = fakeDb(rules);
  try {
    const brief = await buildBrief(db, signal);
    const sent = prompts.join("\n");
    assert.ok(sent.includes(signal.claim), "the signal is the evidence the brief works from");
    assert.ok(sent.includes("r1: Never promise"), "the retrieved rules go in");
    assert.ok(!sent.includes("evidence_ids"), "raw comment ids stay out");
    assert.ok(!sent.includes("comment-a1-raw"), "and so do the comment ids behind them");

    assert.deepEqual(brief.brand_rules_applied, ["r2"], "r9 was never sent, so it was never applied");
    assert.deepEqual(brief.signal_ids, ["sig-1"], "filled here, not by the model");
    assert.equal(events.length, 1, "claude.md: every run writes exactly one agent_event");
    assert.equal(events[0]?.agent, "brief");
    assert.equal(events[0]?.task, "reasoning");
  } finally {
    restore();
  }
});

test("all-invented rule ids are a hard failure, not an empty list", async () => {
  process.env.LLM_PROVIDER = "groq";
  const { restore } = stubFetch(
    JSON.stringify({ ...draft, brand_rules_applied: ["nope-1", "nope-2"] }),
  );
  const { db } = fakeDb(rules);
  try {
    await assert.rejects(buildBrief(db, signal), /none of them real/);
  } finally {
    restore();
  }
});
