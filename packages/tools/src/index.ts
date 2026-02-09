import type { ToolDef } from '@clifford/sdk';
import { systemTool } from './system.js';
import { memoryTool } from './memory.js';
import { toolsTool } from './tools.js';
import { remindersTool } from './reminders.js';
import { weatherTool } from './weather.js';
import { retrievalTool } from './retrieval.js';
import { webTool } from './web.js';

export const DEFAULT_TOOLS: ToolDef[] = [systemTool, toolsTool, memoryTool];
export const NATIVE_TOOLS: ToolDef[] = [
  systemTool,
  toolsTool,
  memoryTool,
  remindersTool,
  weatherTool,
  retrievalTool,
  webTool,
];

export {
  systemTool,
  toolsTool,
  memoryTool,
  remindersTool,
  weatherTool,
  retrievalTool,
  webTool,
};
