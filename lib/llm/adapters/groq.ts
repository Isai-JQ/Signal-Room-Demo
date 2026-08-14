import { openAiCompat } from "./openai-compat";

export const groq = openAiCompat({
  name: "groq",
  baseUrl: () => "https://api.groq.com/openai/v1",
  apiKey: () => process.env.GROQ_API_KEY,
  models: {
    reasoning: "llama-3.3-70b-versatile",
    extraction: "llama-3.1-8b-instant",
    drafting: "llama-3.3-70b-versatile",
  },
  embeddingModel: null, // Groq serves no embedding models
  embeddingDim: 0,
  supportsStructuredOutput: true,
});
