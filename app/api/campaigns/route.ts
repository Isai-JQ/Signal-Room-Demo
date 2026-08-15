// POST /api/campaigns — kick off a run.
//
// The row is created before the response so the id handed back is already
// resolvable; the agents run after it, under `after()`, because the pipeline
// takes far longer than any client should hold a request open. The client
// watches the rest on /api/campaigns/[id]/stream.
import { after } from "next/server";
import { db } from "@/lib/db";
import { create, start } from "@/lib/pipeline";
import { Platform } from "@/lib/schemas";

// pg and node:crypto: never the edge runtime, and never a client bundle. Provider
// keys are read in lib/llm/* which only this side of the tree imports.
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => ({}));
  const platform = Platform.optional().safeParse(
    (body as { platform?: unknown } | null)?.platform,
  );
  if (!platform.success) {
    return Response.json({ error: "platform must be one of " + Platform.options }, { status: 400 });
  }

  const { campaign_id } = await create(db);
  // Already committed as needs_human by start(); rethrowing here would only be an
  // unhandled rejection, and the transition is on its way out over the stream.
  after(start(db, { campaign_id, platform: platform.data }).catch(() => {}));

  return Response.json({ campaign_id, status: "collecting" }, { status: 202 });
}
