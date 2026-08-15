# Signal-Room-Demo

Multi-agent pipeline that turns raw social comments into approved campaign
briefs. Typed state handoffs between agents, Zod-validated LLM outputs, RAG over
brand rules, and a human approval gate. A brand gate reads every draft against
the brand's content limits before a human ever sees it, and what a violation
costs — reject outright, or send it up to a person — is decided in code from the
rule's severity, not by the model. Next.js · TypeScript · Postgres + pgvector

## Setup

```bash
cp .env.example .env.local   # DATABASE_URL is already pointed at the compose db
docker compose up -d         # Postgres 16 + pgvector, extension created on first boot
pnpm db:push                 # apply the Drizzle schema
pnpm seed                    # 400 synthetic comments + 12 brand rules, no embeddings yet
pnpm embed                   # backfill the pgvector columns
```

`pnpm embed` is the only step that talks to a provider. It reads
`EMBEDDING_PROVIDER` from `.env.local` — with the default (`ollama`) you need
`ollama serve` and `ollama pull nomic-embed-text` first, or switch it to
`gemini` and set `GEMINI_API_KEY`.

Then `pnpm dev`.

## Pipeline

Five agents, in order, plus a human in the middle. They never pass each other
prose: the only thing that moves through the pipeline is a `CampaignState`
(`lib/schemas.ts`) that is re-parsed with Zod at every transition and persisted
to `campaigns.state` before it is announced. Every model output is validated
against its own Zod schema too — one repair round-trip with the validation
errors injected into the prompt, and if that fails the campaign is marked
`failed` rather than allowed to continue on a half-parsed object.

**Analyst** (`lib/agents/analyst.ts`) reads embedded comments out of Postgres and
clusters them in code, not in the model. For every comment it collects the others
within `ANALYST_SIMILARITY_THRESHOLD` cosine similarity and scores the
neighbourhood by *distinct phrasings* — anything within
`NEAR_DUPLICATE_THRESHOLD` of a comment already counted adds nothing. That
distinction is what keeps the winner from being whichever sentence got copied
most. The densest neighbourhood's 30 closest members are the only thing the model
ever sees. It emits a `Signal`: a claim, a summary, sentiment, confidence and
cited evidence ids. The ids are checked against what was actually sent, invented
ones are dropped, and `volume` and `platforms` are counted here from the evidence
that survived — a model that cannot be trusted with ids cannot be trusted to
tally them either.

**Brief** (`lib/agents/brief.ts`) takes the Signal and nothing else. It embeds
the claim, pulls the five nearest `brand_rules` by cosine distance, and asks for
a `Brief`: headline, audience, `angle` (the concept of the video the creator
shoots), `format` (the platform and the run time), up to five `key_messages`, and
the rule ids it actually applied — checked against the ids it was sent, same as
the Analyst's evidence.

**Creative** (`lib/agents/creative.ts`) fans the one angle out into three
`Variant`s, one per treatment — `demo` | `story` | `proof` — in parallel. The
treatments are different skeletons, not different moods: `demo` opens on the
thing being used, `story` drops the viewer mid-scene, `proof` is a side-by-side
test. Each variant carries two or three `hooks`, which are the opening lines the
creator says to camera, and a `body` that is direction for the shoot, beat by
beat. Nothing here is a reply to a commenter.

**Guardian** — the `gate()` half of the same file, a separate call because a
drafter grading its own draft is not a review — checks each variant against
*every* brand rule, not the five the Brief retrieved, because enforcement is not
a similarity search. The model only reports violations; severity decides the
verdict in code: any `block` rule makes it `rejected`, a `warn` rule alone makes
it `needs_human`, none makes it `approved`. Violations naming a rule id that does
not exist are dropped. The worst verdict of the three becomes the campaign's.

If the gate clears everything the campaign parks at `awaiting_approval` and stops.
**Distribution** (`lib/agents/distribution.ts`) only runs after a human decides.
It re-reads the timestamps behind the signal's surviving evidence, buckets them
by hour of day, and takes the peak — arithmetic, in code. The model writes one
thing: the `rationale` sentence that explains the hour it was handed.

Status walks `collecting → signals → brief → variants → approved →
awaiting_approval → scheduled`, with `rejected` and `needs_human` as the gate's
other two ends and `failed` as the one no agent votes for: the run threw. That
last distinction is deliberate — `needs_human` is a decision waiting on a person,
`failed` is a crash waiting on nobody, and the campaign list paints them
differently so a stack trace never lands in someone's review queue. Every
transition is one SSE frame carrying the whole state.

`rate_limited` is split off `failed` for the same reason. Groq's free tier is
8,000 tokens a minute for the whole org, and a run that spends it stops on a 429
its retries could not outlast — nothing about the run was wrong. It is painted
amber rather than red, the banner reads as prose instead of the provider's JSON
(that stays in the trace row, where the org id is not on someone's screen), and
because `start()` skips every stage that already has an output on the state, the
button next to it picks the run back up at the drafts rather than re-running the
analyst and the brief.

### A real run

The corpus is 400 comments under one creator's sneaker unboxing. The densest
cluster of distinct phrasings is people asking to see the shoes *worn* — "an
unworn shoe tells me nothing", "every angle except somebody actually wearing",
"cardboard is cool but where is the fit pic" — lines that share meaning and
almost no words, which is exactly the gap keyword grouping cannot close and
embeddings can. What the Analyst returned:

```
claim:      The post shows the product from every angle but never shows anyone
            actually wearing it.
summary:    Viewers are asking to see the clothing modeled on a person rather
            than just flat shots.
sentiment:  negative      confidence: high
volume:     4 comments    platforms: instagram, tiktok, x
```

And the Brief built from it, with four retrieved brand rules applied:

```
headline:   See the fit in action: watch the piece worn and styled live
audience:   Viewers on Instagram/TikTok wanting to see the clothing modeled on
            a real person
angle:      Creator models the garment on-camera, showing movement and real-world fit
format:     Vertical short-form video for TikTok/Reels (15-30 seconds)
on camera:  I'm wearing the product right now so you can see how it looks on a
            real person
            Here's a close-up of the details and how the fabric drapes when I move
            I'm styling it with a simple outfit to show everyday versatility
            The colour matches exactly what's shown on the product page
            Let me know in the comments what you think about the fit and style
```

Three treatments were drafted off that angle, the gate approved all three, and
the campaign stopped at `awaiting_approval`. `pnpm pipeline` prints the same
walk-through, with the human step auto-granted because there is no human in a
script.

## The human gate

The gate's `approved` is not a decision to publish. It clears or blocks each of
the three variants independently; a person picks the one that ships, and that
choice can go against the gate. `POST /api/campaigns/[id]/approve` takes a
`HumanDecision` — `approve`, `edit` or `reject`, always naming a `variant_id` and
a `reviewed_by` — and records it as an `Approval` with `reviewer: "human"`
alongside the agent's, never replacing it.

Saying yes to a variant the gate blocked is an override, and an override is not
allowed to be quiet. `approve` and `edit` on a variant the gate marked `rejected`
or `needs_human` are rejected with a 400 unless they carry a `reason`, and the
verdict that was overruled is stored on the record in `overrode` — so the audit
trail says *which* verdict was gone against, not merely that something was. A
variant the gate never judged at all counts as blocked for this purpose. The UI
paints an override differently from a plain approve. `reject` never needs an
override: agreeing with the gate is not going against it, though `reason` is
required to reject or edit either way.

`edit` is not a bypass. The human may rewrite `hooks`, `body` and `hashtags`; the
result is re-parsed as a `Variant` and sent back through the gate, because the
rewritten copy is not the copy the gate cleared. If the re-gate blocks it, the
campaign ends at *that* verdict — the human's approve stays on the record next to
the verdict contradicting it, and nothing is scheduled. Only a clean re-gate
reaches Distribution.

## The trace

`agent_events` holds one row per agent run, failed attempts included — the run
that threw is the most interesting row on the page, so nothing is filtered out of
the trace view. The columns (`lib/schema.ts`): `campaign_id` (nullable), `agent`,
`task`, `provider`, `model`, `structured_mode`, `transport_attempts`,
`repair_attempts`, `schema_honored`, `input_hash`, `output`, `tokens`,
`latency_ms`, `error_code`, `error`, `ts`. `campaign_id` is what the view filters
on; without it you are searching by time range, which breaks the moment two runs
overlap.

The run above, as the trace shows it — nine rows for one campaign, three of them
the parallel creative fan-out and three the per-variant gate:

```
agent           task       provider  model                mode    honored  transport  repair    ms
analyst         reasoning  groq      openai/gpt-oss-120b  native  true     0          0       2469
brief           reasoning  groq      openai/gpt-oss-120b  native  true     0          0       2830
creative:demo   drafting   groq      openai/gpt-oss-20b   native  true     0          0       1312
creative:story  drafting   groq      openai/gpt-oss-20b   native  true     0          0       1315
creative:proof  drafting   groq      openai/gpt-oss-20b   native  true     0          0       3697
guardian        reasoning  groq      openai/gpt-oss-120b  native  true     0          0       1577
guardian        reasoning  groq      openai/gpt-oss-120b  native  true     0          0       1694
guardian        reasoning  groq      openai/gpt-oss-120b  native  true     0          0       3204
distribution    drafting   groq      openai/gpt-oss-20b   native  true     0          0        490
```

**`structured_mode` is what was asked for; `schema_honored` is what happened.**
`native` means the JSON Schema derived from the Zod schema was handed to the
provider's own structured-output mechanism; `fallback` means the adapter does not
support one and the schema was injected into the prompt instead. `native` with a
low honored rate is the interesting failure: the provider accepts the schema and
then ignores it.

`schema_honored` is three-valued, because "the model got it wrong" and "there was
nothing to get wrong" are different facts. `true` is an output that validated
first time, `false` an output that existed and failed Zod twice, and **`null` a
run that never produced an output to judge** — the provider abandoned its own
generation, or the call never came back. Only the first two are evidence about
the model, so the honored rate is computed over the non-null rows; counting a
provider's aborted generation as a miss blames the model for the provider's token
budget. `error_code` says which kind of failure it was without anyone parsing
prose: the provider's own code when it sends one (`json_validate_failed`),
`http_<status>` when it does not, `schema_validation_failed` for a Zod failure,
and the error's name for anything else. The full text stays in `error`.

The two retry counters are deliberately separate because they blame different
things. `transport_attempts` counts extra calls caused by 429 and 5xx retries — a
provider capacity problem that says nothing about the model. `repair_attempts`
counts extra calls caused by a Zod validation failure, so it is 0 or 1: one
repair round-trip is all there is. `schema_honored` is `repair_attempts === 0`
and ignores `transport_attempts` entirely — a call that got rate-limited twice
and then validated first time is still an honored schema, and folding the two
together would hide which half of the stack is actually failing.

## Providers

Every model call goes through `lib/llm/provider.ts`; agents declare a semantic
task (`reasoning` | `extraction` | `drafting`) and never a model name. Adding a
provider is one adapter in `lib/llm/adapters/` plus one line in the registry, and
no agent changes.

| Provider | Generation | Embeddings | Notes |
|---|---|---|---|
| `groq` | `openai/gpt-oss-120b` (reasoning, extraction), `openai/gpt-oss-20b` (drafting) | none — the adapter declares no embedding model | Default for `LLM_PROVIDER`. Free tier, no card. Native structured output; rate limits are org-wide. Drafting calls send `reasoning_effort: "low"` — see Known limitations. |
| `gemini` | `gemini-2.5-pro` (reasoning), `gemini-2.5-flash` (extraction, drafting) | `text-embedding-004`, 768 dims | Free tier, no card. Data may be used for training. Native structured output, via an allowlisted OpenAPI subset of the JSON Schema. |
| `ollama` | `qwen2.5:7b-instruct` (all three tasks) | `nomic-embed-text`, 768 dims | Default for `EMBEDDING_PROVIDER`. Local, no limits, no cost, data never leaves the machine. |

**Data rule:** no real user content goes to a free tier that may train on it.
That is why the development corpus is synthetic.

## Environment variables

Everything except `DATABASE_URL` and the active provider's key has a fallback in
code, so a clone with no `.env.local` still runs against a local Postgres and
Groq.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | **required** | Postgres connection string (`lib/db.ts`). |
| `GROQ_API_KEY` | **required for `groq`** | Only read by the Groq adapter. |
| `GEMINI_API_KEY` | **required for `gemini`** | Generation and embeddings. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where the local Ollama server is. |
| `LLM_PROVIDER` | `groq` | `groq` \| `gemini` \| `ollama`. |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` \| `gemini` — Groq serves no embeddings. |
| `EMBEDDING_DIM` | `768` | Width of the pgvector columns, read at import. `embed()` throws if the adapter's width disagrees, because a wrong-width vector is silent corruption. |
| `LLM_CONCURRENCY` | `2` | Cap on in-flight provider calls. Free tiers run 15-30 RPM. |
| `LLM_RETRY_BASE_MS` | `1000` | Backoff base for 429/5xx: 1s, 2s, 4s, three retries. `Retry-After` wins over it. |
| `LLM_MAX_RETRY_WAIT_MS` | `60000` | The longest `Retry-After` we sit through. Above it the 429 comes back out and the campaign parks at `rate_limited` — see below. A TPM window is 60s, so every wait a per-minute limit can ask for is still honoured. |
| `ANALYST_SIMILARITY_THRESHOLD` | `0.7` (fallback in `lib/agents/analyst.ts`) | Cosine cut-off for "same theme". |
| `NEAR_DUPLICATE_THRESHOLD` | `0.9` (fallback in `lib/agents/analyst.ts`) | Above this, two comments count as one wording for cluster density. |

Both thresholds are also set explicitly in `.env.example`, at the same values as
the code defaults. See Known limitations for why they are not portable.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next dev server (Turbopack). |
| `pnpm build` / `pnpm start` | Production build and server. |
| `pnpm lint` | `next lint`. |
| `pnpm db:push` | Push the Drizzle schema to the database. |
| `pnpm db:generate` | Generate a migration from the schema instead of pushing. |
| `pnpm seed` | Replace both corpora: 400 synthetic comments and 12 brand rules. Offline, deterministic, no embeddings. |
| `pnpm embed` | Backfill every `embedding IS NULL` row in `comments` and `brand_rules`. The only step that needs a provider. |
| `pnpm pipeline` | One full run against the real database, one line per transition, then the signal, brief, all three treatments with their hooks, the verdicts and the schedule. Exits non-zero unless it reached `scheduled`. |
| `pnpm test` | `node:test` over the schema, seed, provider, pipeline, live and agent suites. |

## Project structure

```
app/
  page.tsx                 campaign list + the Server Action that starts a run
  campaigns/[id]/          one campaign: server-rendered state and trace…
  campaigns/[id]/live.tsx  …plus the one Client Component: SSE + approval controls
  api/campaigns/           POST to start, [id]/stream for SSE, [id]/approve for the human gate
lib/
  schemas.ts               the Zod schemas — the only source of truth for the data's shape
  schema.ts                Drizzle tables: comments, brand_rules, campaigns, agent_events
  pipeline.ts              the orchestration: start(), decide(), resume(), transitions
  live.ts                  pure helpers shared by the server page and the client component
  seed.ts / embed.ts       synthetic corpus, and the pgvector backfill
  agents/                  analyst, brief, creative (+ gate), distribution, and run.ts
  agents/prompts/          provider-neutral prompts; none describes the output shape
  llm/                     provider.ts (complete/embed), http.ts (retry, limiter)
  llm/adapters/            groq, gemini, ollama — one file each
db/init.sql                CREATE EXTENSION vector, on first boot of the volume
scripts/                   run-pipeline.ts, eval.ts
```

## Known limitations

- **The concurrency limiter is process-local** (`lib/llm/http.ts`). With several
  server instances it does not coordinate, so the effective RPM is multiplied by
  the number of instances. The real fix is a shared token bucket or a queue with
  one worker per provider; out of scope for the demo.
- **`db/init.sql` only runs on an empty volume.** If you created the database
  before that file existed, `docker compose down -v` or run
  `CREATE EXTENSION IF NOT EXISTS vector;` by hand once.
- **The seed corpus is synthetic and fixed** (`SEED` in `lib/seed.ts`). It keeps
  real user content off free tiers that may train on it, and it makes two runs
  comparable. It is also narrower than real comment data: six topics, no other
  languages, no spam.
- **The clustering thresholds are tuned to one embedding model.**
  `ANALYST_SIMILARITY_THRESHOLD` and `NEAR_DUPLICATE_THRESHOLD` (0.70 / 0.90, the
  defaults in `lib/agents/analyst.ts`, mirrored in `.env.example` as the override)
  were measured against this corpus with `nomic-embed-text`. They
  are not portable: at 0.75 nothing but a decorated copy of the same sentence
  falls inside the cut-off, so the densest neighbourhood is whichever line got
  sampled most often and the signal comes out about the video rather than about
  the product. Changing `EMBEDDING_PROVIDER` means measuring them again.
- **The trace view refreshes the whole page.** Each stream frame triggers a
  `router.refresh()`, because `agent_events` is server-rendered and the stream
  only carries `CampaignState`. Fine for one reviewer; a second SSE channel for
  events is the fix if it ever needs more.
- **`pnpm embed` re-embeds nothing, but also detects nothing.** It only fills
  rows where `embedding IS NULL`, so editing a comment's text leaves a stale
  vector behind. Null the column to force a refresh.
- **Approvals live in `campaigns.state.approvals`, a jsonb array on a row that is
  overwritten in place.** Every decision is appended, but the row keeps only the
  latest state, so an `edit` followed by an `approve` leaves the history of that
  campaign as whatever the last write happened to contain — and nothing outside
  the campaign can query "every override this month". The audit trail wants its
  own append-only table with a foreign key, not a field on a mutable row.
- **`openai/gpt-oss-20b` spends most of a completion thinking.** In the runs
  measured here, 85-90% of the completion tokens went to the reasoning channel
  and only the remainder to the JSON. Both share one budget, so a long enough
  deliberation runs out of room before the document closes and Groq answers 400
  `json_validate_failed` — a failure that says nothing about whether the model can
  follow a schema. `reasoning_effort: "low"` on `drafting` (`lib/llm/adapters/groq.ts`)
  buys the answer most of that budget back; it mitigates the ceiling rather than
  removing it, and a long enough brief can still hit it. The 400 is deliberately
  not retried: `json_validate_failed` from a budget overrun is transient, but
  retrying 400s as a class is a door worth measuring before opening.
- **Reasoning tokens count against the org's TPM.** On the free tier that is 8,000
  tokens per minute for the whole organisation, and the invisible reasoning
  channel spends against it like any other token — so the 429 arrives far earlier
  than the size of the visible output suggests. That one *is* retried, with the
  1s/2s/4s backoff.
- **A full run does not fit in Groq's free tier, and no arrangement of the calls
  makes it fit.** Measured per run: analyst and brief ~1.8k tokens each, three
  drafts ~0.8k each, three gate calls ~1.8k each — about 11k against a budget of
  8,000 tokens per minute for the whole org. Concurrency changes when the tokens
  are spent, never how many, so there is no fan-out setting that avoids the 429.
  Serialising `draft()` was tried and measured: `transport_attempts` on every
  `creative:*` row was 0 both ways, so it bought nothing and only lengthened the
  run — the calls are still fanned out.

  Where it lands first is `gate()`'s three concurrent `reasoning` calls, which
  fire right after the drafts have already drained most of the window. That fan-out
  is left as it is for the same reason: serialising it spreads the same 11k over a
  budget that still cannot hold it.

  So `rate_limited` on the free tier is the expected outcome, not a fault. The
  pipeline is built to land there honestly — the run keeps every stage it
  finished, the banner says which budget ran out, and the resume picks up at the
  drafts once the window clears. A tier whose TPM covers a run, or `--delay 60`
  between eval runs, is what makes it go away.
- **`pnpm eval` measures one provider per invocation.** It runs the pipeline `N`
  times (`--runs`, default 3) against whatever `LLM_PROVIDER` is set to, then
  aggregates `agent_events` by provider and model: the `schema_honored` rate over
  the rows it could judge, the unjudged count beside it rather than inside it, the
  `error_code` breakdown, `transport_attempts` and `repair_attempts` separately,
  and p50/p95 for `tokens` and `latency_ms`.

  Comparing providers is two runs and a diff, not one command:

  ```bash
  LLM_PROVIDER=groq   pnpm eval --json > groq.json
  LLM_PROVIDER=gemini pnpm eval --json > gemini.json
  diff <(jq .models groq.json) <(jq .models gemini.json)
  ```

  Firing all three at once would spend the whole org TPM budget on the
  measurement — which is the very thing `transport_attempts` is there to show.
  The corpus is fixed and the runs are sequential so the two files are comparable.

  `--delay` (seconds, default 60) is the pause between runs, and on the free tier
  it is the difference between measuring the model and measuring the rate
  limiter. Three back-to-back runs cost 11 transport retries and lost one run to
  a 429; at `--delay 20` it was still 10 retries and one lost run, because 8,000
  TPM is roughly one run and a partial window does not clear it. At 60 — a full
  window — the same three runs cost 1 retry and lost nothing. Use `--delay 0` on
  a paid tier.

  The eval's campaigns are real rows with `campaigns.is_eval = true`, so the
  campaign list hides them; `/?eval=1` shows them, badged. That flag also settles
  a stale claim in `claude.md`: the column `agent_events.campaign_id` is *not*
  nullable because the eval writes campaign-less events. It doesn't — every
  pipeline run mints a campaign, and the eval scopes its aggregate to the ones it
  just created. Nothing currently writes a null to that column at all.
