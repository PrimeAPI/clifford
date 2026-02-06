# @clifford/sdk

Shared TypeScript types and job payloads used across Clifford services.

## Responsibilities
- Define stable domain types for tools, policies, and agents.
- Define BullMQ job payload shapes.
- Provide shared type utilities across services.

## Public API
- `types.ts`: Tool, policy, and domain type definitions.
- `jobs.ts`: Queue job payload types.

## Structure
- `src/types.ts`: Core domain types.
- `src/jobs.ts`: Job payloads for queues.
- `src/index.ts`: Export surface.

## Usage
```ts
import type { RunJob, ToolDef } from '@clifford/sdk';
```

## Development Notes
- Prefer additive changes to avoid breaking consumers.
- Keep types serializable and transport-safe.
