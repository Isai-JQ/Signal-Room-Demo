// The pipeline: Analyst → Brief → Creative → gate → [pause] → Distribution.
//
// Two entry points because the pause is real. `start()` runs everything a
// machine is allowed to decide and stops; `decide()` is what a human approving
// the campaign triggers. Nothing schedules a post without that second call.
//
// Every transition is persisted before it is announced, so a crash between the
// two loses an event, never the state.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { analyze } from "./agents/analyst";
import { buildBrief } from "./agents/brief";
import { draft, gate } from "./agents/creative";
import { scheduleVariants } from "./agents/distribution";
import type { db as Db } from "./db";
import { isBlocked, isTerminal, lastGateVerdict } from "./live";
import { humanError, isRateLimit } from "./llm/provider";
import { campaigns } from "./schema";
import {
  Approval,
  CampaignState,
  Variant,
  type CampaignStatus,
  type HumanDecision,
  type Platform,
  type StreamEvent,
} from "./schemas";

/** One SSE frame. Same shape on both sides of the wire, validated by StreamEvent. */
export type Transition = StreamEvent;
export type OnTransition = (t: Transition) => void | Promise<void>;

/** Carries an HTTP status so route handlers don't have to sniff error messages. */
export class PipelineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

/**
 * Transition fan-out for the SSE route, which watches a run started by a
 * different request. The log is replayed to every new subscriber, so a client
 * that connects a beat after POST sees the transitions it already missed.
 *
 * ponytail: in-process. A second server instance only sees its own runs, and a
 * restart loses the log — the campaigns row survives either way, which is why
 * the route falls back to it. Postgres LISTEN/NOTIFY if it ever runs multi-instance.
 */
const feeds = new Map<string, { log: Transition[]; subs: Set<(t: Transition) => void> }>();

const feedFor = (campaign_id: string) => {
  const existing = feeds.get(campaign_id);
  if (existing) return existing;
  const fresh = { log: [] as Transition[], subs: new Set<(t: Transition) => void>() };
  feeds.set(campaign_id, fresh);
  return fresh;
};

/** Replays what already happened, then streams the rest. Returns the unsubscribe. */
export function subscribe(campaign_id: string, fn: (t: Transition) => void): () => void {
  const feed = feedFor(campaign_id);
  for (const t of feed.log) fn(t);
  feed.subs.add(fn);
  return () => feed.subs.delete(fn);
}

/**
 * The campaign's status is the gate's verdict, and the worst one wins: a single
 * blocked variant is a blocked campaign, whatever the other two say. All three
 * verdict names are CampaignStatus members, so there is nothing to translate.
 */
const RANK = { rejected: 2, needs_human: 1, approved: 0 } as const;

export const worstVerdict = (approvals: Approval[]): Approval["verdict"] =>
  approvals.reduce<Approval["verdict"]>(
    (worst, a) => (RANK[a.verdict] > RANK[worst] ? a.verdict : worst),
    "approved",
  );

/**
 * Persist, then emit. The `campaigns` row is upserted rather than inserted-once
 * because the id is minted here, before the row exists — CampaignState needs its
 * own campaign_id, so the id cannot come from a serial default.
 */
async function commit(
  db: typeof Db,
  state: CampaignState,
  status: CampaignStatus,
  onTransition: OnTransition | undefined,
  error?: string,
): Promise<CampaignState> {
  const next = CampaignState.parse({ ...state, status, error: error ?? null });
  const row = { status, state: next, updated_at: new Date() };
  await db
    .insert(campaigns)
    .values({ id: next.campaign_id, ...row })
    .onConflictDoUpdate({ target: campaigns.id, set: row });

  const transition: Transition = { status, state: next, error };
  const feed = feedFor(next.campaign_id);
  feed.log.push(transition);
  for (const sub of feed.subs) sub(transition);
  // The log is only useful while someone might still ask for it. A minute after
  // the run ends is long enough for a client to reconnect and replay it.
  if (isTerminal(status)) setTimeout(() => feeds.delete(next.campaign_id), 60_000);

  await onTransition?.(transition);
  return next;
}

/**
 * Every way a run stops badly goes through here, so the two questions are
 * answered in one place: is this a crash or a limit, and what may a human read.
 *
 * A 429 that outlived its retries is not a failure of the pipeline — it is the
 * free tier's capacity, and everything the run already produced is still on the
 * state it commits. The message is prose, never the provider's body: that keeps
 * the org id off the screen, and the trace row still has the whole thing.
 */
const fail = (
  db: typeof Db,
  state: CampaignState,
  err: unknown,
  onTransition?: OnTransition,
): Promise<CampaignState> =>
  commit(db, state, isRateLimit(err) ? "rate_limited" : "failed", onTransition, humanError(err));

export async function load(db: typeof Db, campaign_id: string): Promise<CampaignState> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign_id)).limit(1);
  if (!row) throw new PipelineError(`no campaign ${campaign_id}`, 404);
  return CampaignState.parse(row.state);
}

/**
 * Claims a parked run so exactly one caller may restart it, and reports whether
 * this was the one that got it.
 *
 * Reading the status and then acting on it is not enough: nothing about the
 * campaign changes until the first agent commits, which is seconds of LLM call
 * later, so two clicks — or a re-submitted Server Action, which is what actually
 * happened — both read `rate_limited` and both spend the tokens. The `UPDATE` is
 * conditional on the status it just read, so the database picks the winner and
 * the loser returns having spent nothing.
 */
export async function claimRateLimited(
  db: typeof Db,
  campaign_id: string,
  { onTransition }: { onTransition?: OnTransition } = {},
): Promise<boolean> {
  const state = await load(db, campaign_id);
  if (state.status !== "rate_limited") return false;

  const claimed = await db
    .update(campaigns)
    // `updated_at` is what `awaiting()` compares against, so every write to this
    // row has to move it. A claim that left it stale would let a later CAS pass
    // against a row that had in fact changed.
    .set({ status: "collecting", updated_at: new Date() })
    .where(and(eq(campaigns.id, campaign_id), eq(campaigns.status, "rate_limited")))
    .returning({ id: campaigns.id });
  if (claimed.length === 0) return false;

  // Rewrites the same row through the usual path, so the state and the frame
  // that clears the banner both happen exactly where every other one does.
  await commit(db, state, "collecting", onTransition);
  return true;
}

/**
 * The row, before any agent runs. Separate from `start()` so an HTTP caller can
 * hand back the id and have the campaign already be there when the client
 * subscribes — a 202 pointing at a row that does not exist yet is a race.
 */
export async function create(
  db: typeof Db,
  { onTransition, is_eval = false }: { onTransition?: OnTransition; is_eval?: boolean } = {},
): Promise<CampaignState> {
  const state = CampaignState.parse({ campaign_id: randomUUID(), status: "collecting" });
  // Set once, here: `commit` upserts only status/state/updated_at, so the flag
  // survives every transition without being part of the agents' contract.
  await db.insert(campaigns).values({ id: state.campaign_id, state, is_eval }).onConflictDoNothing();
  return commit(db, state, "collecting", onTransition);
}

/**
 * Runs the agents up to the human gate. `campaign_id` is minted before the first
 * agent so every `agent_events` row of the run hangs off the campaign — that is
 * the column the trace view filters on, and without it two overlapping runs are
 * indistinguishable.
 *
 * Every stage is skipped when its output is already on the state, which is what
 * makes this the resume path too: a run that stopped at `rate_limited` after the
 * brief picks back up at the drafts instead of paying for the analyst and the
 * brief a second time — the tokens that were the problem in the first place.
 *
 * Returns at `rejected`, `needs_human`, `rate_limited`, `failed` or
 * `awaiting_approval`. Nothing here reaches Distribution.
 */
export async function start(
  db: typeof Db,
  {
    platform,
    campaign_id: existing,
    onTransition,
  }: { platform?: Platform; campaign_id?: string; onTransition?: OnTransition } = {},
): Promise<CampaignState> {
  // Given an id, the row is already there and `collecting` was already emitted.
  let state = existing ? await load(db, existing) : await create(db, { onTransition });
  const campaign_id = state.campaign_id;

  try {
    let signal = state.signals[0];
    if (!signal) {
      signal = await analyze(db, { campaign_id });
      state = await commit(db, { ...state, signals: [signal] }, "signals", onTransition);
    }

    let brief = state.brief;
    if (!brief) {
      brief = await buildBrief(db, signal, { campaign_id });
      state = await commit(db, { ...state, brief }, "brief", onTransition);
    }

    let variants = state.variants;
    if (variants.length === 0) {
      // No platform given: the signal's own, alphabetically stable rather than
      // arbitrary. Pass one explicitly when the campaign has a target channel.
      variants = await draft(db, {
        brief,
        platform: platform ?? signal.platforms[0]!,
        campaign_id,
      });
      state = await commit(db, { ...state, variants }, "variants", onTransition);
    }

    // The gate always re-runs: a verdict is cheap next to a draft, and a partial
    // set of them from a run that died mid-gate is not a verdict on the campaign.
    const approvals = await gate(db, variants, { campaign_id });
    const verdict = worstVerdict(approvals);
    state = await commit(db, { ...state, approvals }, verdict, onTransition);

    // `approved` is the agent gate's answer, not a decision to publish. The
    // campaign parks in `awaiting_approval` until a human calls resume().
    if (verdict !== "approved") return state;
    return await commit(db, state, "awaiting_approval", onTransition);
  } catch (err) {
    // claude.md: a schema failure marks the campaign failed. Same for anything
    // else that throws — the error goes on the state, then out. Not
    // `needs_human`: nobody is being asked anything, the run died. `fail` splits
    // the one exception off: a rate limit is capacity, and it is resumable.
    await fail(db, state, err, onTransition);
    throw err;
  }
}

/**
 * What actually ships. A human approval overrides the gate's: the gate approves
 * every variant it doesn't object to, a person picks the one that runs. Falling
 * back to the agent verdicts keeps `resume()` working without a human — which is
 * what `pnpm pipeline` does.
 */
export const shippableVariantIds = (approvals: Approval[]): Set<string> => {
  const human = approvals.filter((a) => a.reviewer === "human");
  const decisive = human.length > 0 ? human : approvals;
  return new Set(decisive.filter((a) => a.verdict === "approved").map((a) => a.variant_id));
};

/**
 * Claims the campaign for one decision, and returns the state it claimed.
 *
 * The status check alone is not a lock. `decide()` runs the re-gate and
 * Distribution — LLM calls, seconds of them — between reading
 * `awaiting_approval` and committing anything, so two approvals both read it and
 * both spend. The `UPDATE` is a compare-and-swap on `updated_at`: conditional on
 * the row not having moved since the read, so the database picks the winner and
 * the loser is told rather than quietly running a second time.
 *
 * A compare-and-swap here and a status claim in `claimRateLimited` for the same
 * reason. `rate_limited` has an honest status to claim into — `collecting` is
 * where the run genuinely resumes, so a crash straight after the claim leaves
 * the campaign somewhere it has actually been. A decision has no such state:
 * there is nothing between `awaiting_approval` and what the human chose, so
 * claiming by status would mean inventing one, and a crash mid-decision would
 * park the campaign in a state nobody decided — which reads as an answer and is
 * not one. Swapping on the version claims the row without moving it.
 *
 * ponytail: `updated_at` doubles as the version, which leaves two edges. A claim
 * landing in the same millisecond as the commit before it would compare equal,
 * and a caller whose read lands *after* another's claim gets a fresh value and
 * passes — so this closes the lost-update race the UI actually hit, not every
 * interleaving. A monotonic `version` integer bumped in `commit()` is the fix
 * when that matters; `SELECT … FOR UPDATE` is not, because it would hold a
 * transaction open across an LLM call.
 */
async function awaiting(db: typeof Db, campaign_id: string): Promise<CampaignState> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign_id)).limit(1);
  if (!row) throw new PipelineError(`no campaign ${campaign_id}`, 404);

  const state = CampaignState.parse(row.state);
  if (state.status !== "awaiting_approval") {
    throw new PipelineError(`campaign ${campaign_id} is ${state.status}, not awaiting_approval`, 409);
  }

  const claimed = await db
    .update(campaigns)
    .set({ updated_at: new Date() })
    .where(and(eq(campaigns.id, campaign_id), eq(campaigns.updated_at, row.updated_at)))
    .returning({ id: campaigns.id });
  if (claimed.length === 0) {
    throw new PipelineError(
      `another decision on campaign ${campaign_id} was recorded first — reload to see what it decided`,
      409,
    );
  }
  return state;
}

/** Everything after the gate. Takes the state rather than the id: `decide()` has already edited it. */
async function toDistribution(
  db: typeof Db,
  state: CampaignState,
  onTransition?: OnTransition,
): Promise<CampaignState> {
  const { campaign_id } = state;
  const signal = state.signals[0];
  if (!signal) {
    throw new PipelineError(`campaign ${campaign_id} has no signal to schedule against`, 409);
  }

  try {
    const ok = shippableVariantIds(state.approvals);
    const schedule = await scheduleVariants(
      db,
      signal,
      state.variants.filter((v) => ok.has(v.id)),
      { campaign_id },
    );
    return await commit(db, { ...state, schedule }, "scheduled", onTransition);
  } catch (err) {
    await fail(db, state, err, onTransition);
    throw err;
  }
}

/** The human said yes, without saying who. Kept for scripts; the UI calls `decide()`. */
export async function resume(
  db: typeof Db,
  campaign_id: string,
  { onTransition }: { onTransition?: OnTransition } = {},
): Promise<CampaignState> {
  return toDistribution(db, await awaiting(db, campaign_id), onTransition);
}

/**
 * The human gate, recorded. Appends an Approval carrying who signed off, which
 * variant they picked and why — the audit trail that used to stop at the agent
 * gate — and then either ships that variant or ends the campaign.
 *
 * Two things a human is not allowed to do quietly. Approving a variant the gate
 * blocked is an override: it needs a reason and it is stored as one. And `edit`
 * is not a bypass — the rewritten copy is not the copy the gate cleared, so it
 * goes back through the gate before anything is scheduled.
 */
export async function decide(
  db: typeof Db,
  campaign_id: string,
  decision: HumanDecision,
  { onTransition }: { onTransition?: OnTransition } = {},
): Promise<CampaignState> {
  const state = await awaiting(db, campaign_id);
  const target = state.variants.find((v) => v.id === decision.variant_id);
  if (!target) {
    throw new PipelineError(`campaign ${campaign_id} has no variant ${decision.variant_id}`, 409);
  }

  // No verdict at all counts as blocked: a variant the gate never judged has not
  // been cleared by it, and saying yes to one is still a call someone owns.
  const gate_verdict = lastGateVerdict(state.approvals, target.id);
  const overrode: Approval["overrode"] = !isBlocked(gate_verdict)
    ? null
    : gate_verdict?.verdict === "rejected"
      ? "rejected"
      : "needs_human";
  if (decision.action !== "reject" && overrode && !decision.reason) {
    throw new PipelineError(
      `variant ${target.id} is ${overrode} at the gate: approving it needs a reason`,
      400,
    );
  }

  const approvals = [
    ...state.approvals,
    Approval.parse({
      variant_id: decision.variant_id,
      verdict: decision.action === "reject" ? "rejected" : "approved",
      reviewer: "human",
      reviewed_by: decision.reviewed_by,
      reason: decision.reason ?? null,
      // Rejecting a blocked variant agrees with the gate; only a yes overrides it.
      overrode: decision.action === "reject" ? null : overrode,
    }),
  ];

  if (decision.action === "reject") {
    return commit(db, { ...state, approvals }, "rejected", onTransition);
  }
  if (decision.action === "approve") {
    return toDistribution(db, { ...state, approvals }, onTransition);
  }

  // Re-parsed, not spread blindly: an edit arrives over HTTP like anything else.
  const edited = Variant.parse({ ...target, ...decision.edits });
  const variants = state.variants.map((v) => (v.id === target.id ? edited : v));
  let regated: Approval;
  try {
    // One variant in, one verdict out — gate() asserts that before it returns.
    regated = (await gate(db, [edited], { campaign_id }))[0]!;
  } catch (err) {
    // The re-gate threw. The human's decision is still on the record; what is
    // not known is whether the rewrite passes, and that is a crash, not a verdict.
    await fail(db, { ...state, approvals, variants }, err, onTransition);
    throw err;
  }

  const next = { ...state, approvals: [...approvals, regated], variants };
  // The human's approve stays on the record next to the verdict that contradicts
  // it. What does not happen is the campaign shipping as if the edit had passed
  // clean: a re-gated block ends the run at the gate's verdict, not at Distribution.
  if (regated.verdict !== "approved") {
    return commit(db, next, regated.verdict, onTransition);
  }
  return toDistribution(db, next, onTransition);
}
