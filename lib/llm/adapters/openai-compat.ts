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

    async complete({ model, system, prompt }) {
      const res = await request<{
        choices?: { message?: { content?: string | null } }[];
      }>(`${cfg.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      return res.choices?.[0]?.message?.content ?? "";
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
