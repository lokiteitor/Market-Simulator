import { defineConfig } from "drizzle-kit";

// drizzle-kit NO genera migraciones en v1 (el DDL lo aplica Postgres desde
// docs/schema.sql vía docker-entrypoint-initdb.d); este archivo existe para
// tooling futuro (drizzle-kit studio/introspect/generate).
// Nota: drizzle-kit exige default export en su archivo de configuración; es la
// única excepción a la regla de named-exports del proyecto.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://market:market@localhost:5432/market",
  },
});
