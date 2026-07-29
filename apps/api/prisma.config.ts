import 'dotenv/config';

import { defineConfig } from 'prisma/config';

// Prisma 7 reads the connection URL from here rather than from the schema's
// datasource block. `dotenv/config` loads apps/api/.env — the Prisma CLI does
// not do it for you.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
