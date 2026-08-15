// Pure view logic over CampaignState: the stream reducer and the verdict→variant
// lookup. No DB, no network, no React — a client component imports this, so it
// must never reach lib/llm (provider keys) or lib/pipeline (which does).
import type { Approval, CampaignState, CampaignStatus, StreamEvent, Variant } from "./schemas";

/** What the page shows: the campaign as of the last frame, plus how it got there. */
export type Live = {
  status: CampaignStatus;
  campaign: CampaignState;
  error: string | null;
  /** Statuses in arrival order, deduped — the timeline. */
  history: CampaignStatus[];
};

/**
 * Nothing follows these, so a late frame after one of them is stale by definition.
 *
 * `rate_limited` is not here on purpose, for the same reason `awaiting_approval`
 * is not: both are rests the run resumes from, on the same feed. Closing the
 * stream on one would mean the frames the resume emits arrive at nobody.
 */
const TERMINAL = new Set<CampaignStatus>(["scheduled", "rejected", "needs_human", "failed"]);

/** The run is over: the client closes its EventSource instead of reconnecting forever. */
export const isTerminal = (status: CampaignStatus): boolean => TERMINAL.has(status);

/** Badge colours, here rather than in a component because both pages paint them. */
export const STATUS_TONE: Record<CampaignStatus, string> = {
  collecting: "bg-neutral-200 text-neutral-700",
  signals: "bg-sky-100 text-sky-800",
  brief: "bg-sky-100 text-sky-800",
  variants: "bg-sky-100 text-sky-800",
  approved: "bg-emerald-100 text-emerald-800",
  awaiting_approval: "bg-amber-100 text-amber-900",
  scheduled: "bg-emerald-600 text-white",
  rejected: "bg-rose-100 text-rose-800",
  needs_human: "bg-amber-300 text-amber-950",
  // Amber, not red: the free tier ran out of tokens for a minute. Painting it
  // like `failed` is what made a capacity limit read as a crash.
  rate_limited: "bg-amber-100 text-amber-900",
  // Not a verdict and not a queue: the run threw. Grey rather than red, because
  // a red badge next to needs_human is what made the two look interchangeable.
  failed: "bg-neutral-800 text-white",
};

export const liveFrom = (campaign: CampaignState): Live => ({
  status: campaign.status,
  campaign,
  error: campaign.error,
  history: [campaign.status],
});

/**
 * Replace, don't merge: every frame carries the whole state, so applying one
 * twice is applying it once. Two frames are dropped instead — another campaign's
 * (a stale EventSource from the previous page) and anything arriving after a
 * terminal status, which can only be a replay.
 */
export function applyEvent(live: Live, event: StreamEvent): Live {
  if (event.state.campaign_id !== live.campaign.campaign_id) return live;
  if (TERMINAL.has(live.status) && event.status !== live.status) return live;

  const last = live.history[live.history.length - 1];
  return {
    status: event.status,
    campaign: event.state,
    error: event.error ?? event.state.error,
    history: event.status === last ? live.history : [...live.history, event.status],
  };
}

/**
 * The gate's last word on one variant. Last, not first: `edit` re-runs the gate
 * over the rewritten copy and appends the new verdict, and it is that one the
 * human is answering for. Null when the gate never judged this variant.
 */
export const lastGateVerdict = (approvals: Approval[], variant_id: string): Approval | null =>
  approvals.reduce<Approval | null>(
    (found, a) => (a.reviewer === "agent" && a.variant_id === variant_id ? a : found),
    null,
  );

/**
 * Every variant paired with its own verdict, keyed by variant id. Position is
 * not identity: the approvals array is append-only and re-gated edits land at
 * the end of it, so zipping the two lists by index shows the wrong violations
 * next to the copy someone is about to approve.
 */
export const gateVerdicts = (variants: Variant[], approvals: Approval[]): Map<string, Approval | null> =>
  new Map(variants.map((v) => [v.id, lastGateVerdict(approvals, v.id)]));

/** A verdict that isn't a clean pass: approving it is an override and needs a reason. */
export const isBlocked = (verdict: Approval | null): boolean => verdict?.verdict !== "approved";
