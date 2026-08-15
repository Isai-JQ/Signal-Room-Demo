import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import type { StructuredMode, Task } from "./llm/provider";
import type { CampaignState, CampaignStatus, Platform } from "./schemas";

// claude.md: the vector width comes from EMBEDDING_DIM, never a literal. A
// mismatch between column and adapter is silent corruption, so fail at import.
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 768);
if (!Number.isInteger(EMBEDDING_DIM) || EMBEDDING_DIM <= 0) {
  throw new Error(`EMBEDDING_DIM must be a positive integer, got "${process.env.EMBEDDING_DIM}"`);
}

const embedding = () => vector("embedding", { dimensions: EMBEDDING_DIM });

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").$type<Platform>().notNull(),
    author: text("author").notNull(),
    text: text("text").notNull(),
    posted_at: timestamp("posted_at", { withTimezone: true }).notNull(),
    // Null until the embedding job runs.
    embedding: embedding(),
    ingested_at: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("comments_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops"))],
);

export const brand_rules = pgTable(
  "brand_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rule: text("rule").notNull(),
    severity: text("severity").$type<"block" | "warn">().notNull().default("block"),
    embedding: embedding(),
  },
  (t) => [index("brand_rules_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops"))],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Duplicated out of `state` on purpose: filtering the pipeline shouldn't
    // have to unpack the jsonb. CampaignState.status stays authoritative.
    status: text("status").$type<CampaignStatus>().notNull().default("collecting"),
    state: jsonb("state").$type<CampaignState>().notNull(),
    // `pnpm eval` runs the real pipeline, so its campaigns are real rows. They
    // are still measurement, not demo: the list hides them unless asked.
    is_eval: boolean("is_eval").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("campaigns_status_idx").on(t.status)],
);

// claude.md/Observability: one row per agent run, failed attempts included.
export const agent_events = pgTable(
  "agent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaign_id: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    task: text("task").$type<Task>().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    structured_mode: text("structured_mode").$type<StructuredMode>().notNull(),
    /** Extra calls from 429/5xx retries — a provider capacity problem. */
    transport_attempts: integer("transport_attempts").notNull().default(0),
    /** Extra calls from Zod repair round-trips. 0 or 1. */
    repair_attempts: integer("repair_attempts").notNull().default(0),
    /**
     * Whether the model satisfied its schema first time (`repair_attempts === 0`),
     * independent of transport_attempts on purpose.
     *
     * Null when there was never an output to judge: the provider aborted its own
     * generation, or the call never came back. False is reserved for output that
     * existed and failed Zod — folding the two together makes a provider's 400
     * look like a model that ignores schemas.
     */
    schema_honored: boolean("schema_honored"),
    input_hash: text("input_hash").notNull(),
    output: jsonb("output"),
    tokens: integer("tokens"),
    latency_ms: integer("latency_ms").notNull(),
    /** Short cause, machine-groupable: `json_validate_failed`, `http_500`, `schema_validation_failed`. */
    error_code: text("error_code"),
    error: text("error"),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  // `pnpm eval` aggregates the schema_honored rate by provider and model, over
  // the non-null rows only.
  (t) => [index("agent_events_provider_model_idx").on(t.provider, t.model)],
);
