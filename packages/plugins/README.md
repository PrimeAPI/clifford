# @clifford/plugins

Plugin registry for optional tool bundles.

## Responsibilities
- Register plugins by name.
- Provide lookup and list utilities for runtime consumption.
- Keep registry operations synchronous and side-effect free.

## Public API
- `registerPlugin(name, plugin)`: Adds a plugin to the registry.
- `getPlugin(name)`: Retrieves a plugin by name.
- `getAllPlugins()`: Lists all registered plugins.

## Structure
- `src/index.ts`: In-memory registry and accessors.

## Usage
```ts
import { registerPlugin, getAllPlugins } from '@clifford/plugins';
```

## Development Notes
- Plugins should be registered during startup.
- Avoid dynamic imports inside the registry.
