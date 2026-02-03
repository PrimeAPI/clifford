import type { ToolDef, ToolCommandDef, Plugin } from '@clifford/sdk';
import { DEFAULT_TOOLS } from '@clifford/tools';

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  constructor() {
    // Register core tools
    for (const tool of DEFAULT_TOOLS) {
      this.tools.set(tool.name, tool);
    }
  }

  async loadPlugins(pluginNames: string[]): Promise<void> {
    for (const pluginName of pluginNames) {
      await this.loadPlugin(pluginName);
    }
  }

  private async loadPlugin(pluginName: string): Promise<void> {
    // In production, this would dynamic import based on pluginName
    let plugin: Plugin | null = null;

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
}
