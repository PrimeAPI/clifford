# Discord Gateway Service

Discord.js bot that forwards events to the API.

## Responsibilities

- Maintain Discord Gateway connection
- Receive Discord events
- Forward events to API server
- Does NOT process events or call LLMs

## Environment Variables

- `DISCORD_BOT_TOKEN` - Discord bot token (optional, disables if not set)
- `NEXT_PUBLIC_API_URL` - API server URL
- `TENANT_ID` - Tenant ID for events

## Development

```bash
pnpm dev
```

If `DISCORD_BOT_TOKEN` is not set, the service will exit gracefully.
