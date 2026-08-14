// Analyst: finds the theme the audience is actually converging on and returns it
// as a Signal. The clustering happens here, in code — the model only ever sees
// the representatives of one cluster, never the whole corpus.
import { randomUUID } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import type { db as Db } from "../db";
import { comments } from "../schema";
import { Signal, type Platform } from "../schemas";
import { ANALYST_SYSTEM, analystPrompt } from "./prompts/analyst";
import { runAgent } from "./run";

/**
 * What the model is actually asked for. The id is ours to mint and volume and
 * platforms are counted from the surviving evidence, so it never sees those
 * fields — a model that can't be trusted with ids can't be trusted to tally them.
 */
const AnalystSignal = Signal.omit({ id: true, volume: true, platforms: true });

/** Cosine cut-off for "same theme". Tune it against the corpus, not in theory. */
const envThreshold = () => Number(process.env.ANALYST_SIMILARITY_THRESHOLD ?? 0.75);
const REPRESENTATIVES = 30;

export type Embedded = { id: string; text: string; platform: Platform; embedding: number[] };

const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
};

/**
 * Densest neighbourhood rather than full agglomerative clustering: for every
 * comment, count how many others sit within `threshold` cosine similarity, keep
 * the biggest neighbourhood, and return its closest `take` members.
 *
 * ponytail: O(n²) over the corpus — 400 comments is a fraction of a second and
 * the seed is fixed. Push it into pgvector (`<=>` plus a lateral join) if the
 * corpus ever stops fitting in memory.
 */
export function densestCluster(rows: Embedded[], threshold: number, take: number): Embedded[] {
  const units = rows.map((r) => unit(r.embedding));
  let best: { at: number; sim: number }[] = [];
  for (const a of units) {
    const near: { at: number; sim: number }[] = [];
    for (let j = 0; j < units.length; j++) {
      const b = units[j]!;
      let sim = 0;
      for (let k = 0; k < a.length; k++) sim += a[k]! * b[k]!;
      if (sim >= threshold) near.push({ at: j, sim });
    }
    if (near.length > best.length) best = near;
  }
  return best
    .sort((x, y) => y.sim - x.sim)
    .slice(0, take)
    .map((m) => rows[m.at]!);
}

export async function analyze(
  db: typeof Db,
  {
    campaign_id = null,
    threshold = envThreshold(),
    take = REPRESENTATIVES,
  }: { campaign_id?: string | null; threshold?: number; take?: number } = {},
): Promise<Signal> {
  const rows = (await db
    .select({
      id: comments.id,
      text: comments.text,
      platform: comments.platform,
      embedding: comments.embedding,
    })
    .from(comments)
    .where(isNotNull(comments.embedding))) as Embedded[];
  if (rows.length === 0) throw new Error("no embedded comments — run `pnpm embed` first");

  const cluster = densestCluster(rows, threshold, take);

  const out = await runAgent({
    db,
    agent: "analyst",
    task: "reasoning",
    campaign_id,
    system: ANALYST_SYSTEM,
    prompt: analystPrompt(cluster),
    schema: AnalystSignal,
  });

  // The prompt asks for real ids; that is a request, not a guarantee. Anything
  // the model was never sent gets dropped, and a signal resting partly on
  // invented evidence does not get to call itself confident.
  const cited = new Set(out.evidence_ids);
  const evidence = cluster.filter((c) => cited.has(c.id));
  const invented = cited.size - evidence.length;
  if (evidence.length === 0) {
    throw new Error(`analyst cited ${cited.size} evidence ids, none of them real`);
  }

  // volume and platforms are counted here, off the comments that survived, so the
  // Signal is complete before the Brief agent ever sees it.
  return Signal.parse({
    ...out,
    id: randomUUID(),
    evidence_ids: evidence.map((c) => c.id),
    volume: evidence.length,
    platforms: [...new Set(evidence.map((c) => c.platform))].sort(),
    confidence: invented > 0 ? "low" : out.confidence,
  });
}
