import { z } from "zod/v4";
import { HttpError, withLimit, withRetry, type Adapter, type JsonSchema, type Task } from "./http";
import { gemini } from "./adapters/gemini";
import { groq } from "./adapters/groq";
import { ollama } from "./adapters/ollama";

export type { Task } from "./http";

// Adding a provider = one adapter + one line here. No agent changes.
// ponytail: exported so a test can register a stub adapter. Nothing in the app
// writes to it; make it a real registry with a `register()` if that changes.
export const adapters = { groq, gemini, ollama } satisfies Record<string, Adapter>;
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

/** Thrown when the model failed its schema twice — caller marks the campaign failed. */
export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

/**
 * A short, groupable cause for `agent_events.error_code`, so the trace can tell
 * "the provider abandoned its own generation" from "the model ignored the
 * schema" without anyone reading prose. The provider's own code wins when it
 * sends one — `json_validate_failed` is the interesting one here, because it is
 * a 400 that says nothing about whether the model can follow a schema.
 */
export function failureCode(err: unknown): string {
  if (err instanceof SchemaValidationError) return "schema_validation_failed";
  if (err instanceof HttpError) {
    let code: unknown;
    try {
      code = (JSON.parse(err.body) as { error?: { code?: unknown; status?: unknown } })?.error
        ?.code;
    } catch {
      // Not every provider errors in JSON; the status is still a cause.
    }
    return typeof code === "string" && code ? code : `http_${err.status}`;
  }
  return err instanceof Error && err.name ? err.name : "unknown";
}

/** A 429 that outlived its retries: free-tier capacity, not a broken pipeline. */
export const isRateLimit = (err: unknown) => err instanceof HttpError && err.status === 429;

/**
 * The line a human reads. A provider's error body carries the org id and an echo
 * of the request, so it never leaves the trace row — this keeps only the numbers
 * that explain the failure and drops the rest.
 */
export function humanError(err: unknown): string {
  if (!(err instanceof HttpError)) return String(err);
  const provider = llmProvider();
  if (err.status !== 429) return `${provider} returned HTTP ${err.status}. Full response in the trace.`;

  const grab = (re: RegExp) => err.body.match(re)?.[1] ?? null;
  // Thousands separators only — `[\d,]*` would swallow the comma that ends the clause.
  const limit = grab(/Limit (\d+(?:,\d{3})*)/);
  const used = grab(/Used (\d+(?:,\d{3})*)/);
  // Which budget ran out. A per-day limit clears tomorrow, not in a minute, and
  // telling someone to wait for "the window" is the wrong advice for one of them.
  const per = grab(/tokens per (day|minute)/);

  // Retry-After is the provider's own number; the body's prose is the fallback,
  // and it comes as `11.4s` or as `6m22.752s`.
  const prose = err.body.match(/try again in (?:(\d+)m)?([\d.]+)s/);
  const secs = err.retryAfterMs
    ? Math.ceil(err.retryAfterMs / 1000)
    : prose
      ? Math.ceil(Number(prose[1] ?? 0) * 60 + Number(prose[2]))
      : null;

  const unit = per === "day" ? "tokens/day" : "tokens/min";
  const budget = limit ? ` (${limit} ${unit}${used ? `, ${used} used` : ""})` : "";
  const when = secs
    ? ` Retry in about ${secs < 120 ? `${secs}s` : `${Math.round(secs / 60)} min`}.`
    : " Retry when the window clears.";
  return `Rate limit reached on ${provider}'s free tier${budget}.${when}`;
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
  /**
   * What we got: the model satisfied the schema first time. Retries don't count.
   * Always a boolean here — there is an output to judge, or this never returned.
   * The null case lives on `agent_events`, for a run that produced no output at all.
   */
  schema_honored: boolean;
  /**
   * Total tokens the whole call cost, repairs included — the number a TPM limit
   * actually counts. Null when no attempt reported usage.
   */
  tokens: number | null;
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
  // `io: "input"` because this describes what the model must send: a field with a
  // Zod default is one the model may leave out, which output mode would demand.
  const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
  const native = adapter.supportsStructuredOutput;
  const structured_mode: StructuredMode = native ? "native" : "fallback";

  const rules = native
    ? JSON_RULES
    : `${JSON_RULES}\n\nIt must validate against this JSON Schema:\n${JSON.stringify(jsonSchema)}`;

  let attemptPrompt = prompt;
  let raw = "";
  let issues = "";
  let transport_attempts = 0;
  // Accumulated across repairs: a retry that cost tokens still cost them.
  let tokens: number | null = null;

  // claude.md: one repair round-trip with the error injected, then give up.
  for (let repair_attempts = 0; repair_attempts < 2; repair_attempts++) {
    const out = await withLimit(() =>
      withRetry(
        () =>
          adapter.complete({
            model,
            task,
            system: `${system}\n\n${rules}`,
            prompt: attemptPrompt,
            ...(native ? { jsonSchema } : {}),
          }),
        () => transport_attempts++,
      ),
    );
    raw = out.text;
    if (out.tokens !== null) tokens = (tokens ?? 0) + out.tokens;
    try {
      const parsed = schema.safeParse(JSON.parse(stripFences(raw)));
      if (parsed.success) {
        return {
          data: parsed.data,
          structured_mode,
          transport_attempts,
          repair_attempts,
          schema_honored: repair_attempts === 0,
          tokens,
        };
      }
      issues = JSON.stringify(parsed.error.issues);
    } catch (err) {
      issues = `output was not valid JSON: ${(err as Error).message}`;
    }
    attemptPrompt = `${prompt}\n\nYour previous answer was rejected:\n${raw}\n\nErrors:\n${issues}\n\nReturn corrected JSON only.`;
  }

  throw new SchemaValidationError(`${adapter.name}/${model} failed schema twice: ${issues}`);
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
