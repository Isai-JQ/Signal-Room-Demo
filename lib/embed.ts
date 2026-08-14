// Backfills the pgvector columns. Separate from `pnpm seed` on purpose: seeding
// is offline and instant, embedding hits a provider and is the slow, flaky half.
//
// Idempotent by construction — it only ever selects rows WHERE embedding IS NULL,
// so a second run finds nothing and a crash halfway just resumes.
import { eq, isNull } from "drizzle-orm";
import { embed } from "./llm/provider";
import { brand_rules, comments } from "./schema";
import type { db as Db } from "./db";

const BATCH = 32;

const chunk = <T,>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Batches run in parallel: `embed()` already goes through withLimit, so
 * LLM_CONCURRENCY is what actually caps the fan-out. Each batch persists as it
 * lands, so a failure leaves the finished ones done and the rest still NULL.
 */
async function fill(
  rows: { id: string; text: string }[],
  save: (id: string, vector: number[]) => Promise<unknown>,
) {
  await Promise.all(
    chunk(rows, BATCH).map(async (batch) => {
      const vectors = await embed(batch.map((r) => r.text));
      // ponytail: one UPDATE per row. 400 round-trips is fine for a demo corpus;
      // switch to a single UPDATE ... FROM (VALUES ...) if the seed grows.
      await Promise.all(batch.map((r, i) => save(r.id, vectors[i]!)));
    }),
  );
  return rows.length;
}

export async function embedMissing(db: typeof Db) {
  const pendingComments = await db
    .select({ id: comments.id, text: comments.text })
    .from(comments)
    .where(isNull(comments.embedding));
  const pendingRules = await db
    .select({ id: brand_rules.id, text: brand_rules.rule })
    .from(brand_rules)
    .where(isNull(brand_rules.embedding));

  return {
    comments: await fill(pendingComments, (id, embedding) =>
      db.update(comments).set({ embedding }).where(eq(comments.id, id)),
    ),
    brand_rules: await fill(pendingRules, (id, embedding) =>
      db.update(brand_rules).set({ embedding }).where(eq(brand_rules.id, id)),
    ),
  };
}

async function main() {
  // Same as drizzle.config.ts: this runs outside Next, nothing loads .env.local for us.
  process.loadEnvFile?.(".env.local");
  const { db } = await import("./db");
  const done = await embedMissing(db);
  process.stdout.write(
    `embedded ${done.comments} comments, ${done.brand_rules} brand rules\n`,
  );
  process.exit(0);
}

if (process.argv[1]?.endsWith("/embed.ts")) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}
