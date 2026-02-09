#!/usr/bin/env node
/**
 * Tool Demonstration Script
 */

import { NATIVE_TOOLS } from '../dist/index.js';

console.log('='.repeat(80));
console.log('CLIFFORD TOOLS - Comprehensive Overview');
console.log('='.repeat(80));
console.log();

console.log(`Total tools available: ${NATIVE_TOOLS.length}\n`);

for (const tool of NATIVE_TOOLS) {
  console.log('─'.repeat(80));
  console.log(`📦 ${tool.name.toUpperCase()}`);
  console.log('─'.repeat(80));
  console.log();
  console.log(`Description: ${tool.longDescription}`);
  console.log();
  console.log(`Commands (${tool.commands.length}):`);
  
  for (const command of tool.commands) {
    console.log();
    console.log(`  ${tool.name}.${command.name} [${command.classification}]`);
    console.log(`  ${command.shortDescription}`);
    console.log();
    console.log(`  Example: ${command.usageExample}`);
  }
  
  console.log();
}

console.log('='.repeat(80));
console.log('✨ NEW: Web Search & Browsing');
console.log('='.repeat(80));
console.log();
console.log('The web tool enables agents to access the internet:');
console.log('  • Search the web using DuckDuckGo (no API key)');
console.log('  • Fetch and parse webpage content');
console.log('  • Extract structured data from HTML');
console.log();

console.log('='.repeat(80));
console.log('🎯 Key Improvements');
console.log('='.repeat(80));
console.log();
console.log('1. Enhanced Descriptions');
console.log('   • Clear explanations of when and how to use each tool');
console.log('   • Parameter descriptions include limits and examples');
console.log('   • Usage examples provided as valid JSON');
console.log();
console.log('2. Parameter Validation');
console.log('   • Min/max limits enforced via Zod schemas');
console.log('   • Limits documented in parameter descriptions');
console.log('   • Type-safe with TypeScript');
console.log();
console.log('3. Better LLM Context');
console.log('   • Comprehensive longDescription for each tool');
console.log('   • Detailed command descriptions');
console.log('   • Clear return value documentation');
console.log();

console.log('='.repeat(80));
