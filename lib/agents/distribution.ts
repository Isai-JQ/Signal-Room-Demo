// Distribution: when to publish, decided from when the cluster was talking.
//
// The split is the point of this agent. The hour is arithmetic over timestamps:
// bucket, count, take the max. A model asked to do the same thing reads the same
// numbers and answers from the shape of the prose around them — it will round
// 03:00 up to "the morning", prefer an hour that sounds like a marketing hour,
// and give a different answer to the same histogram twice. None of that is
// visible in the output, which is what makes it worse than a wrong number: it is
// a wrong number that reads correctly. Counting is also the one thing here that
// is free, deterministic and testable, so paying a model to do it badly buys
// nothing.
//
// What the model is actually good at is the sentence a human reads instead of
// the histogram, so that is all it writes. It gets the hour as a fact and is
// told to restate it — the justification can be wrong prose about a right hour,
// never the other way round.
import { inArray } from "drizzle-orm";
import { z } from "zod/v4";
import type { db as Db } from "../db";
import { comments } from "../schema";
import { Schedule, type Signal, type Variant } from "../schemas";
import { DISTRIBUTION_SYSTEM, distributionPrompt } from "./prompts/distribution";
import { runAgent } from "./run";

const RationaleCall = z.object({ rationale: z.string().min(1) });

export type Peak = { hour: number; count: number; total: number; histogram: number[] };

/**
 * Densest hour of the day across the cluster, UTC.
 *
 * ponytail: hour-of-day only — it folds every day of the corpus onto one 24-hour
 * clock, so a burst confined to one Tuesday looks like a daily habit. Enough for
 * a seed that spans days, not weeks. Bucket by weekday-hour if the corpus grows
 * a weekly rhythm worth respecting.
 */
export function peakHour(timestamps: string[]): Peak {
  const histogram = Array<number>(24).fill(0);
  for (const t of timestamps) {
    const hour = new Date(t).getUTCHours();
    if (!Number.isNaN(hour)) histogram[hour]!++;
  }
  const total = histogram.reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error("no usable timestamps in the cluster");
  // Ties go to the earlier hour: indexOf stops at the first max, which keeps the
  // choice stable across runs instead of depending on row order.
  const count = Math.max(...histogram);
  return { hour: histogram.indexOf(count), count, total, histogram };
}

/** Next time that hour comes round, strictly in the future. */
export function nextOccurrence(hour: number, now = new Date()): string {
  const at = new Date(now);
  at.setUTCHours(hour, 0, 0, 0);
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}

export async function scheduleVariants(
  db: typeof Db,
  signal: Signal,
  variants: Variant[],
  { campaign_id = null }: { campaign_id?: string | null } = {},
): Promise<Schedule[]> {
  if (variants.length === 0) throw new Error("nothing to schedule — no approved variants");

  // The Signal carries ids, not timestamps, so the cluster is re-read here. Only
  // the evidence that survived the analyst's id check counts.
  const rows = await db
    .select({ posted_at: comments.posted_at })
    .from(comments)
    .where(inArray(comments.id, signal.evidence_ids));
  if (rows.length === 0) throw new Error("no comments behind the signal's evidence ids");

  const peak = peakHour(rows.map((r) => r.posted_at.toISOString()));
  const publish_at = nextOccurrence(peak.hour);

  // One window, one call: the rationale explains the hour, and the hour is the
  // same for every variant of the campaign.
  const out = await runAgent({
    db,
    agent: "distribution",
    task: "drafting",
    campaign_id,
    system: DISTRIBUTION_SYSTEM,
    prompt: distributionPrompt(signal, peak, peak.histogram),
    schema: RationaleCall,
  });

  return variants.map((v) =>
    Schedule.parse({
      variant_id: v.id,
      publish_at,
      timezone: "UTC",
      rationale: out.rationale,
    }),
  );
}
