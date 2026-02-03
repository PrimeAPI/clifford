# API Service

Fastify-based control plane for Clifford.

## Responsibilities

- Accept requests from clients
- Manage auth, configs, sessions
- Enqueue jobs to Redis queues
- Does NOT call external services or LLMs directly

## Endpoints

- `GET /healthz` - Health check
- `POST /api/runs` - Create a new run
- `GET /api/runs/:id` - Get run details
- `GET /api/runs/:id/stream` - SSE stream of run updates
- `POST /api/events/discord` - Receive Discord events

## Environment Variables

- `API_PORT` - Port to listen on (default: 3000)
- `API_HOST` - Host to bind to (default: 0.0.0.0)
- `DATABASE_URL` - Postgres connection string
- `REDIS_URL` - Redis connection string

## Development

```bash
pnpm dev
```
