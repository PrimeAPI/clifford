import type { ToolDef } from '@clifford/sdk';
import { systemPing } from './system-ping.js';
import { memoryPut } from './memory-put.js';
import { memoryGet } from './memory-get.js';

export const CORE_TOOLS: ToolDef[] = [systemPing, memoryPut, memoryGet];

export { systemPing, memoryPut, memoryGet };
