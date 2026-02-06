# @clifford/core

Shared, low-level utilities used across Clifford apps and packages.

## Responsibilities
- Provide stable crypto helpers for secret storage.
- Centralize cross-service constants like queue names.
- Stay dependency-light and platform-agnostic.

## Public API
- `crypto.ts`: `encryptSecret`, `decryptSecret` AES-256-GCM helpers.
- `constants.ts`: Queue name constants used by BullMQ workers and producers.

## Structure
- `src/crypto.ts`: Encryption/decryption helpers.
- `src/constants.ts`: Shared constants.

## Usage
```ts
import { encryptSecret, decryptSecret, QUEUE_RUNS } from '@clifford/core';
```

## Development Notes
- Keep this package minimal and broadly reusable.
- Avoid app-specific dependencies or configuration.
