# @clifford/tools

Native tool implementations for the Clifford agent platform.

## Overview

This package provides the built-in tools that agents can use to perform various operations. Tools are organized by capability and include comprehensive parameter validation, error handling, and LLM-friendly descriptions.

## Available Tools

### System Tools

#### **system**
System diagnostics and health checks. Use for testing connectivity and debugging tool execution.

**Commands:**
- `system.ping` - Check liveness and timestamp. Returns current ISO-8601 timestamp.

**Example:**
```json
{"name": "system.ping", "args": {}}
```

---

#### **tools**
Tool discovery and descriptions. Use to list available tools or get detailed info about specific tools.

**Commands:**
- `tools.list` - List all tools with short descriptions and command names
- `tools.describe` - Get detailed description, config, and commands for a specific tool

**Examples:**
```json
{"name": "tools.list", "args": {}}
{"name": "tools.describe", "args": {"name": "memory"}}
```

---

### Memory & Storage Tools

#### **memory**
Persistent key-value memory storage for agents. Use for storing user preferences, context across conversations, and agent state.

**Commands:**
- `memory.get` - Retrieve a stored memory value by key
- `memory.put` - Store or update a key-value pair (upsert)
- `memory.search` - Search user memory items by keyword (across module, key, value)
- `memory.sessions` - List past conversation sessions for the current user
- `memory.session_messages` - Fetch messages from a specific session

**Parameter Limits:**
- Keys: 1-255 characters
- Values: max 10,000 characters
- Search query: max 200 characters
- Search limit: 1-50 results (default: 20)

**Examples:**
```json
{"name": "memory.get", "args": {"key": "user_timezone"}}
{"name": "memory.put", "args": {"key": "user_timezone", "value": "America/New_York"}}
{"name": "memory.search", "args": {"query": "vacation", "limit": 10}}
```

---

#### **retrieval**
Vector-based semantic search and document indexing for RAG (Retrieval-Augmented Generation). Powered by OpenAI text-embedding-3-small.

**Commands:**
- `retrieval.search` - Search indexed documents using semantic similarity
- `retrieval.index` - Index content by chunking and embedding
- `retrieval.delete` - Delete all indexed chunks for a source

**Parameter Limits:**
- Search query: 1-500 characters
- Search limit: 1-50 results (default: 10)
- Content to index: 1-100,000 characters
- Source ID: max 500 characters

**Configuration:**
- Requires: `openai_api_key`

**Examples:**
```json
{"name": "retrieval.search", "args": {"query": "authentication flow", "limit": 10, "scope": "agent"}}
{"name": "retrieval.index", "args": {"content": "...", "sourceType": "file", "sourceId": "/docs/api.md"}}
```

---

### Scheduling & Reminders

#### **reminders**
Create and manage time-based reminders with repeat rules. Stored per tenant/agent.

**Commands:**
- `reminders.set` - Create a new reminder (upserts by name)
- `reminders.get` - Fetch reminders, optionally filtered by name
- `reminders.update` - Update an existing reminder's properties
- `reminders.remove` - Delete a reminder by name

**Parameter Limits:**
- Name: 1-200 characters
- Description: max 1000 characters
- Prompt: max 500 characters
- Max reminders: 1-1000 per agent (default: 100)

**Example:**
```json
{
  "name": "reminders.set",
  "args": {
    "reminder": {
      "name": "Weekly review",
      "description": "Plan next week",
      "dueAt": "2026-02-14T09:00:00Z",
      "repeats": true,
      "repeatRule": "weekly",
      "prompt": "Time for the weekly review."
    }
  }
}
```

---

### External Data Tools

#### **weather**
Weather data and forecasts using Open-Meteo API (no API key required). Supports location search and multi-day forecasts.

**Commands:**
- `weather.get` - Retrieve current weather and forecast for a location

**Parameter Limits:**
- Location: max 200 characters
- Forecast days: 1-14 (default: 3)
- Units: "metric" or "imperial"

**Example:**
```json
{"name": "weather.get", "args": {"location": "Bremen, Germany", "days": 5}}
```

---

#### **web** ⭐ NEW
Web search, content fetching, and structured data extraction. Essential for accessing real-time information from the internet.

**Commands:**
- `web.search` - Search the web using DuckDuckGo (no API key required)
- `web.fetch` - Fetch and parse webpage content in text, markdown, or HTML format
- `web.extract` - Extract structured data (links, images, metadata) from webpages

**Parameter Limits:**
- Search query: 1-500 characters
- Search limit: 1-20 results (default: 10)
- URL: max 2000 characters
- Fetch max length: 100-100,000 characters (default: 10,000)
- Timeout: 1-30 seconds (default: 10)

**Examples:**
```json
{"name": "web.search", "args": {"query": "autonomous agents 2024", "limit": 10}}
{"name": "web.fetch", "args": {"url": "https://example.com/article", "format": "markdown"}}
{"name": "web.extract", "args": {"url": "https://example.com", "extractType": "links"}}
```

---

## Tool Architecture

Each tool includes:
- **Comprehensive descriptions** - Written for LLM understanding with usage context
- **Parameter limits** - Min/max constraints in both schema and descriptions
- **Usage examples** - Valid JSON examples that can be copy-pasted
- **Zod validation** - Type-safe parameter validation
- **Classification** - READ/WRITE/DESTRUCT/SENSITIVE for policy enforcement

## Public API

```typescript
import { NATIVE_TOOLS, DEFAULT_TOOLS } from '@clifford/tools';
import { systemTool, memoryTool, webTool } from '@clifford/tools';
```

## Development

```bash
pnpm typecheck    # Type checking
pnpm build        # Build TypeScript
pnpm dev          # Watch mode
```

## Adding New Tools

1. Create tool definition in `src/mytool.ts`
2. Add comprehensive descriptions for LLM context
3. Include parameter limits in both schema and descriptions
4. Provide clear usage examples
5. Export from `src/index.ts`
6. Add to `NATIVE_TOOLS` array
