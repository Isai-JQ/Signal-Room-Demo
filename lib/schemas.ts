// The only source of truth for the shape of the data (claude.md). Prompts never
// describe structure by hand — the JSON Schema is derived from these.
//
// Everything here is JSON-primitive: CampaignState is stored as jsonb and comes
// back out of Postgres as plain JSON, so timestamps are ISO strings, not Date.
import { z } from "zod";

// Where a creator actually posts an unboxing. `platform` is a text column, not a
// pg enum, so this list is the only gate — nothing to migrate when it changes.
export const Platform = z.enum(["instagram", "tiktok", "x", "youtube"]);

export const Comment = z.object({
  id: z.string().min(1),
  platform: Platform,
  author: z.string().min(1),
  text: z.string().min(1),
  posted_at: z.string().datetime(),
});

/** A theme several comments share. Produced by the extraction agent. */
export const Signal = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1),
  sentiment: z.enum(["positive", "negative", "neutral", "mixed"]),
  comment_ids: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
});

export const Brief = z.object({
  headline: z.string().min(1),
  audience: z.string().min(1),
  angle: z.string().min(1),
  key_messages: z.array(z.string().min(1)).min(1).max(5),
  signal_ids: z.array(z.string().min(1)).min(1),
});

export const Variant = z.object({
  id: z.string().min(1),
  platform: Platform,
  body: z.string().min(1),
  hashtags: z.array(z.string().min(1)).max(10).default([]),
});

export const Approval = z.object({
  variant_id: z.string().min(1),
  verdict: z.enum(["approved", "rejected", "needs_human"]),
  violations: z
    .array(z.object({ rule_id: z.string().min(1), detail: z.string().min(1) }))
    .default([]),
  reviewer: z.enum(["agent", "human"]).default("agent"),
});

export const Schedule = z.object({
  variant_id: z.string().min(1),
  publish_at: z.string().datetime(),
  timezone: z.string().min(1).default("UTC"),
});

/** Also a column on `campaigns` so the pipeline can filter without opening the jsonb. */
export const CampaignStatus = z.enum([
  "collecting",
  "signals",
  "brief",
  "variants",
  "approval",
  "scheduled",
  "needs_human",
]);

/** The only thing agents pass each other (claude.md). Never free text. */
export const CampaignState = z.object({
  campaign_id: z.string().uuid(),
  status: CampaignStatus,
  comments: z.array(Comment).default([]),
  signals: z.array(Signal).default([]),
  brief: Brief.nullable().default(null),
  variants: z.array(Variant).default([]),
  approvals: z.array(Approval).default([]),
  schedule: z.array(Schedule).default([]),
});

export type Platform = z.infer<typeof Platform>;
export type Comment = z.infer<typeof Comment>;
export type Signal = z.infer<typeof Signal>;
export type Brief = z.infer<typeof Brief>;
export type Variant = z.infer<typeof Variant>;
export type Approval = z.infer<typeof Approval>;
export type Schedule = z.infer<typeof Schedule>;
export type CampaignStatus = z.infer<typeof CampaignStatus>;
export type CampaignState = z.infer<typeof CampaignState>;
