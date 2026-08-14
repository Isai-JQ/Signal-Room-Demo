// Shared plumbing for every LLM adapter: typed contract, HTTP errors with
// status, 429 backoff, and a concurrency cap. No provider specifics here.

export type Task = "reasoning" | "extraction" | "drafting";

/** What zod-to-json-schema hands back. Opaque here — adapters just forward it. */
export type JsonSchema = Record<string, unknown>;

export type Adapter = {
  readonly name: string;
  /** task → concrete model. Agents never name a model; see claude.md. */
  readonly models: Record<Task, string>;
  /** null when the provider has no embedding endpoint (e.g. Groq). */
  readonly embeddingModel: string | null;
  readonly embeddingDim: number;
  /** true → honours `jsonSchema` natively; false → provider.ts prompts it instead. */
  readonly supportsStructuredOutput: boolean;
  complete(args: {
    model: string;
    system: string;
    prompt: string;
    /** Only passed when supportsStructuredOutput is true. */
    jsonSchema?: JsonSchema;
  }): Promise<string>;
  embed(args: { model: string; texts: string[] }): Promise<number[][]>;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/** Envs are read per call so tests can retune them after import. */
const retryBaseMs = () => Number(process.env.LLM_RETRY_BASE_MS ?? 1000);
const concurrency = () => Math.max(1, Number(process.env.LLM_CONCURRENCY ?? 2));

const MAX_RETRIES = 3; // 3 retries after the first try → waits 1s, 2s, 4s

export async function request<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new HttpError(
      res.status,
      await res.text().catch(() => ""),
      retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries 429 and 5xx. Honours Retry-After when the provider sends one.
 * `onRetry` fires once per retry so callers can count transport attempts
 * separately from schema repairs.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  onRetry?: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable =
        err instanceof HttpError && (err.status === 429 || err.status >= 500);
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      onRetry?.();
      await sleep(err.retryAfterMs ?? retryBaseMs() * 2 ** attempt);
    }
  }
}

let active = 0;
const waiting: (() => void)[] = [];

// ponytail: FIFO semaphore, process-local. Can overshoot the cap by the number
// of pending wakeups in a rare interleaving, and knows nothing about other
// server instances. Swap for a Redis token bucket if you run more than one.
export async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= concurrency()) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
