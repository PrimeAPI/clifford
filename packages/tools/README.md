# @clifford/tools

Native tool implementations that ship with Clifford agents.

## Responsibilities
- Provide first-party tools with clear schemas and descriptions.
- Export tool definitions used by the runtime.
- Keep tool behavior deterministic and auditable.

## Public API
- `index.ts`: `DEFAULT_TOOLS`, `NATIVE_TOOLS`, and individual tool exports.
- `memory.ts`: Memory tool definition.
- `retrieval.ts`: External retrieval/search tool definition.
- `system.ts`: System tool definition.
- `reminders.ts`: Reminders tool definition.
- `weather.ts`: Weather tool definition.

## Structure
- `src/index.ts`: Aggregates tool exports.
- `src/*.ts`: Individual tool definitions.

## Usage
```ts
import { NATIVE_TOOLS } from '@clifford/tools';
```

## Development Notes
- Each tool must include a strict schema and description.
- Keep external API calls isolated and rate-limit aware.
