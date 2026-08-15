// The campaign list, and the button that starts one. Server Component: it reads
// the table directly. Fetching one of this app's own routes to render its own
// page would be a second HTTP hop for data already a query away.
import { desc } from "drizzle-orm";
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

export default async function Home() {
  const rows = await db
    .select({
      id: campaigns.id,
      status: campaigns.status,
      created_at: campaigns.created_at,
      state: campaigns.state,
    })
    .from(campaigns)
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
              <span className="truncate text-sm text-neutral-600">
                {row.state.brief?.headline ?? row.state.signals[0]?.claim ?? "—"}
              </span>
              <time className="ml-auto shrink-0 text-xs text-neutral-500">
                {row.created_at.toISOString().replace("T", " ").slice(0, 16)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="mt-8 text-sm text-neutral-500">No campaigns yet.</p>}
    </main>
  );
}
