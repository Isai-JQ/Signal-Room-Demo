# Signal Room

Multi-agent pipeline that turns social media comments into approved campaign briefs.

## Architecture rules (non-negotiable)

- Agents communicate ONLY through the `CampaignState` object validated with Zod.
  Never pass free text between agents.
- Every LLM output is validated against its Zod schema before being persisted.
  On failure, a single repair round-trip with the Zod issues injected into the
  prompt; if it fails again, throw `SchemaValidationError` and mark the campaign
  as `needs_human`.
- Every agent run writes a row to `agent_events`, failed attempts included.
  No exceptions.
- API keys are used only in server Route Handlers. Never import an LLM client
  into a client component.
- The Zod schemas in `lib/schemas.ts` are the ONLY source of truth for the shape
  of the data. No prompt describes the output structure by hand: the JSON Schema
  is derived from the Zod schema.

## Provider independence

Every model call goes through `lib/llm/provider.ts`:

```ts
complete<T>({ task, system, prompt, schema }): Promise<{
  data: T; structured_mode; transport_attempts; repair_attempts; schema_honored
}>
embed(texts: string[]): Promise<number[][]>
```

Rules:

- The active provider comes from `LLM_PROVIDER` and `EMBEDDING_PROVIDER`. Adding
  a provider means writing an adapter, never touching an agent.
- Agents declare a semantic `task` (`"reasoning"` | `"extraction"` |
  `"drafting"`), never a model name. The mapping lives in the adapter.
- Every adapter declares `supportsStructuredOutput`. If `true`, the JSON Schema
  derived from Zod is passed through the provider's native mechanism. If
  `false`, it is injected into the prompt as a fallback.
- `EMBEDDING_DIM` is read from the environment. Width validation happens twice:
  against the dimension the adapter declares, and against every returned vector.
  A wrong-width vector in pgvector is silent corruption, so we throw instead of
  inserting.
- Retries on 429 and 5xx: the initial call plus up to 3 retries, waiting 1s, 2s
  and 4s. The provider's `Retry-After` header wins over the computed delay.
- Prompts in `lib/agents/prompts/` are neutral: no XML tags, no syntax specific
  to any provider.

### Providers

| Provider | Use | Notes |
|---|---|---|
| Groq | generation | Free tier, no card. Rate limits are org-wide. |
| Google Gemini | generation and embeddings | Free tier, no card. Data may be used for training. |
| Ollama | local embeddings and generation | No limits, no cost. Data never leaves the machine. |

Anthropic and OpenAI are out of scope for the demo; the provider layer supports
them if you want a comparison against paid models.

**Data rule:** no real user content goes to a free tier that may train on it.
The development seed is synthetic.

## Known limitations

Document them, don't hide them. They go in the README.

- The concurrency limiter (`lib/llm/http.ts`) is process-local. With several
  server instances it does not coordinate, so the effective RPM is multiplied by
  the number of instances. The real fix would be a shared token bucket or a
  queue with a single worker per provider; out of scope for the demo.

## Observability

`agent_events` stores per run: `campaign_id` (nullable), `agent`, `task`,
`provider`, `model`, `structured_mode` (`native` | `fallback`),
`transport_attempts`, `repair_attempts`, `schema_honored` (bool), `input_hash`,
`output`, `tokens`, `latency_ms`, `error`, `ts`.

`campaign_id` is what the trace view filters on; without it you are left
searching by time range, which breaks as soon as two runs overlap. It is
nullable because `pnpm eval` also writes events that belong to no campaign.

The retry counters are kept apart because they measure different failures:

- `transport_attempts` — extra calls caused by 429 and 5xx retries. A provider
  capacity problem; says nothing about the model.
- `repair_attempts` — extra calls caused by a Zod validation failure. 0 or 1,
  since claude.md allows a single repair round-trip.
- `schema_honored` — `repair_attempts === 0`. Deliberately independent of
  `transport_attempts`: a rate-limited call that then validates first time still
  counts as honored.

And `structured_mode` is what was asked for, while `schema_honored` is what
happened.

`pnpm eval` reports the `schema_honored` rate per provider and model. That is
the metric that tells you whether native structured output actually works on
that model: `structured_mode = native` with a low rate means the provider
accepts the schema and then ignores it.

## Conventions

- Server Components by default; `"use client"` only where there is interactivity.
- Types derived with `z.infer`, never written by hand.
- No `any`. No `console.log` in committed code.
- Code and comments in English, including this file.
- Tests with `node:test`. Ones that hit real APIs are skipped when keys are
  missing; a stubbed-response variant must always exist.

## Commands

- `pnpm dev` — development server
- `pnpm db:push` — apply schema
- `pnpm seed` — generate test comments
- `pnpm test` — tests (`tsx` to run TypeScript)
- `pnpm pipeline` — one full run against the DB, one line per status transition
- `pnpm eval` — run the full pipeline with the active provider

## Environment variables

```
LLM_PROVIDER=groq            # groq | gemini | ollama
EMBEDDING_PROVIDER=ollama    # ollama | gemini
EMBEDDING_DIM=768
LLM_CONCURRENCY=2
ANALYST_SIMILARITY_THRESHOLD=0.75
NEAR_DUPLICATE_THRESHOLD=0.95

GROQ_API_KEY=
GEMINI_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
DATABASE_URL=
```
