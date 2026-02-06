# Run Harness

This harness sends real API messages and verifies runs complete with non-empty output.

## Usage

```bash
npx tsx scripts/run-harness.ts
```

## Environment

- `HARNESS_BASE_URL` (default `http://localhost:3000`)
- `HARNESS_USER_ID` (default demo user id)
- `HARNESS_TENANT_ID` (default demo tenant id)
- `HARNESS_CASES_PATH` (default `scripts/run-harness-cases.json`)
- `HARNESS_TIMEOUT_MS` (default `60000`)
- `HARNESS_POLL_MS` (default `1500`)

## Notes
- The API server and worker must be running.
- The harness queries the database for the run created after each message.
