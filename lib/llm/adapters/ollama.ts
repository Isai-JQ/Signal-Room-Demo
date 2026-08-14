import { openAiCompat } from "./openai-compat";

export const ollama = openAiCompat({
  name: "ollama",
  baseUrl: () => `${process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/v1`,
  models: {
    reasoning: "qwen2.5:7b-instruct",
    extraction: "qwen2.5:7b-instruct",
    drafting: "qwen2.5:7b-instruct",
  },
  embeddingModel: "nomic-embed-text",
  embeddingDim: 768,
  supportsStructuredOutput: true,
});
