-- Runs once, on an empty pgdata volume. drizzle-kit does not emit this, and
-- `db:push` fails without it because the tables declare vector columns.
CREATE EXTENSION IF NOT EXISTS vector;
