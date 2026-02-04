import type { Plugin } from '@clifford/sdk';

const registry: Record<string, Plugin> = {};

export function registerPlugin(name: string, plugin: Plugin) {
  registry[name] = plugin;
}

export function getPlugin(name: string): Plugin | undefined {
  return registry[name];
}

export function listPlugins(): string[] {
  return Object.keys(registry).sort();
}

// Register plugins here by importing and calling registerPlugin.

export function getAllPlugins(): Plugin[] {
  return Object.values(registry);
}
