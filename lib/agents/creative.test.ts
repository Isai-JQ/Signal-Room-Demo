import assert from "node:assert/strict";
import test from "node:test";
import type { db as Db } from "../db";
import type { Brief, Variant } from "../schemas";
import { draft, gate } from "./creative";

function fakeDb(rows: unknown[]) {
  const events: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: async () => rows }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        events.push(v);
      },
    }),
  } as unknown as typeof Db;
  return { db, events };
}

/** One canned completion per call, in order — the agents fan out with Promise.all. */
function stubFetch(bodies: string[]) {
  const real = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const i = prompts.push(String(init.body)) - 1;
    return Response.json({ choices: [{ message: { content: bodies[i] } }] });
  }) as unknown as typeof fetch;
  return {
    prompts,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const brief: Brief = {
  headline: "On feet, on the street",
  audience: "Sneaker buyers who distrust unboxings",
  angle: "Show the shoe being worn, not displayed",
  format: "TikTok, 30-45s, vertical",
  key_messages: ["A wear test is coming"],
  signal_ids: ["sig-1"],
  brand_rules_applied: ["r2"],
};

test("three treatments, three drafts, ids and platform set here", async () => {
  process.env.LLM_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  const { prompts, restore } = stubFetch(
    [0, 1, 2].map((i) =>
      JSON.stringify({
        body: `draft ${i}`,
        hooks: ["lace up", "day one"],
        hashtags: ["onfeet"],
        id: "model-picked",
        platform: "x",
        treatment: "story",
      }),
    ),
  );
  const { db, events } = fakeDb([]);
  try {
    const variants = await draft(db, { brief, platform: "tiktok" });
    assert.equal(variants.length, 3);
    assert.equal(new Set(variants.map((v) => v.id)).size, 3, "ids are minted here");
    assert.ok(!variants.some((v) => v.id === "model-picked"), "never the model's id");
    assert.ok(variants.every((v) => v.platform === "tiktok"), "never the model's platform");
    assert.deepEqual(
      variants.map((v) => v.treatment),
      ["demo", "story", "proof"],
      "the treatment is the fan-out's, not the model's",
    );
    assert.equal(
      new Set(prompts).size,
      3,
      "three distinct treatment instructions, not the same prompt three times",
    );
    assert.equal(events.length, 3, "one agent_event per draft");
    assert.deepEqual(
      events.map((e) => e.task),
      ["drafting", "drafting", "drafting"],
    );
  } finally {
    restore();
  }
});

const rules = [
  { id: "r1", rule: "Never promise a date for a follow-up video.", severity: "warn" },
  { id: "r2", rule: "No claims about fit or comfort until someone has worn them.", severity: "block" },
];

const variant = (id: string): Variant => ({
  id,
  platform: "tiktok",
  treatment: "demo",
  hooks: ["first line", "other first line"],
  body: `post ${id}`,
  hashtags: [],
});

test("block rejects, warn goes to the human gate, invented ids count for nothing", async () => {
  process.env.LLM_PROVIDER = "groq";
  const { restore } = stubFetch([
    JSON.stringify({ violations: [{ rule_id: "r2", detail: "claims they run true to size" }] }),
    JSON.stringify({ violations: [{ rule_id: "r1", detail: "promises the wear test for Friday" }] }),
    JSON.stringify({ violations: [{ rule_id: "r404", detail: "broke a rule it made up" }] }),
  ]);
  const { db, events } = fakeDb(rules);
  try {
    const approvals = await gate(db, [variant("v1"), variant("v2"), variant("v3")]);
    assert.deepEqual(
      approvals.map((a) => a.verdict),
      ["rejected", "needs_human", "approved"],
    );
    assert.deepEqual(approvals[2]?.violations, [], "a rule that does not exist was not broken");
    assert.ok(
      approvals.every((a) => a.reviewer === "agent"),
      "the human gate is a different reviewer",
    );
    assert.equal(events.length, 3, "one agent_event per checked variant");
    assert.equal(events[0]?.agent, "guardian");
  } finally {
    restore();
  }
});
