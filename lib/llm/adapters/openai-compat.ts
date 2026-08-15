import { request, type Adapter, type Task } from "../http";

// Groq and Ollama both speak /v1/chat/completions and /v1/embeddings, so the
// only difference between them is this config object.
type Config = {
  name: string;
  baseUrl: () => string;
  apiKey?: () => string | undefined;
  models: Record<Task, string>;
  embeddingModel: string | null;
  embeddingDim: number;
  supportsStructuredOutput: boolean;
  /**
   * Per-task `reasoning_effort`, for providers whose models think before they
   * answer. Only the tasks named here send it, so a provider that has no such
   * parameter simply leaves this out.
   */
  reasoningEffort?: Partial<Record<Task, "low" | "medium" | "high">>;
};

export function openAiCompat(cfg: Config): Adapter {
  const headers = (): Record<string, string> => {
    const key = cfg.apiKey?.();
    return {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    };
  };

  return {
    name: cfg.name,
    models: cfg.models,
    embeddingModel: cfg.embeddingModel,
    embeddingDim: cfg.embeddingDim,
    supportsStructuredOutput: cfg.supportsStructuredOutput,

    async complete({ model, task, system, prompt, jsonSchema }) {
      const effort = cfg.reasoningEffort?.[task];
      const res = await request<{
        choices?: { message?: { content?: string | null } }[];
        usage?: { total_tokens?: number };
      }>(`${cfg.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(effort ? { reasoning_effort: effort } : {}),
          // ponytail: no `strict: true` — it demands every property in
          // `required` and rejects optionals. Add it if a model ignores the
          // schema in non-strict mode.
          response_format: jsonSchema
            ? { type: "json_schema", json_schema: { name: "output", schema: jsonSchema } }
            : { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      return {
        text: res.choices?.[0]?.message?.content ?? "",
        // Prompt + completion + reasoning, as the provider counted it — the same
        // number a TPM limit is spent against.
        tokens: res.usage?.total_tokens ?? null,
      };
    },

    async embed({ model, texts }) {
      const res = await request<{ data: { embedding: number[]; index?: number }[] }>(
        `${cfg.baseUrl()}/embeddings`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ model, input: texts }),
        },
      );
      // Order is not guaranteed by the spec; sort before returning.
      return [...res.data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding);
    },
  };
}
