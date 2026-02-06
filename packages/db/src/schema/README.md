# Database Schema

One-file-per-table definitions for Clifford's database schema.

## Responsibilities
- Define tables, columns, and relations.
- Export a single index for consumers.

## Structure
- Each file defines and exports one table.
- `index.ts` re-exports all tables.

## Editing Guidelines
- Keep column names/types explicit.
- Add migrations when changing table structure.
- Favor small, focused files over monoliths.
