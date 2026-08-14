// Brief: turns one Signal into a campaign brief. The model gets the Signal and
// the brand rules nearest to it — never the raw comments. The Analyst already
// read those, and its claim is what the retrieval query is embedded from, so
// the brief inherits the evidence without re-reading it.
import { cosineDistance, isNotNull } from "drizzle-orm";
import type { db as Db } from "../db";
import { embed } from "../llm/provider";
import { brand_rules } from "../schema";
import { Brief, type Signal } from "../schemas";
import { BRIEF_SYSTEM, briefPrompt } from "./prompts/brief";
import { runAgent } from "./run";

/** signal_ids is ours to fill — the model is never handed ids it could echo back wrong. */
const BriefDraft = Brief.omit({ signal_ids: true });

const RULES = 5;

export type RetrievedRule = { id: string; rule: string; severity: "block" | "warn" };

/** Nearest brand rules to the claim by cosine distance in pgvector. */
export async function similarRules(
  db: typeof Db,
  claim: string,
  take = RULES,
): Promise<RetrievedRule[]> {
  const [query] = await embed([claim]);
  return db
    .select({ id: brand_rules.id, rule: brand_rules.rule, severity: brand_rules.severity })
    .from(brand_rules)
    .where(isNotNull(brand_rules.embedding))
    .orderBy(cosineDistance(brand_rules.embedding, query!))
    .limit(take);
}

export async function buildBrief(
  db: typeof Db,
  signal: Signal,
  { campaign_id = null, take = RULES }: { campaign_id?: string | null; take?: number } = {},
): Promise<Brief> {
  const rules = await similarRules(db, signal.claim, take);
  if (rules.length === 0) throw new Error("no embedded brand rules — run `pnpm embed` first");

  const out = await runAgent({
    db,
    agent: "brief",
    task: "reasoning",
    campaign_id,
    system: BRIEF_SYSTEM,
    prompt: briefPrompt(signal, rules),
    schema: BriefDraft,
  });

  // Same check the Analyst runs on evidence_ids: a rule the model was never sent
  // is a rule it did not read, whatever it claims to have applied.
  const sent = new Set(rules.map((r) => r.id));
  const cited = new Set(out.brand_rules_applied);
  const applied = [...cited].filter((id) => sent.has(id));
  if (cited.size > 0 && applied.length === 0) {
    throw new Error(`brief cited ${cited.size} brand rule ids, none of them real`);
  }

  return Brief.parse({ ...out, brand_rules_applied: applied, signal_ids: [signal.id] });
}
