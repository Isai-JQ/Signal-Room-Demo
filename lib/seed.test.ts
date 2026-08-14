import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BRAND_RULES, TOPICS, generateComments } from "./seed";

const digest = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Pinned so drift is caught across processes too, not just within one run.
// Changing the corpus on purpose means updating this line in the same commit.
const EXPECTED = "47d844be81a4f3339b72a5d6c04774a780f3e0510b128ca8bfdb5b070ee1e478";

test("the seed corpus is identical on every run", () => {
  const rows = generateComments();
  assert.equal(rows.length, 400);
  assert.deepEqual(generateComments(), rows);
  assert.equal(digest(rows), EXPECTED);
  assert.equal(new Set(rows.map((c) => c.id)).size, rows.length, "ids collided");
});

// The demo only means something if grouping these needs embeddings. A topic
// written as 16 rephrasings of one sentence would pass keyword matching too —
// so require most in-topic pairs to share literally no word.
test("each topic says one thing in many vocabularies", () => {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9']+/g));
  for (const [topic, lines] of Object.entries(TOPICS)) {
    assert.ok(lines.length >= 15 && lines.length <= 20, `${topic}: ${lines.length} lines`);
    assert.equal(new Set(lines).size, lines.length, `${topic} repeats a line`);
    const pairs = lines.flatMap((a, i) => lines.slice(i + 1).map((b) => [words(a), words(b)] as const));
    const disjoint = pairs.filter(([a, b]) => ![...a].some((w) => b.has(w))).length;
    assert.ok(disjoint / pairs.length > 0.7, `${topic}: only ${disjoint}/${pairs.length} pairs are word-disjoint`);
  }
});

test("the brand rules are 12 distinct non-empty rules", () => {
  assert.equal(BRAND_RULES.length, 12);
  assert.equal(new Set(BRAND_RULES.map((r) => r.rule)).size, 12);
  assert.ok(BRAND_RULES.every((r) => r.rule.length > 20));
});
