// The pipeline: Analyst → Brief → Creative → gate → [pause] → Distribution.
//
// Two entry points because the pause is real. `start()` runs everything a
// machine is allowed to decide and stops; `resume()` is what a human approving
// the campaign triggers. Nothing schedules a post without that second call.
//
// Every transition is persisted before it is announced, so a crash between the
// two loses an event, never the state.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { analyze } from "./agents/analyst";
import { buildBrief } from "./agents/brief";
import { draft, gate } from "./agents/creative";
import { scheduleVariants } from "./agents/distribution";
import type { db as Db } from "./db";
import { campaigns } from "./schema";
import { CampaignState, type Approval, type CampaignStatus, type Platform } from "./schemas";

export type Transition = { status: CampaignStatus; state: CampaignState; error?: string };
export type OnTransition = (t: Transition) => void | Promise<void>;

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
  await onTransition?.({ status, state: next, error });
  return next;
}

export async function load(db: typeof Db, campaign_id: string): Promise<CampaignState> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign_id)).limit(1);
  if (!row) throw new Error(`no campaign ${campaign_id}`);
  return CampaignState.parse(row.state);
}

/**
 * Runs the agents up to the human gate. `campaign_id` is minted before the first
 * agent so every `agent_events` row of the run hangs off the campaign — that is
 * the column the trace view filters on, and without it two overlapping runs are
 * indistinguishable.
 *
 * Returns at `rejected`, `needs_human` or `awaiting_approval`. Nothing here
 * reaches Distribution.
 */
export async function start(
  db: typeof Db,
  {
    platform,
    onTransition,
  }: { platform?: Platform; onTransition?: OnTransition } = {},
): Promise<CampaignState> {
  const campaign_id = randomUUID();
  let state = CampaignState.parse({ campaign_id, status: "collecting" });
  state = await commit(db, state, "collecting", onTransition);

  try {
    const signal = await analyze(db, { campaign_id });
    state = await commit(db, { ...state, signals: [signal] }, "signals", onTransition);

    const brief = await buildBrief(db, signal, { campaign_id });
    state = await commit(db, { ...state, brief }, "brief", onTransition);

    // No platform given: the signal's own, alphabetically stable rather than
    // arbitrary. Pass one explicitly when the campaign has a target channel.
    const variants = await draft(db, {
      brief,
      platform: platform ?? signal.platforms[0]!,
      campaign_id,
    });
    state = await commit(db, { ...state, variants }, "variants", onTransition);

    const approvals = await gate(db, variants, { campaign_id });
    const verdict = worstVerdict(approvals);
    state = await commit(db, { ...state, approvals }, verdict, onTransition);

    // `approved` is the agent gate's answer, not a decision to publish. The
    // campaign parks in `awaiting_approval` until a human calls resume().
    if (verdict !== "approved") return state;
    return await commit(db, state, "awaiting_approval", onTransition);
  } catch (err) {
    // claude.md: a schema failure marks the campaign needs_human. Same for
    // anything else that throws — the error goes on the state, then out.
    await commit(db, state, "needs_human", onTransition, String(err));
    throw err;
  }
}

/**
 * The human said yes. Schedules the variants the gate approved.
 *
 * ponytail: the approval itself is not recorded — no `reviewer: "human"` row,
 * no note of which variant a person actually picked, so the audit trail stops at
 * the agent gate. Take a variant_id and append a human Approval once there is a
 * UI to take it from.
 */
export async function resume(
  db: typeof Db,
  campaign_id: string,
  { onTransition }: { onTransition?: OnTransition } = {},
): Promise<CampaignState> {
  const state = await load(db, campaign_id);
  if (state.status !== "awaiting_approval") {
    throw new Error(`campaign ${campaign_id} is ${state.status}, not awaiting_approval`);
  }
  const signal = state.signals[0];
  if (!signal) throw new Error(`campaign ${campaign_id} has no signal to schedule against`);

  try {
    const ok = new Set(
      state.approvals.filter((a) => a.verdict === "approved").map((a) => a.variant_id),
    );
    const schedule = await scheduleVariants(
      db,
      signal,
      state.variants.filter((v) => ok.has(v.id)),
      { campaign_id },
    );
    return await commit(db, { ...state, schedule }, "scheduled", onTransition);
  } catch (err) {
    await commit(db, state, "needs_human", onTransition, String(err));
    throw err;
  }
}
