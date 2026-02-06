import { fork, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { ToolContext } from '@clifford/sdk';

/**
 * Configuration for the sandbox execution environment.
 */
export interface SandboxConfig {
  /** Maximum execution time in milliseconds (default: 30000) */
  timeout: number;
  /** Maximum memory in MB (default: 256) */
  memoryLimit: number;
  /** Network access policy (default: 'deny') */
  networkPolicy: 'allow' | 'deny';
  /** Whether to allow file system access (default: false) */
  allowFileSystem: boolean;
}

/**
 * Default sandbox configuration.
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  timeout: 30000,
  memoryLimit: 256,
  networkPolicy: 'deny',
  allowFileSystem: false,
};

/**
 * Result from sandbox execution.
 */
export interface SandboxResult<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
  executionTimeMs: number;
  memoryUsedMb?: number;
}

/**
 * Message sent to the sandbox worker.
 */
interface SandboxRequest {
  type: 'execute';
  handlerCode: string;
  ctx: SerializableContext;
  args: unknown;
}

/**
 * Response from the sandbox worker.
 */
interface SandboxResponse {
  type: 'result' | 'error';
  result?: unknown;
  error?: string;
  memoryUsedMb?: number;
}

/**
 * Serializable version of ToolContext for IPC.
 */
interface SerializableContext {
  tenantId: string;
  agentId: string;
  runId: string;
  userId?: string;
  channelId?: string;
  toolConfig?: Record<string, unknown>;
}

/**
 * Sanitize ToolContext for serialization (remove non-serializable parts).
 */
function sanitizeContext(ctx: ToolContext): SerializableContext {
  return {
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    userId: ctx.userId,
    channelId: ctx.channelId,
    toolConfig: ctx.toolConfig,
  };
}

/**
 * Process-based sandbox for executing untrusted tool handlers.
 *
 * Uses Node.js child processes with resource limits to isolate tool execution.
 * Each execution runs in a fresh process that is terminated after completion.
 */
export class ProcessSandbox extends EventEmitter {
  private config: SandboxConfig;

  constructor(config?: Partial<SandboxConfig>) {
    super();
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /**
   * Execute a handler function in an isolated sandbox.
   *
   * @param handler - The handler function to execute (serialized as string)
   * @param ctx - Tool context (will be sanitized for IPC)
   * @param args - Arguments to pass to the handler
   * @returns Promise resolving to the execution result
   */
  async execute<T>(
    handler: (ctx: SerializableContext, args: unknown) => Promise<T>,
    ctx: ToolContext,
    args: unknown
  ): Promise<SandboxResult<T>> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      let child: ChildProcess | null = null;
      let timeoutId: NodeJS.Timeout | null = null;
      let resolved = false;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (child && !child.killed) {
          child.kill('SIGKILL');
        }
      };

      const finish = (result: SandboxResult<T>) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      try {
        // Spawn child process with memory limits
        child = fork(new URL('./sandbox-worker.js', import.meta.url).pathname, {
          execArgv: [`--max-old-space-size=${this.config.memoryLimit}`],
          timeout: this.config.timeout,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            SANDBOX_NETWORK_POLICY: this.config.networkPolicy,
            SANDBOX_ALLOW_FS: this.config.allowFileSystem ? '1' : '0',
          },
        });

        // Set execution timeout
        timeoutId = setTimeout(() => {
          finish({
            success: false,
            error: `Execution timeout after ${this.config.timeout}ms`,
            executionTimeMs: Date.now() - startTime,
          });
        }, this.config.timeout);

        // Handle messages from child
        child.on('message', (message: SandboxResponse) => {
          if (message.type === 'result') {
            finish({
              success: true,
              result: message.result as T,
              executionTimeMs: Date.now() - startTime,
              memoryUsedMb: message.memoryUsedMb,
            });
          } else if (message.type === 'error') {
            finish({
              success: false,
              error: message.error,
              executionTimeMs: Date.now() - startTime,
              memoryUsedMb: message.memoryUsedMb,
            });
          }
        });

        // Handle child errors
        child.on('error', (err) => {
          finish({
            success: false,
            error: `Sandbox process error: ${err.message}`,
            executionTimeMs: Date.now() - startTime,
          });
        });

        // Handle child exit
        child.on('exit', (code, signal) => {
          if (!resolved) {
            finish({
              success: false,
              error: `Sandbox process exited unexpectedly (code: ${code}, signal: ${signal})`,
              executionTimeMs: Date.now() - startTime,
            });
          }
        });

        // Send execution request
        const request: SandboxRequest = {
          type: 'execute',
          handlerCode: handler.toString(),
          ctx: sanitizeContext(ctx),
          args,
        };

        child.send(request);
      } catch (err) {
        finish({
          success: false,
          error: `Failed to spawn sandbox: ${err}`,
          executionTimeMs: Date.now() - startTime,
        });
      }
    });
  }

  /**
   * Update sandbox configuration.
   */
  setConfig(config: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current sandbox configuration.
   */
  getConfig(): SandboxConfig {
    return { ...this.config };
  }
}

/**
 * Create a sandbox with default configuration.
 */
export function createSandbox(config?: Partial<SandboxConfig>): ProcessSandbox {
  return new ProcessSandbox(config);
}

/**
 * Check if a tool should be sandboxed based on its configuration.
 */
export function shouldSandbox(
  toolConfig?: { sandbox?: boolean | SandboxConfig }
): boolean {
  if (!toolConfig) return false;
  return toolConfig.sandbox !== undefined && toolConfig.sandbox !== false;
}

/**
 * Get sandbox config from tool configuration.
 */
export function getSandboxConfig(
  toolConfig?: { sandbox?: boolean | SandboxConfig }
): SandboxConfig | null {
  if (!toolConfig?.sandbox) return null;
  if (typeof toolConfig.sandbox === 'boolean') {
    return DEFAULT_SANDBOX_CONFIG;
  }
  return { ...DEFAULT_SANDBOX_CONFIG, ...toolConfig.sandbox };
}
