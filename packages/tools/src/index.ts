import type { ToolDef } from '@clifford/sdk';
import { systemTool } from './system.js';
import { memoryTool } from './memory.js';
import { remindersTool } from './reminders.js';
import { weatherTool } from './weather.js';

export const DEFAULT_TOOLS: ToolDef[] = [systemTool, memoryTool];
export const NATIVE_TOOLS: ToolDef[] = [systemTool, memoryTool, remindersTool, weatherTool];

export { systemTool, memoryTool, remindersTool, weatherTool };
