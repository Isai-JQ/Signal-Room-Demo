// Neutral prompts (claude.md): no XML tags, no provider-specific syntax, and no
// hand-written description of the output shape — that is derived from the Zod
// schema by lib/llm/provider.ts.
import type { Brief, Platform, Variant } from "../../schemas";

export const CREATIVE_SYSTEM = [
  "You write one social post for a brand, working only from the campaign brief you are given.",
  "The headline, the angle and the key messages are what the post has to carry —",
  "do not introduce a claim, an offer or a date that is not in the brief.",
  "Write it native to the platform you are told to write for, and follow the tone instruction exactly.",
].join(" ");

/** Three tones, three drafts, so the human gate picks rather than edits. */
export const TONES = [
  {
    id: "direct",
    instruction:
      "Direct and plain. Short sentences, no jokes, no rhetorical questions. Say the thing and stop.",
  },
  {
    id: "playful",
    instruction:
      "Playful and quick. Light humour, a wink at the comment section, still respectful of anyone in it.",
  },
  {
    id: "warm",
    instruction:
      "Warm and conversational. Speak to one reader, acknowledge what they asked for, unhurried.",
  },
] as const;

export const creativePrompt = (brief: Brief, platform: Platform, tone: string) =>
  [
    `Platform: ${platform}`,
    `Tone: ${tone}`,
    "",
    "Brief:",
    `headline: ${brief.headline}`,
    `audience: ${brief.audience}`,
    `angle: ${brief.angle}`,
    "key messages:",
    ...brief.key_messages.map((m) => `- ${m}`),
  ].join("\n");

export const GATE_SYSTEM = [
  "You check a drafted social post against a brand's published rules.",
  "Report every rule the post breaks, one entry per rule, quoting the part of the post that breaks it.",
  "Judge only what the post actually says: a rule it does not break is not reported,",
  "and a rule it obeys is not a violation.",
  "Use only rule ids that appear verbatim in the list you were given.",
  "Never invent, reformat or complete an id. If you are unsure about an id, leave it out.",
].join(" ");

/** No severities in the prompt: what a violation costs is decided in code, not by the model. */
export const gatePrompt = (variant: Variant, rules: { id: string; rule: string }[]) =>
  [
    `Post (${variant.platform}):`,
    variant.body,
    ...(variant.hashtags.length
      ? [variant.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")]
      : []),
    "",
    `Brand rules (${rules.length}), one per line as "id: rule":`,
    "",
    ...rules.map((r) => `${r.id}: ${r.rule}`),
  ].join("\n");
