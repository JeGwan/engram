import type { Chunk } from '../types.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export function chunkMarkdown(content: string, maxChunkSize = 1000): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];
  let chunkIndex = 0;

  function flush() {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      if (text.length > maxChunkSize) {
        const parts = splitText(text, maxChunkSize);
        for (const part of parts) {
          chunks.push({ index: chunkIndex++, text: part, heading: currentHeading });
        }
      } else {
        chunks.push({ index: chunkIndex++, text, heading: currentHeading });
      }
    }
    currentLines = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2];
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return chunks;
}

function splitText(text: string, maxSize: number): string[] {
  const parts: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxSize && current.length > 0) {
      parts.push(current.trim());
      current = '';
    }
    current += (current ? '\n\n' : '') + para;
  }
  if (current.trim()) parts.push(current.trim());

  return parts;
}
