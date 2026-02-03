# Scheduler Service

Daemon that fires scheduled triggers.

## Responsibilities

- Poll database for due triggers
- Enqueue wake jobs to Redis
- Update next fire times
- Support interval-based triggers (MVP)

## Environment Variables

- `DATABASE_URL` - Postgres connection string
- `REDIS_URL` - Redis connection string
- `SCHEDULER_INTERVAL_MS` - Polling interval (default: 5000ms)

## Development

```bash
pnpm dev
```
