import type { ToolDef, ToolCommandDef, Plugin, Logger } from '@clifford/sdk';
import { NATIVE_TOOLS } from '@clifford/tools';
import { getPlugin, getAllPlugins } from '@clifford/plugins';

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
    // Register core tools
    for (const tool of NATIVE_TOOLS) {
      this.tools.set(tool.name, tool);
    }
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
