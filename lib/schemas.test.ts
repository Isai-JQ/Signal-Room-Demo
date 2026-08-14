import assert from "node:assert/strict";
import test from "node:test";
import { CampaignState } from "./schemas";

const minimal = {
  campaign_id: "00000000-0000-4000-8000-000000000000",
  status: "collecting",
  comments: [
    {
      id: "c1",
      platform: "tiktok",
      author: "someone",
      text: "the app still crashes on Android",
      posted_at: "2026-08-14T10:00:00.000Z",
    },
  ],
};

test("CampaignState fills its collections and survives a jsonb round-trip", () => {
  const state = CampaignState.parse(minimal);
  assert.deepEqual(state.signals, []);
  assert.equal(state.brief, null);

  // campaigns.state is jsonb: what goes in must come back out identical, which
  // only holds while every field stays JSON-primitive (ISO strings, no Date).
  const roundTripped = CampaignState.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(roundTripped, state);
});

test("CampaignState rejects a comment with an unknown platform", () => {
  const bad = { ...minimal, comments: [{ ...minimal.comments[0], platform: "myspace" }] };
  assert.equal(CampaignState.safeParse(bad).success, false);
});

test("vector columns take their width from EMBEDDING_DIM", async () => {
  // Set before the import: the column width is read once, at module load.
  process.env.EMBEDDING_DIM = "1024";
  const { brand_rules, comments } = await import("./schema");
  assert.equal(comments.embedding.getSQLType(), "vector(1024)");
  assert.equal(brand_rules.embedding.getSQLType(), "vector(1024)");
});
