# @clifford/policy

Policy engine for tool execution decisions.

## Responsibilities
- Decide whether tool calls are allowed, confirmed, or denied.
- Provide budget enforcement hooks.
- Default to safe, conservative behavior.

## Public API
- `PolicyEngine`: Decision engine for tool calls.
- `createBudgetState`: Budget tracking stub.

## Structure
- `src/engine.ts`: Policy engine logic.
- `src/index.ts`: Export surface.

## Usage
```ts
import { PolicyEngine } from '@clifford/policy';
```

## Development Notes
- Keep decisions explicit and predictable.
- Budget logic should remain deterministic and testable.
