import { NATIVE_TOOLS } from '@clifford/tools';
import { getAllPlugins } from '@clifford/plugins';
import type { ToolDef } from '@clifford/sdk';

export function loadAllTools(): ToolDef[] {
  const pluginTools = getAllPlugins().flatMap((plugin) => plugin.tools);
  const byName = new Map<string, ToolDef>();
  for (const tool of [...NATIVE_TOOLS, ...pluginTools]) {
    byName.set(tool.name, tool);
  }
  return Array.from(byName.values());
}
