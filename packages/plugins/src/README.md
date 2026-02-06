# Plugin Registry Source

In-memory plugin registry used by the runtime.

## Structure
- `index.ts`: Registry storage and accessors.

## Guidelines
- Keep registry operations synchronous.
- Avoid side effects beyond storing plugin references.
