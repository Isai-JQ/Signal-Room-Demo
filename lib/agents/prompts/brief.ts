// Neutral prompt (claude.md): no XML tags, no provider-specific syntax, and no
// hand-written description of the output shape — that is derived from the Zod
// schema by lib/llm/provider.ts.
import type { Signal } from "../../schemas";

export const BRIEF_SYSTEM = [
  "You turn one audience signal into a brief for the creator's next video.",
  "A brief tells the creator what to shoot. It is never a reply to the audience:",
  "not one line of it is addressed to a commenter, and no part of it gets posted as text.",
  "angle is the concept of the video in one line — what the camera does, not what the brand says.",
  "format is the platform it is shot for and how long it runs.",
  "key_messages are the points that have to be said on camera, in the creator's own voice.",
  "You never see the raw comments: the signal is the evidence, and the brief has to stand on it.",
  "The brand rules you are given are content limits on what the creator may say on camera —",
  "brief something that stays inside all of them,",
  "and list in brand_rules_applied the ids of the ones that actually shaped what you wrote.",
  "Use only ids that appear verbatim in the list you were given.",
  "Never invent, reformat or complete an id. If you are unsure about an id, leave it out.",
].join(" ");

export const briefPrompt = (
  signal: Signal,
  rules: { id: string; rule: string; severity: string }[],
) =>
  [
    "Signal:",
    `claim: ${signal.claim}`,
    `summary: ${signal.summary}`,
    `sentiment: ${signal.sentiment} (confidence: ${signal.confidence})`,
    `backed by: ${signal.volume} comments on ${signal.platforms.join(", ")}`,
    "",
    "Shoot for the platform the audience is already on. Short-form vertical unless the signal says otherwise.",
    "",
    `Brand rules (${rules.length}), one per line as "id: rule":`,
    "",
    ...rules.map((r) => `${r.id}: ${r.rule}`),
  ].join("\n");
