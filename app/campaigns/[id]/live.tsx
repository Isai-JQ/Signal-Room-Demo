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
import { applyEvent, gateVerdicts, isBlocked, isTerminal, liveFrom } from "@/lib/live";
import {
  CampaignStatus,
  StreamEvent,
  type Approval,
  type CampaignState,
  type Variant,
} from "@/lib/schemas";
import { Badge, SectionRule, STATUS_TONE, VERDICT_TONE } from "../../ui";

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

// One section = one rhythm. `SECTION` is the only vertical gap between blocks on
// this page; the trace sets its own, wider, because it is read for a different
// reason. Anything smaller is spacing inside a block, never between two.
const SECTION = "mt-16";
const FIELD =
  "mt-2 w-full border border-line bg-bg px-2.5 py-2 text-data text-bone placeholder:text-muted focus:border-bone focus:outline-none";
const BUTTON = "label border px-3 py-2 disabled:opacity-40";

export function Live({
  initial,
  onResume,
}: {
  initial: CampaignState;
  /** Server Action. Only reachable from `rate_limited`, where a resume is cheap. */
  onResume: (campaign_id: string) => Promise<void>;
}) {
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
      // A frame is the server answering: whatever the page was waiting on landed.
      setBusy(false);
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
  const signal = campaign.signals[0];

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
          ? "guardian blocked this variant — approving it is an override, so say why"
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
    if (!res.ok) {
      // The route answers `{ error }`. A 400 puts a Zod tree there rather than a
      // sentence, which is worth saying plainly instead of rendering as JSON.
      const body: unknown = await res.json().catch(() => null);
      const message = (body as { error?: unknown } | null)?.error;
      setFailure(typeof message === "string" ? message : "the decision was rejected — check the fields");
    }
  }

  return (
    <section>
      {/* The tape: every status this run has been through, in arrival order.
          Order carries the information — where it stalled, and what it came from. */}
      <div className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-2">
        {history.map((s, i) => (
          <span key={`${s}-${i}`} className="flex items-center gap-2">
            {i > 0 && <span className="label text-line">→</span>}
            <Badge tone={STATUS_TONE[s]}>{s}</Badge>
          </span>
        ))}
        <span className="label ml-auto text-muted">
          {isTerminal(status) ? "stream closed" : connected ? "● live" : "reconnecting…"}
        </span>
      </div>

      {/* A rate limit is prose in amber, not a red monospace dump: the run is
          intact, the free tier is not. The provider's full response stays in the
          trace row below, which is where someone debugging goes anyway. */}
      {error &&
        (status === "rate_limited" ? (
          <div className="mt-6 flex flex-wrap items-center gap-4 border border-warn/40 border-l-2 border-l-warn bg-surface px-4 py-3">
            <p className="font-sans text-body text-bone">{error}</p>
            <button
              type="button"
              disabled={busy}
              // Stays disabled until a frame comes back, not until the action
              // returns: the action only queues the run, so re-enabling on its
              // promise is an invitation to start a second one.
              onClick={() => {
                setBusy(true);
                void onResume(campaign_id);
              }}
              className={`${BUTTON} ml-auto shrink-0 border-warn/60 text-warn hover:bg-warn/10`}
            >
              {/* Named after what survived, because that is the whole point:
                  the run picks up at the first stage with nothing on the state. */}
              {campaign.variants.length > 0
                ? "resume from the drafts"
                : campaign.brief
                  ? "resume from the brief"
                  : "resume"}
            </button>
          </div>
        ) : (
          <p className="mt-6 border border-alarm/40 border-l-2 border-l-alarm bg-surface px-4 py-3 text-data text-alarm">
            {error}
          </p>
        ))}

      {/* The thesis. One sentence at the top of the screen, the largest thing on
          it, and the only reason any of the rest of this page exists. */}
      {signal && (
        <div className={SECTION}>
          <SectionRule label="signal" agent="analyst" />
          <div className="mt-6 grid gap-8 md:grid-cols-[1fr_auto]">
            <div>
              <p className="max-w-2xl font-sans text-claim text-bone">{signal.claim}</p>
              <p className="mt-4 max-w-prose font-sans text-body text-muted">{signal.summary}</p>
            </div>
            <dl className="grid h-fit grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-l border-line pl-5 md:min-w-44">
              <Field label="comments">{signal.volume}</Field>
              <Field label="sentiment">{signal.sentiment}</Field>
              <Field label="confidence">{signal.confidence}</Field>
            </dl>
          </div>
        </div>
      )}

      {campaign.brief && (
        <div className={SECTION}>
          <SectionRule label="brief" agent="brief" />
          <h3 className="mt-6 max-w-2xl font-sans text-lede text-bone">{campaign.brief.headline}</h3>
          <dl className="mt-6 grid grid-cols-[6rem_1fr] gap-x-6 gap-y-3 md:grid-cols-[9rem_1fr]">
            <Field label="audience" sans>
              {campaign.brief.audience}
            </Field>
            <Field label="angle" sans>
              {campaign.brief.angle}
            </Field>
            <Field label="format">{campaign.brief.format}</Field>
            <Field label="on camera" sans>
              <ul className="space-y-1.5">
                {campaign.brief.key_messages.map((m) => (
                  <li key={m} className="before:mr-2 before:text-muted before:content-['—']">
                    {m}
                  </li>
                ))}
              </ul>
            </Field>
            {campaign.brief.brand_rules_applied.length > 0 && (
              <Field label="rules">{campaign.brief.brand_rules_applied.join("  ")}</Field>
            )}
          </dl>
        </div>
      )}

      {campaign.variants.length > 0 && (
        <div className={SECTION}>
          <SectionRule
            label="variants"
            agent="creative"
            aside={status === "awaiting_approval" ? "pick one to decide on" : undefined}
          />
          <div className="mt-6 grid gap-px bg-line md:grid-cols-3">
            {campaign.variants.map((variant) => (
              <VariantColumn
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
        </div>
      )}

      {/* An interrupt, not another block: it is the only thing on the page with a
          surface under it, because it is the only thing asking for something. */}
      {status === "awaiting_approval" && (
        <div className={`${SECTION} border border-warn/30 border-l-2 border-l-warn bg-surface p-6`}>
          <SectionRule label="your call" agent="human" tone="text-warn" />
          <p className="mt-5 max-w-prose font-sans text-body text-bone">
            {target ? (
              <>
                Deciding on the <span className="label text-warn">{target.treatment}</span> variant.
                {targetBlocked && " Guardian blocked it: approving is an override and needs a reason."}
              </>
            ) : (
              "Pick a variant above to decide on it."
            )}
          </p>

          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <label className="block">
              <span className="label text-muted">who you are</span>
              <input
                value={reviewedBy}
                onChange={(e) => setReviewedBy(e.target.value)}
                placeholder="you@example.com"
                className={FIELD}
              />
            </label>
            <label className="block">
              <span className="label text-muted">reason</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="required to edit, reject, or override guardian"
                className={FIELD}
              />
            </label>
          </div>

          {target && (
            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <label className="block">
                <span className="label text-muted">hooks, one per line</span>
                <textarea
                  value={hooksText}
                  onChange={(e) => setHooksText(e.target.value)}
                  rows={4}
                  className={FIELD}
                />
              </label>
              <label className="block">
                <span className="label text-muted">body</span>
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  rows={4}
                  className={FIELD}
                />
              </label>
            </div>
          )}

          {/* Each button is coloured by the state it produces, not by rank. */}
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-5">
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => submit("approve")}
              className={`${BUTTON} ${
                targetBlocked
                  ? "border-warn/60 text-warn hover:bg-warn/10"
                  : "border-ok/50 text-ok hover:bg-ok/10"
              }`}
            >
              {targetBlocked ? "override and approve" : "approve"}
            </button>
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => submit("edit")}
              className={`${BUTTON} border-line text-bone hover:bg-line`}
            >
              edit and approve
            </button>
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => submit("reject")}
              className={`${BUTTON} border-alarm/50 text-alarm hover:bg-alarm/10`}
            >
              reject
            </button>
            <span className="ml-auto max-w-xs font-sans text-body text-muted">
              An edit goes back through guardian before anything is scheduled.
            </span>
          </div>
        </div>
      )}

      {/* Outside the panel above on purpose. The decision that loses the claim
          is answered while the winner's transitions are already arriving, and
          those move the campaign off `awaiting_approval` — which used to unmount
          this line before the person who lost had read it. */}
      {failure && (
        <p
          className="mt-6 border border-alarm/40 border-l-2 border-l-alarm bg-surface px-4 py-3 font-sans text-body text-alarm"
          role="alert"
        >
          {failure}
        </p>
      )}

      {campaign.schedule.length > 0 && (
        <div className={SECTION}>
          <SectionRule label="scheduled" agent="distribution" tone="text-ok" />
          {campaign.schedule.map((s) => (
            <div key={s.variant_id} className="mt-6 border-l-2 border-l-ok bg-surface px-4 py-3">
              <p className="text-data text-ok">
                {s.publish_at.replace("T", " ").slice(0, 16)}{" "}
                <span className="text-muted">{s.timezone}</span>
              </p>
              <p className="mt-1.5 max-w-prose font-sans text-body text-bone">{s.rationale}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** One row of a technical sheet: mono label left, value right. */
function Field({
  label,
  sans,
  children,
}: {
  label: string;
  sans?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="label pt-0.5 text-muted">{label}</dt>
      <dd className={sans ? "font-sans text-body text-bone" : "text-data text-bone"}>{children}</dd>
    </>
  );
}

function VariantColumn({
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
  // A block is structural, not a hover state: the column carries a coral edge
  // and the reasons are printed under it, where they can be read without a mouse.
  const blocked = verdict !== null && isBlocked(verdict);

  return (
    <article
      className={`flex flex-col gap-5 border-l-2 bg-bg p-5 ${
        blocked ? "border-l-alarm" : picked ? "border-l-bone" : "border-l-transparent"
      }`}
    >
      {/* `creative:demo` is verbatim the name in the trace table's agent column,
          so a column up here and a row down there are visibly the same call. */}
      <div className="flex items-baseline gap-2">
        <span className="label text-bone">creative:{variant.treatment}</span>
        <span className="label ml-auto text-muted">{variant.platform}</span>
        {selectable && (
          <button
            type="button"
            onClick={onPick}
            className={`label border px-2 py-0.5 ${
              picked ? "border-bone text-bone" : "border-line text-muted hover:text-bone"
            }`}
          >
            {picked ? "picked" : "pick"}
          </button>
        )}
      </div>

      <ul className="space-y-2.5 font-sans text-body leading-snug text-bone">
        {variant.hooks.map((hook) => (
          <li key={hook} className="border-l border-line pl-3">
            {hook}
          </li>
        ))}
      </ul>

      <p className="font-sans text-body text-muted">{variant.body}</p>

      {variant.hashtags.length > 0 && (
        <p className="text-data text-muted">{variant.hashtags.join(" ")}</p>
      )}

      <div className="mt-auto space-y-2.5 border-t border-line pt-4">
        <div className="flex items-center gap-2">
          <span className="label text-muted">guardian</span>
          <Badge tone={verdict ? VERDICT_TONE[verdict.verdict] : "border-line text-muted"}>
            {verdict?.verdict ?? "not judged"}
          </Badge>
        </div>

        {verdict && verdict.violations.length > 0 && (
          <ul className="space-y-1.5 text-data text-alarm">
            {verdict.violations.map((v) => (
              <li key={v.rule_id}>
                <span className="text-muted">{v.rule_id}</span> {v.detail}
              </li>
            ))}
          </ul>
        )}

        {humanCalls.map((call, i) => (
          // An override is painted as one: a human approve over a gate block is
          // not the same record as a plain approve, and it does not look like one.
          <p
            key={`${call.variant_id}-${i}`}
            className={`text-data ${call.overrode ? "text-warn" : "text-muted"}`}
          >
            <span className="label">
              {call.overrode ? `override of ${call.overrode}` : call.verdict}
            </span>{" "}
            by {call.reviewed_by}
            {call.reason ? ` — ${call.reason}` : null}
          </p>
        ))}
      </div>
    </article>
  );
}
