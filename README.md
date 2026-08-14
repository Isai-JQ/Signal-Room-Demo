# Signal-Room-Demo

Multi-agent pipeline that turns raw social comments into approved campaign briefs. Typed state handoffs between agents, Zod-validated LLM outputs, RAG over brand rules, and a human approval gate. Next.js · TypeScript · Postgres + pgvector

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

## Known limitations

- **The concurrency limiter is process-local** (`lib/llm/http.ts`). With several
  server instances it does not coordinate, so the effective RPM is multiplied by
  the number of instances. The real fix is a shared token bucket or a queue with
  one worker per provider; out of scope for the demo.
- **`db/init.sql` only runs on an empty volume.** If you created the database
  before that file existed, `docker compose down -v` or run
  `CREATE EXTENSION IF NOT EXISTS vector;` by hand once.
- **The seed corpus is synthetic and fixed** (`SEED` in `lib/seed.ts`). That is
  what makes `pnpm eval` comparable across providers, and it keeps real user
  content off free tiers that may train on it. It is also narrower than real
  comment data: six topics, no other languages, no spam.
- **`pnpm embed` re-embeds nothing, but also detects nothing.** It only fills
  rows where `embedding IS NULL`, so editing a comment's text leaves a stale
  vector behind. Null the column to force a refresh.
