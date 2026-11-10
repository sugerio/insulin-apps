/**
 * Drizzle Kit configuration for authoring migrations: edit src/app/db/schema.ts,
 * then run `npm run db:generate`. Deployment applies the generated migrations to
 * the app's Cloudflare D1 database before the new version serves traffic; the
 * AppBuilder preview applies them to its local SQLite file.
 *
 * A plain object (no drizzle-kit import) so the project installs without it.
 */
export default {
  dialect: "sqlite",
  schema: "./src/app/db/schema.ts",
  out: "./src/app/db/migrations",
};
