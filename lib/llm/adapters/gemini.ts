import { request, type Adapter } from "../http";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const headers = (): Record<string, string> => ({
  "content-type": "application/json",
  "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
});

export const gemini: Adapter = {
  name: "gemini",
  models: {
    reasoning: "gemini-2.5-pro",
    extraction: "gemini-2.5-flash",
    drafting: "gemini-2.5-flash",
  },
  embeddingModel: "text-embedding-004",
  embeddingDim: 768,

  async complete({ model, system, prompt }) {
    const res = await request<{
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    }>(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    return (
      res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? ""
    );
  },

  async embed({ model, texts }) {
    const res = await request<{ embeddings: { values: number[] }[] }>(
      `${BASE}/models/${model}:batchEmbedContents`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
      },
    );
    return res.embeddings.map((e) => e.values);
  },
};
