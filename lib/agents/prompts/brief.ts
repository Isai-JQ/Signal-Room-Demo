// Neutral prompt (claude.md): no XML tags, no provider-specific syntax, and no
// hand-written description of the output shape — that is derived from the Zod
// schema by lib/llm/provider.ts.
import type { Signal } from "../../schemas";

export const BRIEF_SYSTEM = [
  "You turn one audience signal into a campaign brief for a marketing team.",
  "You never see the raw comments: the signal is the evidence, and the brief has to stand on it.",
  "The brand rules you are given are binding — write something that obeys all of them,",
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
    `Brand rules (${rules.length}), one per line as "id: rule":`,
    "",
    ...rules.map((r) => `${r.id}: ${r.rule}`),
  ].join("\n");
