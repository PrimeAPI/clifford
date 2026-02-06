# @clifford/db

Database layer for Clifford, built on Drizzle ORM.

## Responsibilities
- Define and export database schema and tables.
- Provide database client initialization helpers.
- Offer migration entry points for CLI workflows.

## Public API
- `client.ts`: `getDb` and client helpers.
- `schema/index.ts`: Re-exports all tables.
- `migrate.ts`: Migration entry point.

## Structure
- `src/client.ts`: Database client wiring.
- `src/schema/`: One-file-per-table schema definitions.
- `src/migrate.ts`: Migration support.

## Usage
```ts
import { getDb, users, runs } from '@clifford/db';
```

## Development Notes
- Keep table definitions explicit and scoped to a single file.
- Add migrations for any schema changes.
- Prefer additive changes to avoid breaking consumers.
