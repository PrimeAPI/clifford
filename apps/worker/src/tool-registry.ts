import type { ToolDef, ToolCommandDef, Plugin, Logger } from '@clifford/sdk';
import { NATIVE_TOOLS } from '@clifford/tools';
import { getPlugin, getAllPlugins } from '@clifford/plugins';
import { ProcessSandbox, type SandboxConfig } from '@clifford/sandbox';

export interface ToolSandboxConfig {
  enabled: boolean;
  config?: Partial<SandboxConfig>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private sandboxConfigs = new Map<string, ToolSandboxConfig>();
  private sandbox?: ProcessSandbox;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
    // Register core tools (native tools are trusted, no sandbox)
    for (const tool of NATIVE_TOOLS) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Configure sandboxing for a specific tool.
   */
  setSandboxConfig(toolName: string, config: ToolSandboxConfig): void {
    this.sandboxConfigs.set(toolName, config);
  }

  /**
   * Check if a tool should be sandboxed.
   */
  shouldSandbox(toolName: string): boolean {
    const config = this.sandboxConfigs.get(toolName);
    return config?.enabled ?? false;
  }

  /**
   * Get the sandbox instance, creating it if needed.
   */
  getSandbox(): ProcessSandbox {
    if (!this.sandbox) {
      this.sandbox = new ProcessSandbox();
    }
    return this.sandbox;
  }

  /**
   * Get sandbox config for a tool.
   */
  getSandboxConfig(toolName: string): Partial<SandboxConfig> | undefined {
    return this.sandboxConfigs.get(toolName)?.config;
  }

  async loadPlugins(pluginNames: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const pluginName of pluginNames) {
      try {
        await this.loadPlugin(pluginName);
      } catch (err) {
        missing.push(pluginName);
      }
    }
    return missing;
  }

  async loadAllPlugins(): Promise<void> {
    const plugins = getAllPlugins();
    for (const plugin of plugins) {
      for (const tool of plugin.tools) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  private async loadPlugin(pluginName: string): Promise<void> {
    const plugin: Plugin | undefined = getPlugin(pluginName);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    for (const tool of plugin.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  getTool(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  getCommand(toolName: string, commandName: string): ToolCommandDef | undefined {
    const tool = this.tools.get(toolName);
    return tool?.commands.find((command) => command.name === commandName);
  }

  getAllTools(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  listTools(): ToolDef[] {
    return this.getAllTools();
  }

  setTools(tools: ToolDef[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }
}
