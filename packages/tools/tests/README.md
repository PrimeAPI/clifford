# Testing Guide

## Overview

The tools package includes comprehensive test coverage with:
- **Unit tests**: Test tool logic in isolation with mocked dependencies
- **Integration tests**: Test against real external APIs to verify they still work as expected

## Quick Start

```bash
# Run all tests
pnpm test

# Run only unit tests (fast, no external calls)
pnpm test:unit

# Run only integration tests (slow, makes real API calls)
pnpm test:integration

# Watch mode for development
pnpm test:watch

# Visual UI for debugging
pnpm test:ui
```

## Test Structure

```
tests/
├── unit/               # Unit tests with mocked dependencies
│   ├── system.test.ts
│   ├── memory.test.ts
│   ├── web.test.ts
│   ├── reminders.test.ts
│   ├── weather.test.ts
│   └── retrieval.test.ts
├── integration/        # Integration tests with real API calls
│   ├── web.test.ts     # DuckDuckGo, HTTP fetching
│   ├── weather.test.ts # Open-Meteo API
│   └── retrieval.test.ts # OpenAI embeddings
├── fixtures/           # Test data and fixtures
└── test-utils.ts       # Shared test utilities and mocks
```

## Environment Setup

### For Integration Tests

Copy `.env.test.example` to `.env.test` and configure:

```bash
cp .env.test.example .env.test
```

Edit `.env.test`:

```bash
# Required for retrieval integration tests
OPENAI_API_KEY=sk-...

# Optional: Skip integration tests entirely
TEST_SKIP_INTEGRATION=false

# Optional: Adjust test timeout (in milliseconds)
TEST_TIMEOUT=30000
```

**Note**: Integration tests will skip automatically if required credentials are missing.

## Unit Tests

Unit tests mock all external dependencies:
- Database calls use `createMockDb()`
- HTTP requests use `mockGlobalFetch()`
- Context uses `createMockContext()`

**What we test**:
- ✓ Tool metadata (name, commands, descriptions)
- ✓ Parameter validation (Zod schemas)
- ✓ Command classifications (READ/WRITE/DESTRUCT)
- ✓ Configuration schemas
- ✓ Error handling
- ✓ Return value structures

**Example**:
```typescript
import { systemTool } from '../../src/system.js';
import { createMockContext } from '../test-utils.js';

const ctx = createMockContext();
const pingCommand = systemTool.commands.find((c) => c.name === 'ping');
const result = await pingCommand!.handler(ctx, {});

expect(result).toHaveProperty('ok', true);
expect(result).toHaveProperty('ts');
```

## Integration Tests

Integration tests make **REAL** HTTP requests to external services:
- DuckDuckGo web search
- Open-Meteo weather API
- OpenAI embeddings API
- Real webpage fetching

**What we test**:
- ✓ External APIs still work as expected
- ✓ Response formats haven't changed
- ✓ Error handling for real failures (404, timeout, etc.)
- ✓ Edge cases (no results, invalid data, etc.)

**Example**:
```typescript
it('should fetch real weather for a city', async () => {
  const result = await getCommand!.handler(ctx, {
    location: 'London, UK',
    days: 3,
  });

  expect(result).toHaveProperty('location');
  expect(result).toHaveProperty('daily');
  
  // Verify API structure hasn't changed
  const daily = (result as any).daily;
  expect(daily[0]).toHaveProperty('tempMin');
  expect(daily[0]).toHaveProperty('tempMax');
}, 30000); // 30s timeout
```

## Test Utilities

### `createMockContext(overrides?)`
Creates a mock ToolContext with all required fields:
```typescript
const ctx = createMockContext({
  userId: 'custom-user-id',
  toolConfig: { some: 'config' },
});
```

### `createMockDb()`
Creates a mock database with chainable Drizzle ORM methods:
```typescript
const mockDb = createMockDb();
mockDb.select.mockReturnThis();
mockDb.where.mockReturnThis();
mockDb.limit.mockResolvedValue([{ id: '1', value: 'test' }]);
```

### `mockGlobalFetch(implementation)`
Mocks the global `fetch` function:
```typescript
mockGlobalFetch(async () => createMockFetchResponse('<html>...</html>'));
```

### `createMockLogger()`
Creates a mock logger with spy functions:
```typescript
const logger = createMockLogger();
// ... do something ...
expect(logger.info).toHaveBeenCalledWith('Message', { data: 'value' });
```

## Running Tests

### Run All Tests
```bash
pnpm test
```

### Run Unit Tests Only (Fast)
```bash
pnpm test:unit
```
- No external API calls
- Runs in <1 second
- Safe to run in CI without credentials

### Run Integration Tests Only
```bash
pnpm test:integration
```
- Makes real HTTP requests
- Requires internet connection
- May be rate-limited
- Some require API keys (.env.test)

### Watch Mode (Development)
```bash
pnpm test:watch
```
- Reruns tests on file changes
- Great for TDD workflow

### Visual UI
```bash
pnpm test:ui
```
- Opens browser-based test UI
- Shows test results, coverage, and console output
- Best for debugging

## Coverage

Generate coverage reports:
```bash
pnpm test --coverage
```

View HTML coverage report:
```bash
open coverage/index.html
```

## CI/CD Integration

In CI environments, you typically want to:

1. **Always run unit tests** (fast, no dependencies)
2. **Optionally run integration tests** (slow, may need credentials)

Example GitHub Actions:

```yaml
- name: Run unit tests
  run: pnpm test:unit

- name: Run integration tests
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: pnpm test:integration
```

## Test Guidelines

### Unit Tests

1. **Mock all external dependencies**
   - Use `createMockDb()` for database
   - Use `mockGlobalFetch()` for HTTP
   - Never make real API calls

2. **Test behavior, not implementation**
   - Test what the tool returns
   - Don't test internal implementation details

3. **Test edge cases**
   - Empty inputs
   - Max/min limits
   - Invalid data
   - Error conditions

### Integration Tests

1. **Test against real APIs**
   - No mocking
   - Verify actual responses

2. **Verify API contracts**
   - Check response structure
   - Validate data types
   - Ensure expected fields exist

3. **Handle failures gracefully**
   - Network timeouts
   - Rate limiting
   - API changes

4. **Use realistic timeouts**
   - Default: 30 seconds
   - Adjust per test if needed

## Debugging Tests

### Failed Unit Test

```bash
# Run specific test file
pnpm vitest tests/unit/web.test.ts

# Run specific test
pnpm vitest tests/unit/web.test.ts -t "should validate URL"

# Use UI for debugging
pnpm test:ui
```

### Failed Integration Test

1. Check internet connection
2. Verify API credentials in `.env.test`
3. Check if external API is down (try manually)
4. Check rate limits
5. Run with increased timeout if needed

## Current Test Status

**Unit Tests**: 50/66 passing (76%)
- System: 11/12 ✓
- Memory: 12/19 (needs ctx.db fix)
- Web: 20/21 ✓
- Reminders: 7/14 (needs ctx.db fix)
- Tools: TODO
- Weather: TODO
- Retrieval: TODO

**Integration Tests**: Ready
- Web: 9 tests (DuckDuckGo, HTTP fetching)
- Weather: 9 tests (Open-Meteo API)
- Retrieval: TODO (OpenAI embeddings)

## Known Issues

1. **DB Mocking**: Some tools call `getDb()` directly instead of using `ctx.db`
   - Affects: memory, reminders
   - Fix: Refactor to use `ctx.db`

2. **Schema Edge Cases**: Zod doesn't reject extra fields by default
   - Affects: system.ping, web.fetch
   - Fix: Use `.strict()` on schemas or update tests

## Future Improvements

- [ ] Add performance benchmarks
- [ ] Add load testing for concurrent requests
- [ ] Add snapshot testing for complex outputs
- [ ] Add visual regression tests for error messages
- [ ] Mock time/dates for deterministic tests
