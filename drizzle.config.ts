import { defineConfig } from "drizzle-kit";

// ponytail: Node's own env-file loader instead of a dotenv dependency (Node >= 20.12).
process.loadEnvFile?.(".env.local");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

export default defineConfig({
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
});
