import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// ponytail: one module-level pool. Next reuses the module per server instance;
// add a globalThis cache if dev HMR starts leaking connections.
export const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), {
  schema,
});
