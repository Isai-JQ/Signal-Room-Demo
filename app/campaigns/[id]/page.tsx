// One campaign. Server Component: campaign, brief, variants and verdicts come
// out of the database in one place, and the trace comes out of agent_events.
// Nothing here fetches this app's own routes — the state is a query away, and a
// self-fetch would only add a hop and a way to render a page against a state the
// database never had.
//
// The live half is one Client Component, which is handed this state as its
// starting point and applies the stream's transitions on top of it.
import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { Fragment } from "react";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { claimRateLimited, start } from "@/lib/pipeline";
import { agent_events, campaigns } from "@/lib/schema";
import { CampaignState } from "@/lib/schemas";
import { Live } from "./live";

export const dynamic = "force-dynamic";

/**
 * Pick a rate-limited run back up. A Server Action rather than a route, like the
 * start button on the campaign list — the client already has an open stream, so
 * there is nothing to hand back: `start()` skips the stages that already have an
 * output and its transitions arrive on the same feed.
 */
async function resumeCampaign(campaign_id: string) {
  "use server";
  // A Server Action is reachable by anyone who can POST to it, and this one was
  // observed firing twice for a single click. `claimRateLimited` settles that in
  // the database rather than here: only the caller that wins the row starts a
  // pipeline, so a second call spends nothing.
  if (await claimRateLimited(db, campaign_id)) {
    after(start(db, { campaign_id }).catch(() => {}));
  }
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A non-uuid would reach Postgres as a cast error, i.e. a 500 for what is
  // plainly a 404.
  if (!z.string().uuid().safeParse(id).success) notFound();

  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!row) notFound();

  // Ordered by ts, and nothing filtered: a run that failed its schema twice is
  // the most interesting row on the page.
  const events = await db
    .select()
    .from(agent_events)
    .where(eq(agent_events.campaign_id, id))
    .orderBy(asc(agent_events.ts));

  return (
    <main className="mx-auto max-w-6xl p-8">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">
        ← campaigns
      </Link>
      <h1 className="mt-2 font-mono text-sm text-neutral-500">{id}</h1>

      <Live initial={CampaignState.parse(row.state)} onResume={resumeCampaign} />

      <h2 className="mt-10 text-lg font-semibold">Trace</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Every agent run against this campaign, failed attempts included.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-neutral-300 text-neutral-500">
            <tr>
              {["agent", "task", "provider", "model", "mode", "honored", "transport", "repair", "ms"].map(
                (h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {events.map((e) => (
              <Fragment key={e.id}>
                <tr className={e.error ? "bg-rose-50" : undefined}>
                  <td className="px-2 py-1.5 font-medium">{e.agent}</td>
                  <td className="px-2 py-1.5">{e.task}</td>
                  <td className="px-2 py-1.5">{e.provider}</td>
                  <td className="px-2 py-1.5 font-mono">{e.model}</td>
                  <td className="px-2 py-1.5">{e.structured_mode}</td>
                  {/* null is not a failure: nothing came back to judge. Painting
                      it red would be the same conflation the column exists to undo. */}
                  <td
                    className={`px-2 py-1.5 ${
                      e.schema_honored === null
                        ? "text-neutral-400"
                        : e.schema_honored
                          ? "text-emerald-700"
                          : "text-rose-700"
                    }`}
                  >
                    {e.schema_honored === null ? "—" : String(e.schema_honored)}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{e.transport_attempts}</td>
                  <td className="px-2 py-1.5 tabular-nums">{e.repair_attempts}</td>
                  <td className="px-2 py-1.5 tabular-nums">{e.latency_ms}</td>
                </tr>
                {e.error && (
                  <tr className="bg-rose-50">
                    <td colSpan={9} className="px-2 pb-2 font-mono text-rose-800">
                      <strong>{e.error_code}</strong> {e.error}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {events.length === 0 && <p className="mt-3 text-sm text-neutral-500">No agent runs yet.</p>}
    </main>
  );
}
