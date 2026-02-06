# Database Package Source

This folder contains the runtime database wiring and schema exports.

## Structure
- `client.ts`: Creates the Drizzle client used by services.
- `schema/`: Table definitions and schema exports.
- `migrate.ts`: Migration entry point for CLI tools.

## Guidelines
- Keep schema changes isolated to `schema/` and accompany with migrations.
- Prefer clear, explicit column definitions to avoid implicit defaults.
