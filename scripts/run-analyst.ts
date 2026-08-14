// Diagnostic, not product: one analyst run against the real DB, printed with the
// agent_events row behind it. The question it answers is whether the model
// honours the native json_schema before anything gets built on top of Signal.
//
// Run: node --import tsx scripts/run-analyst.ts
import { desc, eq } from "drizzle-orm";

async function main() {
  // Same as lib/embed.ts: outside Next, nothing loads .env.local for us.
  process.loadEnvFile?.(".env.local");
  const { db } = await import("../lib/db");
  const { analyze } = await import("../lib/agents/analyst");
  const { agent_events } = await import("../lib/schema");

  const started = Date.now();
  let signal: Awaited<ReturnType<typeof analyze>> | null = null;
  let failure: unknown = null;
  try {
    signal = await analyze(db);
  } catch (err) {
    failure = err;
  }
  const wall_ms = Date.now() - started;

  // analyze() returns the filtered Signal only; the raw model output and the
  // run counters live on the row runAgent just wrote.
  const [event] = await db
    .select()
    .from(agent_events)
    .where(eq(agent_events.agent, "analyst"))
    .orderBy(desc(agent_events.ts))
    .limit(1);

  const p = (s: string) => process.stdout.write(`${s}\n`);

  if (signal) {
    p("── signal ──────────────────────────────────────────");
    p(`id:           ${signal.id}`);
    p(`claim:        ${signal.claim}`);
    p(`summary:      ${signal.summary}`);
    p(`sentiment:    ${signal.sentiment}`);
    p(`confidence:   ${signal.confidence}`);
    p(`volume:       ${signal.volume} comments`);
    p(`platforms:    ${signal.platforms.join(", ")}`);
    p(`evidence_ids: ${signal.evidence_ids.join("\n              ")}`);
  } else {
    p("── signal ──────────────────────────────────────────");
    p(`FAILED: ${failure}`);
  }

  p("── evidence filter ─────────────────────────────────");
  const cited: string[] = [
    ...new Set((event?.output as { evidence_ids?: string[] } | null)?.evidence_ids ?? []),
  ];
  const kept = signal?.evidence_ids.length ?? 0;
  p(`cited by model: ${cited.length} (unique)`);
  p(`kept:           ${kept}`);
  p(`discarded:      ${cited.length - kept} (ids the model was never sent)`);

  p("── run ─────────────────────────────────────────────");
  p(`provider/model:     ${event?.provider}/${event?.model}`);
  p(`structured_mode:    ${event?.structured_mode}`);
  p(`schema_honored:     ${event?.schema_honored}`);
  p(`transport_attempts: ${event?.transport_attempts}`);
  p(`repair_attempts:    ${event?.repair_attempts}`);
  p(`latency (llm):      ${event?.latency_ms} ms`);
  p(`latency (total):    ${wall_ms} ms`);

  process.exit(failure ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
