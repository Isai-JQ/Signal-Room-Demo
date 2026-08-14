// The whole cycle against the real DB, one line per transition — including the
// human approval, which is auto-granted here because there is no human in a
// script. Anything the pipeline would pause on, this prints and walks through.
//
// Run: node --import tsx scripts/run-pipeline.ts
async function main() {
  // Same as lib/embed.ts: outside Next, nothing loads .env.local for us.
  process.loadEnvFile?.(".env.local");
  const { db } = await import("../lib/db");
  const { start, resume } = await import("../lib/pipeline");
  const { count, eq } = await import("drizzle-orm");
  const { agent_events } = await import("../lib/schema");

  const p = (s: string) => process.stdout.write(`${s}\n`);
  const t0 = Date.now();
  const onTransition = ({ status, error }: { status: string; error?: string }) => {
    p(`${String(Date.now() - t0).padStart(6)}ms  ${status}${error ? `  ${error}` : ""}`);
  };

  p("── transitions ─────────────────────────────────────");
  let state = await start(db, { onTransition });

  if (state.status === "awaiting_approval") {
    p("          [human approves]");
    state = await resume(db, state.campaign_id, { onTransition });
  }

  p("── campaign ────────────────────────────────────────");
  p(`campaign_id: ${state.campaign_id}`);
  p(`status:      ${state.status}`);
  p(`signal:      ${state.signals[0]?.claim ?? "—"}`);
  p(`brief:       ${state.brief?.headline ?? "—"}`);
  p(`variants:    ${state.variants.length}`);
  p(
    `verdicts:    ${state.approvals.map((a) => a.verdict).join(", ") || "—"}` +
      (state.approvals.some((a) => a.violations.length)
        ? `\n             ${state.approvals.flatMap((a) => a.violations.map((v) => `${v.rule_id}: ${v.detail}`)).join("\n             ")}`
        : ""),
  );
  for (const s of state.schedule) p(`schedule:    ${s.publish_at} (${s.timezone})`);
  if (state.schedule[0]) p(`rationale:   ${state.schedule[0].rationale}`);
  if (state.error) p(`error:       ${state.error}`);

  // The campaign_id claim from claude.md, checked rather than asserted in prose.
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(agent_events)
    .where(eq(agent_events.campaign_id, state.campaign_id));
  p(`agent_events on this campaign: ${n}`);

  process.exit(state.status === "scheduled" ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
