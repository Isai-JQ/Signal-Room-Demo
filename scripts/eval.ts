// `pnpm eval` — N pipeline runs against the active provider, aggregated from
// agent_events by provider and model.
//
// One provider per invocation, deliberately: change LLM_PROVIDER and run it
// again. Firing three providers at once is how you spend an org's whole TPM
// budget on a measurement, and the numbers are compared across runs anyway.
//
// Run: node --import tsx scripts/eval.ts [--runs 3] [--delay 60] [--json]
import { parseArgs } from "node:util";

/** Nearest-rank percentile. Null for an empty sample rather than a made-up 0. */
function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

const tally = (xs: string[]) =>
  xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

async function main() {
  // Same as lib/embed.ts: outside Next, nothing loads .env.local for us.
  process.loadEnvFile?.(".env.local");

  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "3" },
      delay: { type: "string", default: "60" },
      json: { type: "boolean", default: false },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer`);
  const delayMs = Number(values.delay) * 1000;
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`--delay must be seconds >= 0`);

  const { db } = await import("../lib/db");
  const { create, start, resume } = await import("../lib/pipeline");
  const { agent_events } = await import("../lib/schema");
  const { llmProvider } = await import("../lib/llm/provider");
  const { inArray } = await import("drizzle-orm");

  const provider = llmProvider();
  const p = (s = "") => process.stdout.write(`${s}\n`);
  const log = (s: string) => values.json || p(s);

  log(`provider: ${provider}   runs: ${runs}   delay: ${delayMs / 1000}s`);
  log("── runs ────────────────────────────────────────────");

  // Sequential on purpose: LLM_CONCURRENCY caps the fan-out inside one run, and
  // overlapping runs on top of it is how an eval trips the rate limit it is
  // meant to be measuring.
  const campaign_ids: string[] = [];
  const outcomes: string[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    // Created up front so the row carries is_eval before any agent runs — a
    // campaign that appears in the list for 40s and then vanishes is worse than
    // one that never appears. The id is also in hand if the run throws, which is
    // exactly the run worth measuring.
    const { campaign_id } = await create(db, { is_eval: true });
    let outcome: string;
    try {
      let state = await start(db, { campaign_id });
      if (state.status === "awaiting_approval") {
        // No human in a script: the eval measures the agents, not the gate.
        state = await resume(db, campaign_id);
      }
      outcome = state.status;
    } catch (err) {
      outcome = `threw: ${err}`;
    }
    campaign_ids.push(campaign_id);
    outcomes.push(outcome.startsWith("threw:") ? "threw" : outcome);
    log(`${String(i + 1).padStart(2)}/${runs}  ${String(Date.now() - t0).padStart(6)}ms  ${outcome}`);

    // Free-tier TPM is 8,000/min for the whole org and one run spends most of
    // it, so back-to-back runs pay for the last one's tokens in retries: 11
    // transport retries and a dead run over three, measured. The default is a
    // full window because a partial one measurably is not enough — 20s still
    // lost a run to 429.
    // ponytail: a fixed sleep, not a token-budget tracker. It cannot know what
    // the last run actually spent, so it waits for the worst case. Read
    // `x-ratelimit-reset` off the response instead if the waiting gets annoying;
    // `--delay 0` on a paid tier.
    if (delayMs > 0 && i < runs - 1) {
      log(`        waiting ${delayMs / 1000}s for the TPM window`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Scoped to the campaigns this invocation created. Every pipeline run mints a
  // campaign_id and every agent_events row hangs off it, so there is nothing
  // here with a null campaign_id to aggregate — see the note in the README.
  const rows = campaign_ids.length
    ? await db.select().from(agent_events).where(inArray(agent_events.campaign_id, campaign_ids))
    : [];

  const byModel = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.provider}/${row.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), row]);
  }

  const models = [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, events]) => {
      // schema_honored is a three-state column and the null is not a zero: the
      // provider never produced an output to judge. It is reported beside the
      // rate, never inside it.
      const judged = events.filter((e) => e.schema_honored !== null);
      const honored = judged.filter((e) => e.schema_honored === true).length;
      const tokens = events.map((e) => e.tokens).filter((t): t is number => t !== null);
      const latencies = events.map((e) => e.latency_ms);
      return {
        provider: events[0]!.provider,
        model: events[0]!.model,
        events: events.length,
        schema_honored: {
          honored,
          judged: judged.length,
          rate: judged.length ? honored / judged.length : null,
          unjudged: events.length - judged.length,
        },
        error_codes: tally(events.map((e) => e.error_code).filter((c): c is string => c !== null)),
        transport_attempts: events.reduce((s, e) => s + e.transport_attempts, 0),
        repair_attempts: events.reduce((s, e) => s + e.repair_attempts, 0),
        tokens: { p50: pct(tokens, 0.5), p95: pct(tokens, 0.95), unreported: events.length - tokens.length },
        latency_ms: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95) },
      };
    });

  if (values.json) {
    p(
      JSON.stringify(
        { provider, runs, delay_s: delayMs / 1000, outcomes: tally(outcomes), campaign_ids, models },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  p();
  p(`outcomes: ${Object.entries(tally(outcomes)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  p(`agent_events: ${rows.length} over ${campaign_ids.length} campaigns`);

  for (const m of models) {
    p();
    p(`── ${m.provider}/${m.model} ${"─".repeat(Math.max(0, 34 - m.model.length))}`);
    const rate = m.schema_honored.rate;
    p(
      `schema_honored:  ${m.schema_honored.honored}/${m.schema_honored.judged}` +
        `${rate === null ? "  (no judgeable runs)" : `  (${(rate * 100).toFixed(1)}%)`}`,
    );
    p(`  unjudged:      ${m.schema_honored.unjudged} (no output to judge — not counted above)`);
    p(`transport:       ${m.transport_attempts} extra calls (429/5xx)`);
    p(`repair:          ${m.repair_attempts} extra calls (schema round-trips)`);
    p(`tokens:          p50 ${m.tokens.p50 ?? "—"}  p95 ${m.tokens.p95 ?? "—"}${m.tokens.unreported ? `  (${m.tokens.unreported} unreported)` : ""}`);
    p(`latency:         p50 ${m.latency_ms.p50 ?? "—"} ms  p95 ${m.latency_ms.p95 ?? "—"} ms`);
    const codes = Object.entries(m.error_codes).sort(([, a], [, b]) => b - a);
    p(`errors:          ${codes.length ? codes.map(([c, n]) => `${c} ${n}`).join(", ") : "none"}`);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
