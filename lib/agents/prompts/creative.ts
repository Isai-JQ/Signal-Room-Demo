// Neutral prompts (claude.md): no XML tags, no provider-specific syntax, and no
// hand-written description of the output shape — that is derived from the Zod
// schema by lib/llm/provider.ts.
import type { Brief, Platform, Treatment, Variant } from "../../schemas";

export const CREATIVE_SYSTEM = [
  "You write the production treatment for one video, working only from the brief you are given.",
  "The brief's angle is the concept and it is fixed: your job is one way of shooting it, not a different idea.",
  "body is direction for the creator — what happens on camera, beat by beat, in the order it is filmed.",
  "hooks are the opening lines the creator says to camera, the first words of the video:",
  "alternatives to pick from, not a sequence, and never a greeting or a thank-you.",
  "Nothing you write is addressed to a commenter or gets posted as text — this is a shot list, not a reply.",
  "Carry the key messages and introduce no claim, offer or date that is not in the brief.",
  "Stay inside the platform and run time the brief's format gives you.",
].join(" ");

/**
 * Three treatments, three shoots, so the human gate picks rather than edits.
 *
 * Each instruction fixes how the video is built — what the first shot is, what a
 * beat is, what the hooks do — not just its mood. Three moods got three
 * rewrites of one script back; a different skeleton per treatment is what makes
 * them pickable.
 */
export const TREATMENTS = [
  {
    id: "demo",
    instruction: [
      "Straight demonstration. First shot is the thing itself being used — no title card, no intro, no talking head.",
      "Three or four beats, each one thing the camera shows, in filming order.",
      "Hooks are flat statements of what the viewer is about to see. No questions, no jokes.",
    ].join(" "),
  },
  {
    id: "story",
    instruction: [
      "First-person story. The creator narrates one continuous run of events — a day, a session, a trip —",
      "and the subject appears inside it rather than being presented to camera.",
      "Beats are moments in time, not features. Hooks drop the viewer mid-scene, before any context.",
    ].join(" "),
  },
  {
    id: "proof",
    instruction: [
      "Side-by-side test. Name the two conditions the camera can show back to back in the first beat,",
      "then the comparison shot, then what it settles. Claim nothing the shot does not show.",
      "Hooks state the test being run, never its result. Shortest of the three.",
    ].join(" "),
  },
] as const satisfies readonly { id: Treatment; instruction: string }[];

export const creativePrompt = (brief: Brief, platform: Platform, treatment: string) =>
  [
    `Platform: ${platform}`,
    `Treatment: ${treatment}`,
    "",
    "Brief:",
    `headline: ${brief.headline}`,
    `audience: ${brief.audience}`,
    `angle (the concept — shoot this, do not replace it): ${brief.angle}`,
    `format: ${brief.format}`,
    "must be said on camera:",
    ...brief.key_messages.map((m) => `- ${m}`),
  ].join("\n");

export const GATE_SYSTEM = [
  "You check a video's production brief against a brand's content limits —",
  "what the creator is allowed to say and show on camera.",
  "Report every rule the brief breaks, one entry per rule, quoting the hook or the direction that breaks it.",
  "Judge only what the brief actually tells the creator to say: a rule it does not break is not reported,",
  "and a rule it obeys is not a violation.",
  "Use only rule ids that appear verbatim in the list you were given.",
  "Never invent, reformat or complete an id. If you are unsure about an id, leave it out.",
].join(" ");

/** No severities in the prompt: what a violation costs is decided in code, not by the model. */
export const gatePrompt = (variant: Variant, rules: { id: string; rule: string }[]) =>
  [
    `Video brief (${variant.platform}, ${variant.treatment}):`,
    "hooks to camera:",
    ...variant.hooks.map((h) => `- ${h}`),
    "direction:",
    variant.body,
    ...(variant.hashtags.length
      ? [`caption tags: ${variant.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}`]
      : []),
    "",
    `Brand rules (${rules.length}), one per line as "id: rule":`,
    "",
    ...rules.map((r) => `${r.id}: ${r.rule}`),
  ].join("\n");
