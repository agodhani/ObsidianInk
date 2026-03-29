import type { InkTextElement } from '../elements/inktext/types';
import type { Element, NoteElements } from '../types';

export interface WikiLinkToken {
  rawText: string;
  label: string;
}

function getElementPosition(element: Element): { x: number; y: number } {
  if ('transform' in element) {
    const values = element.transform.values;
    return {
      x: values[6] ?? 0,
      y: values[7] ?? 0,
    };
  }

  if (element.type === 'stroke' && element.strokes[0]?.inputs.inputs[0]) {
    const firstPoint = element.strokes[0].inputs.inputs[0];
    return { x: firstPoint.x, y: firstPoint.y };
  }

  return { x: 0, y: 0 };
}

function serializeInkText(element: InkTextElement): string {
  return element.lines
    .map((line) => line.tokens.map((token) => token.text).join(' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function extractNoteTextMirror(note: NoteElements): string {
  return note.elements
    .filter((element): element is InkTextElement => element.type === 'inkText')
    .sort((left, right) => {
      const leftPosition = getElementPosition(left);
      const rightPosition = getElementPosition(right);
      if (Math.abs(leftPosition.y - rightPosition.y) > 12) {
        return leftPosition.y - rightPosition.y;
      }
      return leftPosition.x - rightPosition.x;
    })
    .map(serializeInkText)
    .filter(Boolean)
    .join('\n\n');
}

export function extractWikiLinks(text: string): WikiLinkToken[] {
  const matches = [...text.matchAll(/\[\[([^[\]]+)\]\]/g)];
  return matches.map((match) => ({
    rawText: match[0],
    label: match[1].trim(),
  }));
}

export function extractResearchPrompts(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('???'))
    .map((line) => line.replace(/^\?\?\?\s*/, '').trim())
    .filter(Boolean);
}

export function buildSearchSnippets(text: string, query: string, radius = 80): string[] {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) return [];

  const snippets: string[] = [];
  let startIndex = 0;

  while (startIndex < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, startIndex);
    if (matchIndex === -1) break;

    const excerptStart = Math.max(0, matchIndex - radius);
    const excerptEnd = Math.min(text.length, matchIndex + normalizedQuery.length + radius);
    snippets.push(text.slice(excerptStart, excerptEnd).trim());
    startIndex = matchIndex + normalizedQuery.length;
  }

  return snippets;
}
