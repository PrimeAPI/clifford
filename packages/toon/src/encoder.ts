import { encode } from '@toon-format/toon';

export interface UserPayloadInput {
  task: string;
  output: string;
  conversation: Array<{ role: string; content: string }>;
  transcript: Array<{ type: string; [key: string]: unknown }>;
  subagents: unknown[];
  runKind: string;
  profile: string | null;
  input: object | null;
  memories: unknown[];
  knowledge: Array<{ content: string; sourceType: string; sourceId: string | null; similarity: number }>;
  agentLevel: number;
}

function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

function escapeMultiline(text: string): string {
  if (!text.includes('\n')) {
    return text;
  }
  return '|\n' + indent(text, 2);
}

export function encodeUserPayload(payload: UserPayloadInput): string {
  const sections: string[] = [];

  // Header section with scalar values
  sections.push('# Context');
  sections.push('');
  sections.push(`task: ${escapeMultiline(payload.task)}`);
  sections.push('');
  sections.push(`output: ${escapeMultiline(payload.output || '')}`);
  sections.push('');
  sections.push(`runKind: ${payload.runKind}`);
  sections.push(`profile: ${payload.profile ?? 'null'}`);
  sections.push(`agentLevel: ${payload.agentLevel}`);

  // Knowledge section (passive RAG results)
  if (payload.knowledge && payload.knowledge.length > 0) {
    sections.push('');
    sections.push('## Knowledge');
    sections.push('');
    for (const chunk of payload.knowledge) {
      const source = chunk.sourceId
        ? `${chunk.sourceType}: ${chunk.sourceId}`
        : chunk.sourceType;
      sections.push(`### ${source} (similarity: ${chunk.similarity.toFixed(2)})`);
      sections.push('');
      sections.push(chunk.content);
      sections.push('');
    }
  }

  // Conversation section
  if (payload.conversation.length > 0) {
    sections.push('');
    sections.push('## Conversation');
    sections.push('');
    sections.push('```toon');
    sections.push(encode({ conversation: payload.conversation }));
    sections.push('```');
  }

  // Transcript section
  if (payload.transcript.length > 0) {
    sections.push('');
    sections.push('## Transcript');
    sections.push('');
    sections.push('```toon');
    sections.push(encode({ transcript: payload.transcript }));
    sections.push('```');
  }

  // Memories section
  if (payload.memories.length > 0) {
    sections.push('');
    sections.push('## Memories');
    sections.push('');
    sections.push('```toon');
    sections.push(encode({ memories: payload.memories }));
    sections.push('```');
  }

  // Subagents section
  if (payload.subagents.length > 0) {
    sections.push('');
    sections.push('## Subagents');
    sections.push('');
    sections.push('```toon');
    sections.push(encode({ subagents: payload.subagents }));
    sections.push('```');
  }

  // Input section (if present)
  if (payload.input && Object.keys(payload.input).length > 0) {
    sections.push('');
    sections.push('## Input');
    sections.push('');
    sections.push('```toon');
    sections.push(encode({ input: payload.input }));
    sections.push('```');
  }

  return sections.join('\n');
}
