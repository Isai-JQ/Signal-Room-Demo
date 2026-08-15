import { request, type Adapter, type JsonSchema } from "../http";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const headers = (): Record<string, string> => ({
  "content-type": "application/json",
  "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
});

// responseSchema is an OpenAPI subset, and the API 400s on any key outside it —
// including the `$schema` and `additionalProperties` that zod-to-json-schema
// emits. Allowlist rather than blocklist so a new Zod feature degrades to a
// dropped constraint instead of a rejected request.
// ponytail: unsupported constructs (unions, refinements) are silently dropped
// here and only caught by the repair loop. Validate the schema up front if that
// starts costing round-trips.
const KEEP = new Set([
  "type", "format", "description", "nullable", "enum", "items", "properties",
  "required", "minItems", "maxItems", "minimum", "maximum", "anyOf",
]);

function toGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as JsonSchema)
      .filter(([k]) => KEEP.has(k))
      .map(([k, v]) => [k, k === "properties" ? mapValues(v) : toGeminiSchema(v)]),
  );
}

// `properties` keys are field names, not schema keywords — recurse into values only.
const mapValues = (v: unknown) =>
  Object.fromEntries(
    Object.entries((v ?? {}) as JsonSchema).map(([k, s]) => [k, toGeminiSchema(s)]),
  );

export const gemini: Adapter = {
  name: "gemini",
  models: {
    reasoning: "gemini-2.5-pro",
    extraction: "gemini-2.5-flash",
    drafting: "gemini-2.5-flash",
  },
  embeddingModel: "text-embedding-004",
  embeddingDim: 768,
  supportsStructuredOutput: true,

  async complete({ model, system, prompt, jsonSchema }) {
    const res = await request<{
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { totalTokenCount?: number };
    }>(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          ...(jsonSchema ? { responseSchema: toGeminiSchema(jsonSchema) } : {}),
        },
      }),
    });
    return {
      text: res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "",
      tokens: res.usageMetadata?.totalTokenCount ?? null,
    };
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
