// Presentation primitives shared by the list and the detail screen.
//
// The status→colour map lives here rather than in `lib/live`: it is a paint
// decision, not view logic, and `lib/live` is off limits. Nothing in this file
// imports anything that isn't a type, so a client component can pull it in
// without dragging the server along.
import type { Approval, CampaignStatus } from "@/lib/schemas";

/**
 * Colour reports an event and nothing else. Every stage the pipeline passes
 * through on its way somewhere is neutral — a run mid-flight has not reported
 * anything yet, so it does not get a colour for being busy.
 */
export const STATUS_TONE: Record<CampaignStatus, string> = {
  collecting: "border-line text-muted",
  signals: "border-line text-muted",
  brief: "border-line text-muted",
  variants: "border-line text-muted",
  approved: "border-line text-muted",
  awaiting_approval: "border-warn/50 text-warn",
  needs_human: "border-warn/50 text-warn",
  // Dimmer than needs_human on purpose: the free tier ran out for a minute.
  // It waits on a clock, not on a person, and should not shout as loudly.
  rate_limited: "border-warn/30 text-warn/70",
  scheduled: "border-ok/50 text-ok",
  // Both are stops. A gate rejection and a crash are different things, which is
  // what the label is for — the colour only says nothing is going out.
  rejected: "border-alarm/50 text-alarm",
  failed: "border-alarm/50 text-alarm",
};

export const VERDICT_TONE: Record<Approval["verdict"], string> = {
  approved: "border-ok/50 text-ok",
  needs_human: "border-warn/50 text-warn",
  rejected: "border-alarm/50 text-alarm",
};

/** Mono, uppercase, tracked. Never filled — a filled chip reads as a button. */
export function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`label border px-1.5 py-0.5 ${tone}`}>{children}</span>;
}

/**
 * A section rule with its name set into it, and — where there is one — the agent
 * that produced what follows.
 *
 * The attribution is the structural device: `signal / analyst` is the same name
 * that appears in the trace table's `agent` column further down the page, so the
 * sections of this screen and the rows of that table read as one thing. It says
 * something true about the content rather than numbering it 01/02/03.
 */
export function SectionRule({
  label,
  agent,
  aside,
  tone = "text-bone",
}: {
  label: string;
  agent?: string;
  aside?: React.ReactNode;
  /** Only ever a colour that reports the section's own state. Bone otherwise. */
  tone?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line pb-2">
      <h2 className={`label ${tone}`}>{label}</h2>
      {/* `brief / brief` is true and unreadable. When the section is named after
          its own agent the attribution has nothing left to add. */}
      {agent && agent !== label && (
        <>
          <span className="label text-line">/</span>
          <span className="label text-muted">{agent}</span>
        </>
      )}
      {aside && <span className="label ml-auto text-muted">{aside}</span>}
    </div>
  );
}
