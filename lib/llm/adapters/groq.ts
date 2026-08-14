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
});
