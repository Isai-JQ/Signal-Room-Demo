// Neutral prompt (claude.md): no XML tags, no provider-specific syntax, and no
// hand-written description of the output shape — that is derived from the Zod
// schema by lib/llm/provider.ts.
//
// The model is handed the answer and asked to explain it. It is never asked to
// pick the hour: see the note on peakHour in ../distribution.ts.
import type { Signal } from "../../schemas";

export const DISTRIBUTION_SYSTEM = [
  "You explain a publishing time that has already been chosen for you.",
  "The hour and the counts behind it are facts — restate them, never revise them,",
  "and never propose a different hour, however odd the one you were given looks.",
  "Two or three sentences a marketing lead can read without opening the data.",
].join(" ");

export const distributionPrompt = (
  signal: Signal,
  peak: { hour: number; count: number; total: number },
  histogram: number[],
) =>
  [
    `Chosen hour: ${String(peak.hour).padStart(2, "0")}:00-${String((peak.hour + 1) % 24).padStart(2, "0")}:00 UTC`,
    `Comments in that hour: ${peak.count} of ${peak.total}`,
    "",
    `Signal: ${signal.claim}`,
    `Sentiment: ${signal.sentiment} (confidence: ${signal.confidence})`,
    `Platforms: ${signal.platforms.join(", ")}`,
    "",
    "When the audience commented, by hour UTC:",
    ...histogram.flatMap((n, h) => (n === 0 ? [] : [`${String(h).padStart(2, "0")}:00 — ${n}`])),
  ].join("\n");
