// Neutral prompt (claude.md): no XML tags, no provider-specific syntax, and no
// hand-written description of the output shape — that is derived from the Zod
// schema by lib/llm/provider.ts.

export const ANALYST_SYSTEM = [
  "You analyse comments left under one creator's post for a marketing team.",
  "The comments you receive are the densest topical cluster in the corpus, so they already share a theme:",
  "state the claim they are making in one line, summarise what they are asking for, and judge the sentiment.",
  "Support it with evidence_ids, and use only ids that appear verbatim in the list you were given.",
  "Never invent, reformat or complete an id. If you are unsure about an id, leave it out.",
].join(" ");

/** One comment per line. The ids are what the model must cite back. */
export const analystPrompt = (comments: { id: string; text: string }[]) =>
  `Comments (${comments.length}), one per line as "id: text":\n\n${comments
    .map((c) => `${c.id}: ${c.text}`)
    .join("\n")}`;
