// The campaign list, and the button that starts one. Server Component: it reads
// the table directly. Fetching one of this app's own routes to render its own
// page would be a second HTTP hop for data already a query away.
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { db } from "@/lib/db";
import { create, start } from "@/lib/pipeline";
import { campaigns } from "@/lib/schema";
import { Badge, STATUS_TONE } from "./ui";

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
    <main className="mx-auto max-w-6xl px-6 pb-24">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-bg">
        <h1 className="label text-bone">Signal Room</h1>
        <span className="label text-line">/</span>
        <span className="label text-muted">
          {rows.length} {rows.length === 1 ? "campaign" : "campaigns"}
        </span>
        <form action={startCampaign} className="ml-auto">
          <button
            type="submit"
            className="label border border-line px-3 py-1.5 text-bone hover:bg-line"
          >
            new campaign
          </button>
        </form>
      </header>

      {rows.length === 0 ? (
        <p className="mt-12 max-w-prose font-sans text-body text-muted">
          Nothing has run yet. Start a campaign and the analyst begins reading comments.
        </p>
      ) : (
        <ul className="mt-8">
          {rows.map((row) => (
            <li key={row.id} className="border-b border-line">
              <Link
                href={`/campaigns/${row.id}`}
                className="flex items-center gap-4 py-3 hover:bg-surface"
              >
                <span className="w-44 shrink-0">
                  <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                </span>
                {row.is_eval && <span className="label shrink-0 text-muted">eval</span>}
                {/* A failed run has no headline worth showing, and showing the
                    next best thing would read like progress. It gets what threw. */}
                {row.status === "failed" ? (
                  <span className="truncate text-data text-alarm">
                    {row.state.error ?? "the run threw"}
                  </span>
                ) : (
                  <span className="truncate font-sans text-body text-bone">
                    {row.state.brief?.headline ?? row.state.signals[0]?.claim ?? "—"}
                  </span>
                )}
                <time
                  dateTime={row.created_at.toISOString()}
                  className="ml-auto shrink-0 text-data text-muted"
                >
                  {row.created_at.toISOString().replace("T", " ").slice(0, 16)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={showEval ? "/" : "/?eval=1"}
        className="label mt-8 inline-block text-muted hover:text-bone"
      >
        {showEval ? "hide eval runs" : "show eval runs"}
      </Link>
    </main>
  );
}
