"use client";

// The only interactive part of the page: the SSE subscription and the approval
// controls. It starts from the state the Server Component read out of the
// database and applies transitions on top of it, so the first paint is the
// campaign as it actually is, not a spinner waiting for a frame.
//
// Everything it imports is pure (`lib/live`) or a schema (`lib/schemas`). Nothing
// under `lib/llm` is reachable from here, which is the point: provider keys live
// on the server and a client bundle never gets a chance to carry one.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  applyEvent,
  gateVerdicts,
  isBlocked,
  isTerminal,
  liveFrom,
  STATUS_TONE,
} from "@/lib/live";
import {
  CampaignStatus,
  StreamEvent,
  type Approval,
  type CampaignState,
  type Variant,
} from "@/lib/schemas";

type Action = "approve" | "edit" | "reject";

/** A frame that is not a StreamEvent is dropped, not applied. */
const parseFrame = (data: string): StreamEvent | null => {
  try {
    const parsed = StreamEvent.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // not JSON at all — a truncated frame, or a proxy's idea of help
  }
};

const linesOf = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** Only the fields the human actually changed; null when they changed nothing. */
function editsFrom(variant: Variant, hooksText: string, body: string) {
  const hooks = linesOf(hooksText);
  const edits: Partial<Pick<Variant, "hooks" | "body">> = {};
  if (body.trim() && body.trim() !== variant.body) edits.body = body.trim();
  if (hooks.length > 0 && hooks.join("\n") !== variant.hooks.join("\n")) edits.hooks = hooks;
  return Object.keys(edits).length > 0 ? edits : null;
}

export function Live({ initial }: { initial: CampaignState }) {
  const router = useRouter();
  const campaign_id = initial.campaign_id;
  const [live, setLive] = useState(() => liveFrom(initial));
  const [connected, setConnected] = useState(false);

  const [picked, setPicked] = useState<string | null>(null);
  const [reviewedBy, setReviewedBy] = useState("");
  const [reason, setReason] = useState("");
  const [hooksText, setHooksText] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    // The browser reconnects on its own and resends the last `id:` it saw as
    // Last-Event-ID; the route reads that as the cursor and skips what was
    // already delivered. Closing on a terminal status is ours to do — a stream
    // the server ended on purpose would otherwise be reopened forever.
    const es = new EventSource(`/api/campaigns/${campaign_id}/stream`);
    const onFrame = (event: Event) => {
      const frame = parseFrame((event as MessageEvent<string>).data);
      if (!frame) return;
      setLive((current) => applyEvent(current, frame));
      // The trace is server-rendered from agent_events, so it needs the round trip.
      router.refresh();
      if (isTerminal(frame.status)) es.close();
    };
    // Frames are named after the status, so there is no "message" to listen for.
    for (const status of CampaignStatus.options) es.addEventListener(status, onFrame);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [campaign_id, router]);

  const { campaign, status, history, error } = live;
  const verdicts = gateVerdicts(campaign.variants, campaign.approvals);
  const humanCalls = campaign.approvals.filter((a) => a.reviewer === "human");
  const target = campaign.variants.find((v) => v.id === picked) ?? null;
  const targetBlocked = target ? isBlocked(verdicts.get(target.id) ?? null) : false;

  const pick = (variant: Variant) => {
    setPicked(variant.id);
    setHooksText(variant.hooks.join("\n"));
    setBodyText(variant.body);
    setFailure(null);
  };

  async function submit(action: Action) {
    if (!target) return setFailure("pick a variant first");
    const edits = action === "edit" ? editsFrom(target, hooksText, bodyText) : undefined;
    if (action === "edit" && !edits) return setFailure("edit needs at least one changed field");
    // The same rule the server enforces, said earlier: a yes to a variant the
    // gate blocked is an override, and an override has to be explained.
    if (!reason.trim() && (action !== "approve" || targetBlocked)) {
      return setFailure(
        action === "approve"
          ? "the gate blocked this variant — approving it is an override, so say why"
          : `reason is required to ${action}`,
      );
    }

    setBusy(true);
    setFailure(null);
    const res = await fetch(`/api/campaigns/${campaign_id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        variant_id: target.id,
        reviewed_by: reviewedBy.trim(),
        reason: reason.trim() || undefined,
        edits,
      }),
    });
    setBusy(false);
    // On success there is nothing to do: the decision's transitions arrive on
    // the stream like every other one.
    if (!res.ok) setFailure(await res.text());
  }

  return (
    <section>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {history.map((s, i) => (
          <span key={`${s}-${i}`} className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[s]}`}>
            {s}
          </span>
        ))}
        <span className="ml-auto text-xs text-neutral-500">
          {isTerminal(status) ? "stream closed" : connected ? "live" : "reconnecting…"}
        </span>
      </div>

      {error && (
        <p className="mt-4 rounded bg-rose-50 p-3 font-mono text-xs text-rose-800">{error}</p>
      )}

      {campaign.signals[0] && (
        <p className="mt-6 text-sm text-neutral-600">
          <span className="font-medium text-neutral-900">{campaign.signals[0].claim}</span>{" "}
          — {campaign.signals[0].volume} comments, {campaign.signals[0].sentiment},{" "}
          {campaign.signals[0].confidence} confidence
        </p>
      )}

      {campaign.brief && (
        <div className="mt-4 rounded border border-neutral-200 p-4">
          <h2 className="font-semibold">{campaign.brief.headline}</h2>
          <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-neutral-500">audience</dt>
            <dd>{campaign.brief.audience}</dd>
            <dt className="text-neutral-500">angle</dt>
            <dd>{campaign.brief.angle}</dd>
            <dt className="text-neutral-500">format</dt>
            <dd>{campaign.brief.format}</dd>
            <dt className="text-neutral-500">on camera</dt>
            <dd>
              <ul className="list-disc pl-4">
                {campaign.brief.key_messages.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </dd>
          </dl>
        </div>
      )}

      {campaign.variants.length > 0 && (
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {campaign.variants.map((variant) => (
            <VariantCard
              key={variant.id}
              variant={variant}
              verdict={verdicts.get(variant.id) ?? null}
              humanCalls={humanCalls.filter((a) => a.variant_id === variant.id)}
              picked={picked === variant.id}
              selectable={status === "awaiting_approval"}
              onPick={() => pick(variant)}
            />
          ))}
        </div>
      )}

      {status === "awaiting_approval" && (
        <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">Your call</h2>
          <p className="mt-1 text-sm text-neutral-700">
            {target ? (
              <>
                Deciding on the <strong>{target.treatment}</strong> variant.
                {targetBlocked && " The gate blocked it: approving is an override and needs a reason."}
              </>
            ) : (
              "Pick a variant above."
            )}
          </p>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="text-neutral-600">Who you are</span>
              <input
                value={reviewedBy}
                onChange={(e) => setReviewedBy(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1"
              />
            </label>
            <label className="text-sm">
              <span className="text-neutral-600">Reason</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="required to edit, reject, or override the gate"
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1"
              />
            </label>
          </div>

          {target && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="text-sm">
                <span className="text-neutral-600">Hooks, one per line</span>
                <textarea
                  value={hooksText}
                  onChange={(e) => setHooksText(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs"
                />
              </label>
              <label className="text-sm">
                <span className="text-neutral-600">Body</span>
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs"
                />
              </label>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => submit("approve")}
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {targetBlocked ? "Override and approve" : "Approve"}
            </button>
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => submit("edit")}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Edit and approve
            </button>
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => submit("reject")}
              className="rounded bg-rose-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Reject
            </button>
            <span className="self-center text-xs text-neutral-500">
              An edit is re-checked by the gate before anything is scheduled.
            </span>
          </div>

          {failure && (
            <p className="mt-3 font-mono text-xs text-rose-800" role="alert">
              {failure}
            </p>
          )}
        </div>
      )}

      {campaign.schedule.length > 0 && (
        <div className="mt-6 rounded border border-emerald-300 bg-emerald-50 p-4 text-sm">
          <h2 className="font-semibold">Scheduled</h2>
          {campaign.schedule.map((s) => (
            <p key={s.variant_id} className="mt-1">
              {s.publish_at} ({s.timezone}) — {s.rationale}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

const VERDICT_TONE: Record<Approval["verdict"], string> = {
  approved: "bg-emerald-100 text-emerald-800",
  needs_human: "bg-amber-200 text-amber-900",
  rejected: "bg-rose-100 text-rose-800",
};

function VariantCard({
  variant,
  verdict,
  humanCalls,
  picked,
  selectable,
  onPick,
}: {
  variant: Variant;
  /** The gate's verdict for THIS variant, looked up by id. Never a neighbour's. */
  verdict: Approval | null;
  humanCalls: Approval[];
  picked: boolean;
  selectable: boolean;
  onPick: () => void;
}) {
  return (
    <article
      className={`rounded border p-3 text-sm ${picked ? "border-neutral-900 ring-1 ring-neutral-900" : "border-neutral-200"}`}
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-neutral-900 px-2 py-0.5 text-xs font-medium text-white">
          {variant.treatment}
        </span>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${verdict ? VERDICT_TONE[verdict.verdict] : "bg-neutral-200 text-neutral-600"}`}
        >
          gate: {verdict?.verdict ?? "not judged"}
        </span>
        {selectable && (
          <button
            type="button"
            onClick={onPick}
            className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100"
          >
            {picked ? "picked" : "pick"}
          </button>
        )}
      </div>

      <ul className="mt-3 list-disc pl-4 text-neutral-900">
        {variant.hooks.map((hook) => (
          <li key={hook}>{hook}</li>
        ))}
      </ul>
      <p className="mt-2 text-neutral-600">{variant.body}</p>
      {variant.hashtags.length > 0 && (
        <p className="mt-2 text-xs text-neutral-500">{variant.hashtags.join(" ")}</p>
      )}

      {verdict && verdict.violations.length > 0 && (
        <ul className="mt-3 space-y-1 rounded bg-rose-50 p-2 text-xs text-rose-800">
          {verdict.violations.map((v) => (
            <li key={v.rule_id}>{v.detail}</li>
          ))}
        </ul>
      )}

      {humanCalls.map((call, i) => (
        // An override is painted as one: a human approve over a gate block is
        // not the same record as a plain approve, and it does not look like one.
        <p
          key={`${call.variant_id}-${i}`}
          className={`mt-2 rounded p-2 text-xs ${call.overrode ? "bg-amber-200 text-amber-900" : "bg-neutral-100 text-neutral-700"}`}
        >
          <strong>
            {call.overrode ? `override of ${call.overrode}` : call.verdict} by {call.reviewed_by}
          </strong>
          {call.reason ? ` — ${call.reason}` : null}
        </p>
      ))}
    </article>
  );
}
