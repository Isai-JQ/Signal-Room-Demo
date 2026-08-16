// POST /api/campaigns/[id]/approve — the human gate.
//
// approve | edit | reject, all three recorded as an Approval with `reviewer:
// "human"`: who signed off, which variant they picked, and why. approve and edit
// resume the run into Distribution, which is why this responds slowly — it waits
// for the schedule. The stream carries the same transitions if you'd rather not.
import { db } from "@/lib/db";
import { humanError } from "@/lib/llm/provider";
import { decide, PipelineError } from "@/lib/pipeline";
import { HumanDecision } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decision = HumanDecision.safeParse(await req.json().catch(() => null));
  if (!decision.success) {
    return Response.json({ error: decision.error.flatten() }, { status: 400 });
  }

  try {
    const state = await decide(db, id, decision.data);
    return Response.json({
      campaign_id: id,
      status: state.status,
      approvals: state.approvals.filter((a) => a.reviewer === "human"),
      schedule: state.schedule,
    });
  } catch (err) {
    // 404 unknown campaign, 409 wrong state, wrong variant, or another decision
    // claimed this one first, 500 the agents failed — and that last one already
    // left the campaign as failed or rate_limited.
    const status = err instanceof PipelineError ? err.status : 500;
    // `humanError` on the 500: an agent failure carries the provider's body, and
    // that has the org id in it. The trace row keeps the whole thing.
    return Response.json(
      { error: err instanceof PipelineError ? err.message : humanError(err) },
      { status },
    );
  }
}
