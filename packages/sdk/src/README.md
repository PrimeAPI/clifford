# SDK Source

Type definitions and job payloads shared across services.

## Structure
- `types.ts`: Domain types and tool definitions.
- `jobs.ts`: BullMQ job payload types.
- `index.ts`: Export surface.

## Guidelines
- Keep types stable and backward-compatible.
- Avoid runtime logic in the SDK.
