# Signal Room

Multi-agent pipeline that turns social media comments into approved campaign briefs.

## Architecture rules (non-negotiable)

- Agents communicate ONLY through the `CampaignState` object validated with Zod.
  Never pass free text between agents.
- Every LLM output is validated against its Zod schema before being persisted.
  On failure, a single repair round-trip with the Zod issues injected into the
  prompt; if it fails again, throw `SchemaValidationError` and mark the campaign
  as `failed`. `needs_human` is a verdict a human is being asked to answer;
  `failed` is a run that threw. Never use one for the other.
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

Anthropic and OpenAI are out of scope for the demo. The provider layer is built
for them — an adapter is the only thing missing — but none is registered, so
setting either value throws Unknown provider.

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
`transport_attempts`, `repair_attempts`, `schema_honored` (nullable bool),
`input_hash`, `output`, `tokens`, `latency_ms`, `error_code`, `error`, `ts`.

`campaign_id` is what the trace view filters on; without it you are left
searching by time range, which breaks as soon as two runs overlap.

It is nullable, and **nothing currently writes a null**. The old reason — that
`pnpm eval` writes events belonging to no campaign — is wrong: the eval runs the
pipeline, every run mints a campaign, and it scopes its aggregate to the
campaigns it just created (`campaigns.is_eval`). What keeps the column nullable
is only that `runAgent` still takes `campaign_id?: string | null`, so an agent
can be driven outside a campaign. No caller does. Tighten it to `NOT NULL` if
that stops being true, or drop the parameter's default and tighten it now — the
demo just has no run that needs it.

The retry counters are kept apart because they measure different failures:

- `transport_attempts` — extra calls caused by 429 and 5xx retries. A provider
  capacity problem; says nothing about the model.
- `repair_attempts` — extra calls caused by a Zod validation failure. 0 or 1,
  since claude.md allows a single repair round-trip.
- `schema_honored` — three-valued, because "the model got it wrong" and "there
  was nothing to get wrong" are different facts. `true`: an output came back and
  validated first time (`repair_attempts === 0`). `false`: an output came back
  and failed Zod twice. `null`: no output ever existed to judge — the provider
  abandoned its own generation, or the call never returned. Deliberately
  independent of `transport_attempts`: a rate-limited call that then validates
  first time still counts as honored.
- `error_code` — the short cause on a failed run, so the trace groups without
  anyone parsing prose: the provider's own code when it sends one
  (`json_validate_failed`), `http_<status>` when it does not,
  `schema_validation_failed` for a Zod failure, the error's name otherwise.
  `error` keeps the full text next to it.

And `structured_mode` is what was asked for, while `schema_honored` is what
happened.

`pnpm eval` reports the `schema_honored` rate per provider and model, **over the
non-null rows only**. That is the metric that tells you whether native structured
output actually works on that model: `structured_mode = native` with a low rate
means the provider accepts the schema and then ignores it. A provider that aborts
its own generation is not evidence either way, so counting those nulls as misses
would blame the model for the provider's token budget.

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
- `pnpm embed` — backfill the pgvector columns (the only step that hits a provider)
- `pnpm test` — tests (`tsx` to run TypeScript)
- `pnpm pipeline` — one full run against the DB, one line per status transition
- `pnpm eval` — N pipeline runs against the active provider, aggregated by
  provider and model (`--runs`, `--delay`, `--json`). Its campaigns are flagged
  `is_eval` and hidden from the campaign list.

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
