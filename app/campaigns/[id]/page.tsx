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
import { SectionRule } from "../../ui";
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

/**
 * Identity on the left, measurement on the right, and a rule between them: the
 * first seven columns say which call this was, the last four say what it cost.
 * Everything measured is right-aligned and tabular so a column of numbers can be
 * read down its last digit.
 */
const TRACE_COLUMNS = [
  { key: "ts", head: "px-3", cell: "px-3 text-muted" },
  { key: "agent", head: "px-3", cell: "px-3 text-bone" },
  { key: "task", head: "px-3", cell: "px-3 text-muted" },
  { key: "provider", head: "px-3", cell: "px-3 text-muted" },
  { key: "model", head: "px-3", cell: "px-3 text-bone" },
  { key: "mode", head: "px-3", cell: "px-3 text-muted" },
  { key: "honored", head: "px-3", cell: "px-3" },
  { key: "net", head: "num border-l border-line/70 px-3", cell: "num border-l border-line/70 px-3" },
  { key: "repair", head: "num px-3", cell: "num px-3" },
  { key: "tok", head: "num px-3", cell: "num px-3 text-muted" },
  { key: "ms", head: "num px-3", cell: "num px-3 text-bone" },
] as const;

/** Zero attempts is the quiet answer; anything above it is worth the eye. */
const attempts = (n: number) => (
  <span className={n === 0 ? "text-muted" : "text-bone"}>{n}</span>
);

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

  const failures = events.filter((e) => e.error).length;

  return (
    <main className="mx-auto max-w-6xl px-6 pb-32">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-bg">
        <Link href="/" className="label text-muted hover:text-bone">
          ← campaigns
        </Link>
        <span className="label text-line">/</span>
        <span className="truncate text-data text-bone">{id}</span>
        {row.is_eval && <span className="label ml-auto shrink-0 text-muted">eval run</span>}
      </header>

      <Live initial={CampaignState.parse(row.state)} onResume={resumeCampaign} />

      {/* The widest gap on the page, and the only doubled rule. Everything above
          is what the campaign is; everything below is what the machine did to
          get there, and the two are read for different reasons. */}
      <section className="mt-24 border-t-2 border-line pt-10">
        <SectionRule
          label="trace"
          agent="every call"
          aside={
            failures > 0
              ? `${events.length} calls · ${failures} failed`
              : `${events.length} ${events.length === 1 ? "call" : "calls"}`
          }
        />
        <p className="mt-4 max-w-prose font-sans text-body text-muted">
          Every agent run against this campaign in the order it happened, failed attempts included.
          A row with a coral edge came back wrong; the line under it is what came back.
        </p>

        {events.length === 0 ? (
          <p className="mt-8 text-data text-muted">
            No agent runs yet. The first row lands the moment the analyst answers.
          </p>
        ) : (
          <div className="mt-6">
            {/* No overflow wrapper on purpose. `overflow-x: auto` also computes
                overflow-y to auto, which makes the wrapper the scrollport for
                everything inside it — the sticky header would then pin to a div
                that never scrolls vertically and ride off the top with the page.
                The table fits inside max-w-6xl at this min-width, so on anything
                projector-sized nothing overflows; narrower than that, the page
                scrolls sideways and the header still pins correctly.

                `border-separate` for the same reason: a collapsed border belongs
                to the table, not the cell, so it stays behind when a sticky
                header moves and the column names end up sitting on the rows. */}
            <table className="w-full min-w-5xl border-separate border-spacing-0 whitespace-nowrap text-left text-data">
              <thead>
                <tr>
                  {TRACE_COLUMNS.map(({ key, head }) => (
                    <th
                      key={key}
                      // Sticks under the page header so the column names stay
                      // with the numbers on a trace long enough to scroll.
                      // Opaque surface, not the page ground: rows have to pass
                      // behind it, and `bg-surface` is the one band on the table
                      // that is never see-through.
                      className={`label sticky top-12 z-20 border-b border-line bg-surface pb-2 pt-2 text-muted ${head}`}
                    >
                      {key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const cells = [
                    e.ts.toISOString().slice(11, 19),
                    e.agent,
                    e.task,
                    e.provider,
                    e.model,
                    e.structured_mode,
                    // null is not a failure: nothing came back to judge. Painting
                    // it red would be the same conflation the column exists to undo.
                    <span
                      key="honored"
                      className={
                        e.schema_honored === null
                          ? "text-muted"
                          : e.schema_honored
                            ? "text-ok"
                            : "text-alarm"
                      }
                    >
                      {e.schema_honored === null ? "—" : String(e.schema_honored)}
                    </span>,
                    attempts(e.transport_attempts),
                    attempts(e.repair_attempts),
                    e.tokens ?? "—",
                    e.latency_ms,
                  ];
                  return (
                    <Fragment key={e.id}>
                      {/* Row rules live on the cells, not the row: with
                          `border-separate` a <tr> border never renders. */}
                      <tr className="even:bg-surface/40">
                        {TRACE_COLUMNS.map(({ key, cell }, i) => (
                          <td
                            key={key}
                            // The rail, not a red row: a failed attempt is
                            // findable from across the room without the whole
                            // line shouting over the ones that worked.
                            className={`border-b border-line/50 py-1.5 ${cell} ${
                              i === 0
                                ? e.error
                                  ? "border-l-2 border-l-alarm"
                                  : "border-l-2 border-l-transparent"
                                : ""
                            }`}
                          >
                            {cells[i]}
                          </td>
                        ))}
                      </tr>
                      {e.error && (
                        <tr>
                          <td className="border-b border-l-2 border-line/50 border-l-alarm" />
                          <td
                            colSpan={TRACE_COLUMNS.length - 1}
                            // Indented to start under `agent`, so the timestamp
                            // gutter runs unbroken down the whole table.
                            className="border-b border-line/50 px-3 pb-2 align-top whitespace-normal"
                          >
                            <span className="text-alarm">{e.error_code}</span>{" "}
                            <span className="text-muted">{e.error}</span>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
