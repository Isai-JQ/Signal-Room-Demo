// The only way an agent reaches a model. claude.md: every agent run writes a row
// to agent_events, failed attempts included.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { db as Db } from "../db";
import {
  SchemaValidationError,
  adapterFor,
  complete,
  llmProvider,
  modelFor,
  type Task,
} from "../llm/provider";
import { agent_events } from "../schema";

export async function runAgent<T>({
  db,
  agent,
  task,
  system,
  prompt,
  schema,
  campaign_id = null,
}: {
  db: typeof Db;
  agent: string;
  task: Task;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  campaign_id?: string | null;
}): Promise<T> {
  const provider = llmProvider();
  const started = Date.now();
  const base = {
    campaign_id,
    agent,
    task,
    provider,
    model: modelFor(task, provider),
    input_hash: createHash("sha256").update(`${system}\n${prompt}`).digest("hex"),
  };

  try {
    const out = await complete({ task, system, prompt, schema, provider });
    await db.insert(agent_events).values({
      ...base,
      structured_mode: out.structured_mode,
      transport_attempts: out.transport_attempts,
      repair_attempts: out.repair_attempts,
      schema_honored: out.schema_honored,
      output: out.data,
      latency_ms: Date.now() - started,
    });
    return out.data;
  } catch (err) {
    // ponytail: complete() throws instead of handing back its counters, so a
    // failed run logs what can be inferred — transport_attempts stays 0. Carry
    // the counters on the error if the eval ever needs them exact for failures.
    await db.insert(agent_events).values({
      ...base,
      structured_mode: adapterFor(provider).supportsStructuredOutput ? "native" : "fallback",
      repair_attempts: err instanceof SchemaValidationError ? 1 : 0,
      schema_honored: false,
      latency_ms: Date.now() - started,
      error: String(err),
    });
    throw err;
  }
}
