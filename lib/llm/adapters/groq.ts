import { openAiCompat } from "./openai-compat";

export const groq = openAiCompat({
  name: "groq",
  baseUrl: () => "https://api.groq.com/openai/v1",
  apiKey: () => process.env.GROQ_API_KEY,
  models: {
    // Only Groq models with json_schema + strict support
    reasoning: "openai/gpt-oss-120b",
    extraction: "openai/gpt-oss-120b",
    drafting: "openai/gpt-oss-20b",
  },
  embeddingModel: null, // Groq serves no embedding models
  embeddingDim: 0,
  supportsStructuredOutput: true,
  // gpt-oss puts most of a completion in the reasoning channel, and the whole
  // completion shares one token budget: a long enough think runs out of room
  // before the JSON closes and Groq 400s with json_validate_failed. Drafting a
  // shot list is the task that least needs the deliberation, so it is the one
  // that gives the budget back to the answer.
  reasoningEffort: { drafting: "low" },
});
