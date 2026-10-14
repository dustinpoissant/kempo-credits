import { defineConfig } from 'drizzle-kit';

/*
  Test databases only — this extension has no migrations of its own in production. Its tables are
  created the real way at install time, by kempo's createTablesFromSchema plus install.js.

  It lists every table the suites touch: this extension's, kempo's own, kempo-payments' (a purchase
  creates a payment row) and kempo-tax's (a taxed purchase saves a quote). The unit tier builds its
  in-memory database from this list, and `npx drizzle-kit push` builds the integration tier's from it.

  No dotenv here on purpose. DATABASE_URL needs to be a real environment variable.
*/
export default defineConfig({
  schema: [
    './server/db/schema.js',
    './node_modules/kempo/server/db/schema.js',
    './node_modules/kempo-payments/server/db/schema.js',
    './node_modules/kempo-tax/server/db/schema.js',
  ],
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
