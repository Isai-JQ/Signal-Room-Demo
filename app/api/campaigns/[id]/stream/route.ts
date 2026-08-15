// GET /api/campaigns/[id]/stream — one SSE event per transition.
//
// The run belongs to another request, so this subscribes to the pipeline's feed
// rather than driving anything. The feed replays what already happened, so
// connecting late costs no events; if it is gone (server restarted, or the run
// finished long ago) the campaigns row still has the last state, which is sent
// as a single event instead.
import { db } from "@/lib/db";
import { load, PipelineError, subscribe, type Transition } from "@/lib/pipeline";
import type { CampaignStatus } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DONE = new Set<CampaignStatus>(["scheduled", "rejected", "needs_human"]);

/**
 * Where the client got to before the connection dropped, as an index into the
 * feed's log. `Last-Event-ID` is what a browser resends on its own reconnect;
 * `?cursor=` is the same number for anything that isn't an EventSource. -1 means
 * "from the beginning", which is also what a garbled value gets.
 */
const cursorOf = (req: Request) => {
  const raw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("cursor");
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) ? n : -1;
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cursor = cursorOf(req);
  // 404 while we still can: once the stream is open there is no status code left.
  // Only a missing row is a 404 — a database that is down has to stay a 500.
  const current = await load(db, id).catch((err: unknown) => {
    if (err instanceof PipelineError) return null;
    throw err;
  });
  if (!current) return Response.json({ error: `no campaign ${id}` }, { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true; // client vanished between cancel() and the next write
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        controller.close();
      };

      // The replay arrives in log order, so the callback's own count is the
      // index each frame is addressed by — and the one a reconnect sends back.
      let seq = -1;
      unsubscribe = subscribe(id, (t: Transition) => {
        seq++;
        // Already seen before the connection dropped. Terminal still closes:
        // there is nothing after it to keep the socket open for.
        if (seq <= cursor) return void (DONE.has(t.status) && close());
        write(`id: ${seq}\nevent: ${t.status}\ndata: ${JSON.stringify(t)}\n\n`);
        // awaiting_approval is a rest, not an end: the approve call resumes the
        // same feed, so the stream stays open through to `scheduled`.
        if (DONE.has(t.status)) close();
      });

      // Nothing in the feed at all: it outlived its log, or predates this
      // process. The row is the state of record, sent without an id so a client
      // that reconnects still asks from the cursor it actually reached.
      if (seq < 0) {
        const t: Transition = { status: current.status, state: current };
        write(`event: ${t.status}\ndata: ${JSON.stringify(t)}\n\n`);
        if (DONE.has(current.status)) return close();
      }

      // Comment frames only. Idle proxies drop a silent connection, and
      // awaiting_approval can idle for as long as the human takes.
      heartbeat = setInterval(() => write(": ping\n\n"), 15_000);
    },
    cancel() {
      unsubscribe();
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
