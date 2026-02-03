import type { ToolDef, Plugin } from '@clifford/sdk';
import { CORE_TOOLS } from '@clifford/tools-core';
import skillExample from '@clifford/skill-example';

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  constructor() {
    // Register core tools
    for (const tool of CORE_TOOLS) {
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
    // For MVP, we hardcode the example plugin
    let plugin: Plugin | null = null;

    if (pluginName === '@clifford/skill-example') {
      plugin = skillExample;
    }

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

  getAllTools(): ToolDef[] {
    return Array.from(this.tools.values());
  }
}
