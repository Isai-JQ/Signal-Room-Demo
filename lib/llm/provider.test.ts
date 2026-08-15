import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod/v4";
import type { Adapter } from "./http";
import { HttpError } from "./http";
import { SchemaValidationError, adapters, adapterFor, complete, failureCode } from "./provider";

// One schema, one prompt — every provider has to satisfy both.
const Analysis = z.object({
  sentiment: z.enum(["positive", "negative", "neutral"]),
  themes: z.array(z.string().min(1)).min(1).max(3),
});

const SYSTEM = "You analyse social media comments for a marketing team.";
// The prompt describes the task only — the shape comes from Analysis (claude.md).
const PROMPT = `Comment: "The new checkout is so much faster, but the app still crashes on Android."

Summarise the sentiment and the themes it raises.`;

const okBody = (content: string) => Response.json({ choices: [{ message: { content } }] });

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const real = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** supportsStructuredOutput is readonly by contract; tests need to flip it. */
function withStructuredOutput(provider: string, value: boolean) {
  const adapter = adapterFor(provider) as { supportsStructuredOutput: boolean };
  const previous = adapter.supportsStructuredOutput;
  adapter.supportsStructuredOutput = value;
  return () => {
    adapter.supportsStructuredOutput = previous;
  };
}

test("429 backs off exponentially, then validates the repaired output", async () => {
  process.env.LLM_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  process.env.LLM_RETRY_BASE_MS = "1";
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    if (calls <= 2) return new Response("rate limit exceeded", { status: 429 });
    // Fenced despite JSON mode — the parser must cope.
    return okBody('```json\n{"sentiment":"positive","themes":["checkout speed"]}\n```');
  });
  try {
    const out = await complete({
      task: "extraction",
      system: SYSTEM,
      prompt: PROMPT,
      schema: Analysis,
    });
    assert.deepEqual(out.data, { sentiment: "positive", themes: ["checkout speed"] });
    assert.equal(calls, 3, "two 429s should cost exactly two retries");
    assert.equal(out.transport_attempts, 2);
    assert.equal(out.repair_attempts, 0);
  } finally {
    restore();
  }
});

test("a schema miss gets one repair round-trip, and only one", async () => {
  process.env.LLM_PROVIDER = "groq";
  const bodies = [
    '{"sentiment":"amazing","themes":[]}', // wrong enum, empty array
    '{"sentiment":"negative","themes":["android crashes"]}',
    '{"sentiment":"neutral","themes":["never reached"]}',
  ];
  let calls = 0;
  const restore = stubFetch(async () => okBody(bodies[calls++] ?? "{}"));
  try {
    const out = await complete({
      task: "extraction",
      system: SYSTEM,
      prompt: PROMPT,
      schema: Analysis,
    });
    assert.equal(out.data.sentiment, "negative");
    assert.equal(calls, 2);
    // Native mode was requested, but the model needed the repair round-trip —
    // exactly the case the eval's schema_honored rate is meant to expose.
    assert.equal(out.structured_mode, "native");
    assert.equal(out.repair_attempts, 1);
    assert.equal(out.transport_attempts, 0);
    assert.equal(out.schema_honored, false);
  } finally {
    restore();
  }
});

test("a transport retry does not count against schema_honored", async () => {
  process.env.LLM_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  process.env.LLM_RETRY_BASE_MS = "1";
  let calls = 0;
  const restore = stubFetch(async () =>
    ++calls === 1
      ? new Response("rate limit exceeded", { status: 429 })
      : okBody('{"sentiment":"positive","themes":["checkout speed"]}'),
  );
  try {
    const out = await complete({
      task: "extraction",
      system: SYSTEM,
      prompt: PROMPT,
      schema: Analysis,
    });
    assert.equal(calls, 2);
    assert.equal(out.transport_attempts, 1);
    // The model got the schema right on its only real attempt — a 429 is the
    // provider's rate limit, not evidence the model ignores the schema.
    assert.equal(out.repair_attempts, 0);
    assert.equal(out.schema_honored, true);
  } finally {
    restore();
  }
});

test("concurrency limiter caps in-flight requests", async () => {
  process.env.LLM_PROVIDER = "groq";
  process.env.LLM_CONCURRENCY = "2";
  let inFlight = 0;
  let peak = 0;
  const restore = stubFetch(async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return okBody('{"sentiment":"neutral","themes":["a"]}');
  });
  try {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        complete({ task: "extraction", system: SYSTEM, prompt: PROMPT, schema: Analysis }),
      ),
    );
    assert.ok(peak <= 2, `peak in-flight was ${peak}, limit was 2`);
  } finally {
    restore();
    delete process.env.LLM_CONCURRENCY;
  }
});

test("two providers, one prompt, one schema (stubbed response shapes)", async () => {
  // Groq answers in OpenAI shape, Gemini in its own — both must land as T.
  const restore = stubFetch(async (url: string) =>
    String(url).includes("generativelanguage")
      ? Response.json({
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"sentiment":"positive",' },
                  { text: '"themes":["checkout speed","android crashes"]}' },
                ],
              },
            },
          ],
        })
      : okBody('{"sentiment":"positive","themes":["checkout speed"]}'),
  );
  try {
    const results = await Promise.all(
      (["groq", "gemini"] as const).map((provider) =>
        complete({
          task: "extraction",
          system: SYSTEM,
          prompt: PROMPT,
          schema: Analysis,
          provider,
        }),
      ),
    );
    for (const out of results) assert.ok(Analysis.safeParse(out.data).success);
    assert.equal(results[0]?.data.sentiment, results[1]?.data.sentiment);
    assert.deepEqual(results[1]?.data.themes, ["checkout speed", "android crashes"]);
  } finally {
    restore();
  }
});

test("native path sends the derived schema, and never puts it in the prompt", async () => {
  process.env.GROQ_API_KEY = "test-key";
  let body: Record<string, string> = {};
  const restore = stubFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return okBody('{"sentiment":"positive","themes":["checkout speed"]}');
  });
  const unflip = withStructuredOutput("groq", true);
  try {
    const out = await complete({
      task: "extraction",
      system: SYSTEM,
      prompt: PROMPT,
      schema: Analysis,
      provider: "groq",
    });
    assert.equal(out.structured_mode, "native");
    assert.equal(out.schema_honored, true);

    const format = body.response_format as unknown as {
      type: string;
      json_schema: { schema: { properties: Record<string, unknown> } };
    };
    assert.equal(format.type, "json_schema");
    // Derived from Zod, not hand-written: both fields must be present.
    assert.deepEqual(Object.keys(format.json_schema.schema.properties).sort(), [
      "sentiment",
      "themes",
    ]);

    const messages = body.messages as unknown as { content: string }[];
    assert.ok(
      !messages.some((m) => m.content.includes('"properties"')),
      "native mode must not also paste the schema into the prompt",
    );
  } finally {
    unflip();
    restore();
  }
});

test("fallback path injects the derived schema into the prompt instead", async () => {
  process.env.GROQ_API_KEY = "test-key";
  let body: Record<string, string> = {};
  const restore = stubFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return okBody('{"sentiment":"positive","themes":["checkout speed"]}');
  });
  const unflip = withStructuredOutput("groq", false);
  try {
    const out = await complete({
      task: "extraction",
      system: SYSTEM,
      prompt: PROMPT,
      schema: Analysis,
      provider: "groq",
    });
    assert.equal(out.structured_mode, "fallback");
    assert.equal(out.schema_honored, true);
    assert.deepEqual(body.response_format, { type: "json_object" });

    const messages = body.messages as unknown as { content: string }[];
    const system = messages.find((m) => m.content.startsWith(SYSTEM))?.content ?? "";
    // The enum lives in the Zod schema only, so seeing it proves it was derived.
    assert.ok(system.includes('"neutral"'), "schema should be serialised into the prompt");
    assert.ok(system.includes("themes"));
  } finally {
    unflip();
    restore();
  }
});

/**
 * The fallback branch as a provider actually meets it: an adapter that declares
 * it cannot take a schema natively, so provider.ts has to paste one into the
 * prompt instead. No fetch stub — the adapter *is* the stub, which is the whole
 * point: nothing about this depends on a real provider's wire format.
 */
test("an adapter without native structured output gets the schema in its prompt", async () => {
  let seen = { system: "", jsonSchema: undefined as unknown };
  const stub: Adapter = {
    name: "stub",
    models: { reasoning: "stub-r", extraction: "stub-x", drafting: "stub-d" },
    embeddingModel: null,
    embeddingDim: 0,
    supportsStructuredOutput: false,
    async complete({ system, jsonSchema }) {
      seen = { system, jsonSchema };
      return { text: '{"sentiment":"negative","themes":["android crashes"]}', tokens: 41 };
    },
    async embed() {
      throw new Error("not an embedding provider");
    },
  };
  (adapters as Record<string, Adapter>).stub = stub;
  try {
    const out = await complete({
      task: "extraction",
      system: SYSTEM,
      prompt: PROMPT,
      schema: Analysis,
      provider: "stub",
    });

    assert.equal(out.structured_mode, "fallback");
    // The schema never reaches the adapter as a parameter — that is what
    // "no native support" means — so the prompt is the only place it can be.
    assert.equal(seen.jsonSchema, undefined);
    const derived = JSON.parse(seen.system.slice(seen.system.indexOf("{"))) as {
      properties: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(derived.properties).sort(), ["sentiment", "themes"]);

    // And the output validates exactly as it does on the native path.
    assert.deepEqual(out.data, { sentiment: "negative", themes: ["android crashes"] });
    assert.equal(out.schema_honored, true);
    assert.equal(out.repair_attempts, 0);
    assert.equal(out.tokens, 41);
  } finally {
    delete (adapters as Record<string, Adapter>).stub;
  }
});

test("tokens add up across a repair round-trip, and stay null when unreported", async () => {
  process.env.LLM_PROVIDER = "groq";
  const bodies = ['{"sentiment":"amazing","themes":[]}', '{"sentiment":"neutral","themes":["a"]}'];
  let calls = 0;
  let restore = stubFetch(async () =>
    Response.json({
      choices: [{ message: { content: bodies[calls] ?? "{}" } }],
      usage: { total_tokens: 100 + calls++ },
    }),
  );
  try {
    const out = await complete({ task: "extraction", system: SYSTEM, prompt: PROMPT, schema: Analysis });
    // The rejected attempt cost tokens too: 100 + 101. A TPM limit counts both.
    assert.equal(out.tokens, 201);
    assert.equal(out.repair_attempts, 1);
  } finally {
    restore();
  }

  restore = stubFetch(async () => okBody('{"sentiment":"neutral","themes":["a"]}'));
  try {
    const out = await complete({ task: "extraction", system: SYSTEM, prompt: PROMPT, schema: Analysis });
    // No usage in the response: null, not 0 — nothing was measured.
    assert.equal(out.tokens, null);
  } finally {
    restore();
  }
});

test("reasoning_effort goes out on drafting only, and only where it is configured", async () => {
  process.env.GROQ_API_KEY = "test-key";
  const sent: Record<string, unknown>[] = [];
  const restore = stubFetch(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return okBody('{"sentiment":"positive","themes":["checkout speed"]}');
  });
  try {
    for (const task of ["drafting", "reasoning"] as const) {
      await complete({ task, system: SYSTEM, prompt: PROMPT, schema: Analysis, provider: "groq" });
    }
    await complete({
      task: "drafting",
      system: SYSTEM,
      prompt: PROMPT,
      schema: Analysis,
      provider: "ollama",
    });
    assert.equal(sent[0]?.reasoning_effort, "low", "groq drafting should ask for less thinking");
    assert.ok(!("reasoning_effort" in (sent[1] ?? {})), "reasoning must keep its full budget");
    assert.ok(
      !("reasoning_effort" in (sent[2] ?? {})),
      "a provider that declares no efforts must not be sent one",
    );
  } finally {
    restore();
  }
});

test("failureCode separates a provider abort from a model that ignored the schema", () => {
  const groq400 = JSON.stringify({
    error: { message: "Failed to validate JSON.", code: "json_validate_failed" },
  });
  assert.equal(failureCode(new HttpError(400, groq400)), "json_validate_failed");
  // No code in the body, and no body at all: the status still says what happened.
  assert.equal(failureCode(new HttpError(500, "upstream exploded")), "http_500");
  assert.equal(failureCode(new HttpError(429, "")), "http_429");
  // The one case that is evidence about the model, and the only one that may
  // ever pair with schema_honored === false.
  assert.equal(failureCode(new SchemaValidationError("failed twice")), "schema_validation_failed");
  assert.equal(failureCode(new TypeError("fetch failed")), "TypeError");
});

/** Providers we can actually reach right now. */
async function reachable(): Promise<string[]> {
  const found: string[] = [];
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "test-key") found.push("groq");
  if (process.env.GEMINI_API_KEY) found.push("gemini");
  try {
    const url = `${process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/api/tags`;
    if ((await fetch(url, { signal: AbortSignal.timeout(700) })).ok) found.push("ollama");
  } catch {
    // not running locally
  }
  return found;
}

test("same prompt, same schema, every reachable provider", async (t) => {
  const providers = await reachable();
  if (providers.length < 2) {
    t.skip(`needs 2 live providers, found: ${providers.join(", ") || "none"}`);
    return;
  }
  for (const provider of providers) {
    await t.test(provider, async () => {
      const out = await complete({
        task: "extraction",
        system: SYSTEM,
        prompt: PROMPT,
        schema: Analysis,
        provider,
      });
      // complete() already validated; assert again so the intent is explicit.
      assert.ok(Analysis.safeParse(out.data).success);
      assert.ok(out.data.themes.length >= 1);
    });
  }
});
