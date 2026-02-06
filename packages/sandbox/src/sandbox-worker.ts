/**
 * Sandbox worker process.
 *
 * This file is executed in a separate Node.js process with resource limits.
 * It receives serialized handler code and executes it in isolation.
 */

interface SandboxRequest {
  type: 'execute';
  handlerCode: string;
  ctx: {
    tenantId: string;
    agentId: string;
    runId: string;
    userId?: string;
    channelId?: string;
    toolConfig?: Record<string, unknown>;
  };
  args: unknown;
}

interface SandboxResponse {
  type: 'result' | 'error';
  result?: unknown;
  error?: string;
  memoryUsedMb?: number;
}

function getMemoryUsage(): number {
  const usage = process.memoryUsage();
  return Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100;
}

function sendResponse(response: SandboxResponse): void {
  if (process.send) {
    process.send(response);
  }
}

// Handle messages from parent
process.on('message', async (message: SandboxRequest) => {
  if (message.type !== 'execute') {
    sendResponse({
      type: 'error',
      error: `Unknown message type: ${message.type}`,
      memoryUsedMb: getMemoryUsage(),
    });
    return;
  }

  try {
    // Create a minimal context with logging stub
    const ctx = {
      ...message.ctx,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      db: null, // Database access not available in sandbox
    };

    // Parse and execute the handler
    // Note: This is a simplified version. In production, you'd want more
    // sophisticated sandboxing (e.g., vm2, isolated-vm, or WebAssembly)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    // Extract function body from serialized handler
    const handlerCode = message.handlerCode;
    type ContextType = typeof ctx;
    let handlerFn: (ctx: ContextType, args: unknown) => Promise<unknown>;

    if (handlerCode.startsWith('async')) {
      // Named or anonymous async function
      handlerFn = new AsyncFunction('ctx', 'args', `
        const handler = ${handlerCode};
        return handler(ctx, args);
      `);
    } else if (handlerCode.includes('=>')) {
      // Arrow function
      handlerFn = new AsyncFunction('ctx', 'args', `
        const handler = ${handlerCode};
        return handler(ctx, args);
      `);
    } else {
      throw new Error('Invalid handler format');
    }

    const result = await handlerFn(ctx, message.args);

    sendResponse({
      type: 'result',
      result,
      memoryUsedMb: getMemoryUsage(),
    });
  } catch (err) {
    sendResponse({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      memoryUsedMb: getMemoryUsage(),
    });
  }

  // Exit after execution
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  sendResponse({
    type: 'error',
    error: `Uncaught exception: ${err.message}`,
    memoryUsedMb: getMemoryUsage(),
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  sendResponse({
    type: 'error',
    error: `Unhandled rejection: ${reason}`,
    memoryUsedMb: getMemoryUsage(),
  });
  process.exit(1);
});

// Timeout if no message received within 5 seconds
setTimeout(() => {
  sendResponse({
    type: 'error',
    error: 'Sandbox worker timeout waiting for message',
    memoryUsedMb: getMemoryUsage(),
  });
  process.exit(1);
}, 5000);
