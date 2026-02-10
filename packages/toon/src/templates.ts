import type { ToolDef, PromptOptions } from './types.js';

export function buildToolDescriptionsMarkdown(tools: ToolDef[], kind: string): string {
  if (kind === 'coordinator') {
    const lines: string[] = [];
    lines.push('### All Tools');
    lines.push('');
    lines.push('| Tool | Description | Commands |');
    lines.push('|------|-------------|----------|');
    for (const tool of tools) {
      const commands = tool.commands.map((cmd) => `\`${tool.name}.${cmd.name}\``).join(', ');
      lines.push(`| ${tool.name} | ${tool.shortDescription} | ${commands} |`);
    }
    return lines.join('\n');
  }

  const pinned = tools.filter((tool) => tool.pinned);
  const important = tools.filter((tool) => !tool.pinned && tool.important);

  const lines: string[] = [];

  if (pinned.length > 0) {
    lines.push('### Pinned Tools');
    lines.push('');
    lines.push('| Tool | Commands |');
    lines.push('|------|----------|');
    for (const tool of pinned) {
      const commandNames = tool.commands.map((cmd) => `\`${cmd.name}\``).join(', ') || '(none)';
      lines.push(`| ${tool.name} | ${commandNames} |`);
    }
    lines.push('');
  }

  if (important.length > 0) {
    lines.push('### Important Tools');
    lines.push('');
    lines.push('| Tool | Description |');
    lines.push('|------|-------------|');
    for (const tool of important) {
      lines.push(`| ${tool.name} | ${tool.shortDescription} |`);
    }
    lines.push('');
  }

  if (lines.length === 0) {
    lines.push('No tools are pinned or marked important.');
  }

  return lines.join('\n');
}

export function buildSystemPromptMarkdown(tools: ToolDef[], options: PromptOptions): string {
  const toolDescriptions = buildToolDescriptionsMarkdown(tools, options.runKind);

  return `# Assistant

You help users by responding to messages and completing tasks. Reply with a single JSON command.

## Commands

| Command | When to Use |
|---------|-------------|
| \`{"type":"send_message","message":"..."}\` | Respond to the user directly |
| \`{"type":"tool_call","name":"tool.command","args":{...}}\` | Execute a tool |
| \`{"type":"set_output","output":"...","mode":"replace"}\` | Build up working output |
| \`{"type":"finish","output":"..."}\` | Complete the task with final output |
| \`{"type":"spawn_subagent","subagent":{...}}\` | Delegate a subtask to a subagent |
| \`{"type":"sleep","delaySeconds":N}\` | Pause and resume later |
| \`{"type":"note","category":"requirements|plan|validation","content":"..."}\` | Record reasoning (not shown to user) |
| \`{"type":"decision","content":"..."}\` | Record a decision with rationale |

## Behavior

- **Reasoning**: Before acting on complex tasks, emit a \`note\` (category: "requirements") to analyze what is needed. Before a multi-step tool sequence, emit a \`note\` (category: "plan") outlining the steps. After gathering results, emit a \`note\` (category: "validation") to verify correctness before finishing.
- **Simple messages** (greetings, questions, chat): Respond directly with \`send_message\`.
- **Complex tasks**: Use tools as needed, build output with \`set_output\`, then \`finish\`.
- **Multi-step tasks**: Call tools in sequence. Each tool result comes back before the next call.
- **Delegation**: Use \`spawn_subagent\` for independent subtasks that can run in parallel.
- **Ambiguous entities**: If a query could refer to multiple distinct entities (same name, different types like movie vs series, or different years), ask the user to clarify before providing data. List the candidates with distinguishing details (year, type).
- **Numeric data**: Always verify numbers (ratings, scores, statistics) by fetching source pages with \`web.fetch\`. Never report ratings or averages from search snippets alone.
- **Arithmetic**: When computing averages, sums, percentages, or other math, use the \`compute\` tool. Do not perform mental math for final answers.
- **Assumptions**: When your answer depends on assumptions (which entity, which time period, which metric), state them explicitly.${options.locale ? `\n- **Language**: Respond in the user's language (locale: ${options.locale}) unless asked otherwise.` : ''}

## Output Format

- **Ratings/scores**: Format as "X.X/10 (source: URL)" with the source noted.
- **Averages**: Show each item with its value, then the computed average: "Average: X.X (N items, unweighted)".
- **Dates**: Include "as of" timestamp for time-sensitive data.
- Never answer "between X and Y" when asked for a specific average or number.

## Tools

${toolDescriptions}
`;
}
