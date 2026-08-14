import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { withLimit, withRetry, type Adapter, type JsonSchema, type Task } from "./http";
import { gemini } from "./adapters/gemini";
import { groq } from "./adapters/groq";
import { ollama } from "./adapters/ollama";

export type { Task } from "./http";

// Adding a provider = one adapter + one line here. No agent changes.
const adapters = { groq, gemini, ollama } satisfies Record<string, Adapter>;
export type ProviderName = keyof typeof adapters;

export function adapterFor(name: string): Adapter {
  const adapter = adapters[name as ProviderName];
  if (!adapter) {
    throw new Error(
      `Unknown provider "${name}". Known: ${Object.keys(adapters).join(", ")}`,
    );
  }
  return adapter;
}

export const llmProvider = () => process.env.LLM_PROVIDER ?? "groq";
export const embeddingProvider = () => process.env.EMBEDDING_PROVIDER ?? "ollama";

/** For the `provider` / `model` columns on agent_events. */
export const modelFor = (task: Task, provider = llmProvider()) =>
  adapterFor(provider).models[task];

/** Thrown when the model failed its schema twice — caller marks needs_human. */
export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

const JSON_RULES =
  "Respond with a single JSON object and nothing else: no prose, no markdown code fences.";

// Some local models ignore JSON mode and fence their output anyway.
const stripFences = (raw: string) =>
  raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

/** How the schema reached the model — persisted on agent_events. */
export type StructuredMode = "native" | "fallback";

export type Completion<T> = {
  data: T;
  /** What we asked for. */
  structured_mode: StructuredMode;
  /** Extra calls the transport cost us: 429 and 5xx retries. Says nothing about the model. */
  transport_attempts: number;
  /** Extra calls the model cost us: repair round-trips after a Zod failure. 0 or 1. */
  repair_attempts: number;
  /** What we got: the model satisfied the schema first time. Retries don't count. */
  schema_honored: boolean;
};

export async function complete<T>({
  task,
  system,
  prompt,
  schema,
  provider = llmProvider(),
}: {
  task: Task;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  provider?: string;
}): Promise<Completion<T>> {
  const adapter = adapterFor(provider);
  const model = adapter.models[task];

  // claude.md: the Zod schema is the only source of truth for the output shape.
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" }) as JsonSchema;
  const native = adapter.supportsStructuredOutput;
  const structured_mode: StructuredMode = native ? "native" : "fallback";

  const rules = native
    ? JSON_RULES
    : `${JSON_RULES}\n\nIt must validate against this JSON Schema:\n${JSON.stringify(jsonSchema)}`;

  let attemptPrompt = prompt;
  let raw = "";
  let issues = "";
  let transport_attempts = 0;

  // claude.md: one repair round-trip with the error injected, then give up.
  for (let repair_attempts = 0; repair_attempts < 2; repair_attempts++) {
    raw = await withLimit(() =>
      withRetry(
        () =>
          adapter.complete({
            model,
            system: `${system}\n\n${rules}`,
            prompt: attemptPrompt,
            ...(native ? { jsonSchema } : {}),
          }),
        () => transport_attempts++,
      ),
    );
    try {
      const parsed = schema.safeParse(JSON.parse(stripFences(raw)));
      if (parsed.success) {
        return {
          data: parsed.data,
          structured_mode,
          transport_attempts,
          repair_attempts,
          schema_honored: repair_attempts === 0,
        };
      }
      issues = JSON.stringify(parsed.error.issues);
    } catch (err) {
      issues = `output was not valid JSON: ${(err as Error).message}`;
    }
    attemptPrompt = `${prompt}\n\nYour previous answer was rejected:\n${raw}\n\nErrors:\n${issues}\n\nReturn corrected JSON only.`;
  }

  throw new SchemaValidationError(
    `${adapter.name}/${model} failed schema twice: ${issues}`,
    adapter.name,
    model,
    raw,
  );
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const adapter = adapterFor(embeddingProvider());
  const model = adapter.embeddingModel;
  if (!model) {
    throw new Error(`Provider "${adapter.name}" has no embedding model`);
  }

  // The pgvector column width comes from EMBEDDING_DIM, so a mismatch here is
  // silent corruption later. Fail loudly instead.
  const declared = Number(process.env.EMBEDDING_DIM);
  if (declared > 0 && declared !== adapter.embeddingDim) {
    throw new Error(
      `EMBEDDING_DIM=${declared} but ${adapter.name}/${model} returns ${adapter.embeddingDim}`,
    );
  }

  const vectors = await withLimit(() =>
    withRetry(() => adapter.embed({ model, texts })),
  );
  if (vectors.length !== texts.length) {
    throw new Error(
      `${adapter.name} returned ${vectors.length} vectors for ${texts.length} texts`,
    );
  }
  for (const v of vectors) {
    if (v.length !== adapter.embeddingDim) {
      throw new Error(
        `${adapter.name}/${model} returned width ${v.length}, expected ${adapter.embeddingDim}`,
      );
    }
  }
  return vectors;
}
