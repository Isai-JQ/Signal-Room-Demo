// Creative: three treatments of the same brief's angle, then the brand gate.
// The two halves are separate model calls on purpose — a drafter grading its own
// draft is not a review.
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { db as Db } from "../db";
import { brand_rules } from "../schema";
import { Approval, Variant, type Brief, type Platform } from "../schemas";
import { CREATIVE_SYSTEM, GATE_SYSTEM, TREATMENTS, creativePrompt, gatePrompt } from "./prompts/creative";
import { runAgent } from "./run";

/**
 * id is minted here, the platform is the caller's call and the treatment is the
 * fan-out's, so none of the three is the model's to set.
 */
const VariantDraft = Variant.omit({ id: true, platform: true, treatment: true });

const GateCall = z.object({
  violations: Approval.shape.violations,
});

export async function draft(
  db: typeof Db,
  {
    brief,
    platform,
    campaign_id = null,
  }: { brief: Brief; platform: Platform; campaign_id?: string | null },
): Promise<Variant[]> {
  return Promise.all(
    TREATMENTS.map(async (treatment) => {
      const out = await runAgent({
        db,
        // The treatment is in the agent name so a trace shows which draft failed.
        agent: `creative:${treatment.id}`,
        task: "drafting",
        campaign_id,
        system: CREATIVE_SYSTEM,
        prompt: creativePrompt(brief, platform, treatment.instruction),
        schema: VariantDraft,
      });
      return Variant.parse({ ...out, id: randomUUID(), platform, treatment: treatment.id });
    }),
  );
}

/**
 * Brand gate. Checked against every rule, not the five the Brief retrieved:
 * enforcement is not a similarity search, and a rule that never surfaced is
 * still a rule. Severity decides the verdict here, in code — `block` rejects the
 * variant outright, `warn` sends it to the human gate.
 */
export async function gate(
  db: typeof Db,
  variants: Variant[],
  { campaign_id = null }: { campaign_id?: string | null } = {},
): Promise<Approval[]> {
  const rules = await db
    .select({ id: brand_rules.id, rule: brand_rules.rule, severity: brand_rules.severity })
    .from(brand_rules);
  if (rules.length === 0) throw new Error("no brand rules — run `pnpm seed` first");
  const severity = new Map(rules.map((r) => [r.id, r.severity]));

  const approvals = await Promise.all(
    variants.map(async (variant) => {
      const out = await runAgent({
        db,
        agent: "guardian",
        task: "reasoning",
        campaign_id,
        system: GATE_SYSTEM,
        prompt: gatePrompt(variant, rules),
        schema: GateCall,
      });

      // A violation of a rule that does not exist is not a violation.
      // `?? []` because the schema defaults it: a model that finds nothing may
      // leave the key out entirely rather than send an empty array.
      const violations = (out.violations ?? []).filter((v) => severity.has(v.rule_id));
      const verdict = violations.some((v) => severity.get(v.rule_id) === "block")
        ? "rejected"
        : violations.length > 0
          ? "needs_human"
          : "approved";

      return Approval.parse({ variant_id: variant.id, verdict, violations, reviewer: "agent" });
    }),
  );

  // One verdict per variant, each carrying its own id. A shared or missing id
  // would show the wrong variant's violations next to the copy a human is about
  // to approve, and nothing downstream would notice.
  const ids = new Set(approvals.map((a) => a.variant_id));
  if (approvals.length !== variants.length || ids.size !== variants.length) {
    throw new Error(
      `gate returned ${approvals.length} verdicts over ${ids.size} distinct variant ids for ${variants.length} variants`,
    );
  }
  return approvals;
}
