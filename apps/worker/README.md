# Worker Service

BullMQ worker for processing runs.

## Responsibilities

- Claim jobs from Redis queue
- Load agent plugins
- Execute LLM calls (stubbed in MVP)
- Execute tool calls via plugin system
- Write run steps to database
- Enforce policy decisions
- Stateless after job completion

## Environment Variables

- `DATABASE_URL` - Postgres connection string
- `REDIS_URL` - Redis connection string
- `WORKER_CONCURRENCY` - Number of concurrent jobs (default: 5)

## Development

```bash
pnpm dev
```
