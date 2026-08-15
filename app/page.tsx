// The campaign list, and the button that starts one. Server Component: it reads
// the table directly. Fetching one of this app's own routes to render its own
// page would be a second HTTP hop for data already a query away.
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { db } from "@/lib/db";
import { STATUS_TONE } from "@/lib/live";
import { create, start } from "@/lib/pipeline";
import { campaigns } from "@/lib/schema";

export const dynamic = "force-dynamic";

/**
 * Same two calls as POST /api/campaigns — create the row, run the agents after
 * the response — as a Server Action, so the button needs no client bundle. The
 * route stays for curl and for anything that is not this page; a form posting to
 * a JSON route handler would just navigate the browser to JSON.
 */
async function startCampaign() {
  "use server";
  const { campaign_id } = await create(db);
  after(start(db, { campaign_id }).catch(() => {}));
  redirect(`/campaigns/${campaign_id}`);
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ eval?: string }>;
}) {
  // `pnpm eval` drives the same pipeline, so its campaigns are indistinguishable
  // on this screen — dozens of them, burying the ones someone started by hand.
  // Hidden by default, `?eval=1` to see them.
  const showEval = (await searchParams).eval === "1";
  const rows = await db
    .select({
      id: campaigns.id,
      status: campaigns.status,
      created_at: campaigns.created_at,
      state: campaigns.state,
      is_eval: campaigns.is_eval,
    })
    .from(campaigns)
    .where(showEval ? undefined : eq(campaigns.is_eval, false))
    .orderBy(desc(campaigns.created_at))
    .limit(50);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Signal Room</h1>
        <form action={startCampaign}>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            New campaign
          </button>
        </form>
      </div>

      <ul className="mt-8 divide-y divide-neutral-200 border-y border-neutral-200">
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/campaigns/${row.id}`} className="flex items-center gap-4 py-3 hover:bg-neutral-50">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[row.status]}`}>
                {row.status}
              </span>
              {row.is_eval && (
                <span className="shrink-0 rounded border border-neutral-300 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                  eval
                </span>
              )}
              {/* A failed run has no headline worth showing, and showing the
                  next best thing would read like progress. It gets what threw. */}
              {row.status === "failed" ? (
                <span className="truncate font-mono text-xs text-neutral-500">
                  {row.state.error ?? "the run threw"}
                </span>
              ) : (
                <span className="truncate text-sm text-neutral-600">
                  {row.state.brief?.headline ?? row.state.signals[0]?.claim ?? "—"}
                </span>
              )}
              <time className="ml-auto shrink-0 text-xs text-neutral-500">
                {row.created_at.toISOString().replace("T", " ").slice(0, 16)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="mt-8 text-sm text-neutral-500">No campaigns yet.</p>}
      <Link
        href={showEval ? "/" : "/?eval=1"}
        className="mt-4 inline-block text-xs text-neutral-500 hover:underline"
      >
        {showEval ? "hide eval runs" : "show eval runs"}
      </Link>
    </main>
  );
}
