# Clifford

Autonomous agent platform built with TypeScript, Node.js, and modern web technologies.

## Architecture

- **Monorepo** (pnpm workspaces + Turborepo)
- **TypeScript + Node.js (ESM)** end-to-end
- **Postgres** (System of Record)
- **Redis** (BullMQ queues + locks)
- **MinIO** (S3-compatible file storage)
- **Architecture spec**: see `docs/architecture.md`

### Services (apps)

1. **api** - Control plane: handles requests, auth, configs, enqueues jobs
2. **worker** - Data plane: processes jobs, executes LLM calls and tools
3. **scheduler** - Trigger service: fires scheduled tasks
4. **discord-gateway** - Discord bot gateway (optional)
5. **web** - Next.js admin UI

### Packages

- **sdk** - Shared types and contracts
- **policy** - Policy engine (allow/deny/confirm decisions)
- **db** - Database client and schema (Drizzle ORM)
- **tools** - Built-in tools (system.ping, memory.put/get)

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm
- Docker & Docker Compose

### 1. Clone and Install

```bash
git clone <your-repo>
cd clifford
pnpm install
```

### 2. Start Infrastructure

```bash
docker compose up -d
```

This starts:
- Postgres on port 5433
- Redis on port 6379
- MinIO on ports 9000/9001

### 3. Setup Environment

```bash
cp .env.example .env
# Edit .env if needed
```

### 4. Run Migrations

```bash
pnpm db:generate
pnpm db:migrate
```

### 5. Seed Database (Optional)

```bash
node scripts/seed.js
```

### 6. Start Development

```bash
pnpm dev
```

This starts:
- API server on http://localhost:3000
- Worker (background process)
- Scheduler (background process)
- Web UI on http://localhost:3001

## Usage Examples

### Create a Run

```bash
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000000" \
  -d '{
    "agentId": "00000000-0000-0000-0000-000000000001",
    "inputText": "ping"
  }'
```

Response:
```json
{
  "runId": "abc123",
  "status": "pending"
}
```

### Get Run Details

```bash
curl http://localhost:3000/api/runs/abc123
```

### Stream Run Updates (SSE)

```bash
curl -N http://localhost:3000/api/runs/abc123/stream
```

## Project Structure

```
clifford/
├── apps/
│   ├── api/              # Fastify API server
│   ├── worker/           # BullMQ worker
│   ├── scheduler/        # Trigger scheduler
│   ├── discord-gateway/  # Discord bot
│   └── web/              # Next.js UI
├── packages/
│   ├── sdk/              # Shared types
│   ├── policy/           # Policy engine
│   ├── db/               # Database client
│   └── tools/            # Built-in tools
├── docker-compose.yml    # Infrastructure
├── package.json          # Root config
├── pnpm-workspace.yaml   # Workspace config
└── turbo.json            # Turbo pipeline
```

## Development

### Scripts

- `pnpm dev` - Start all services in watch mode
- `pnpm build` - Build all packages and apps
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm lint` - Run ESLint
- `pnpm test` - Run tests
- `pnpm db:generate` - Generate Drizzle migrations
- `pnpm db:migrate` - Run database migrations

### Adding a New Tool

1. Create a new file in `packages/tools/src/`
2. Define the tool using the `ToolDef` interface
3. Export it from `packages/tools/src/index.ts`

### Creating a Plugin

1. Create a new package
2. Implement the `Plugin` interface from `@clifford/sdk`
3. Export tools via the plugin interface

## License

AGPLv3
