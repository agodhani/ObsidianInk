import type { BoundingBox } from '../../types';
import type { StructuredImageAnalysis } from '../../ai/OpenRouterService';
import type { InkTextCheckState, InkTextLine, InkTextLineKind, InkTextToken } from './types';

const MARKER_COLUMN_THRESHOLD = 28;
const MIN_MARKER_SUPPORT = 2;
const INDENT_COLUMN_THRESHOLD = 26;
const INDENT_SPACES = 2;

const CLEAR_BULLET_MARKERS = new Set(['.', '•', '·', '-', '–', '—', '*', '+']);
const AMBIGUOUS_BULLET_MARKERS = new Set(['o', 'O', '0', 'l', 'I', '|', '/']);
const CHECKBOX_MARKERS = new Map<string, InkTextCheckState>([
  ['[ ]', 'unchecked'],
  ['[]', 'unchecked'],
  ['[x]', 'checked'],
  ['[X]', 'checked'],
  ['☐', 'unchecked'],
  ['☑', 'checked'],
  ['☒', 'checked'],
  ['✓', 'checked'],
  ['✔', 'checked'],
  ['v', 'checked'],
  ['V', 'checked'],
  ['x', 'checked'],
  ['X', 'checked'],
]);

interface MarkerCandidate {
  kind: Exclude<InkTextLineKind, 'paragraph' | 'heading' | 'unknown'>;
  markerText: string;
  confidence: number;
  order?: number;
  checkState?: InkTextCheckState;
  ambiguous?: boolean;
}

interface InlineMarkerMatch {
  marker: MarkerCandidate;
  tokenCountUsed: number;
  firstTokenRemainder?: string;
}

interface LineMetrics {
  index: number;
  line: InkTextLine;
  bounds: BoundingBox | null;
  text: string;
  avgConfidence: number;
  centerY: number;
  height: number;
  left: number;
  right: number;
  firstTokenLeft: number;
  leadingTokens: InkTextToken[];
  inlineMatch: InlineMarkerMatch | null;
  potentialMarker: MarkerCandidate | null;
  isMarkerOnly: boolean;
  markerSupport: number;
}

function trimTokenText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function joinInkTextTokens(tokens: InkTextToken[]): string {
  let result = '';

  for (const token of tokens) {
    const next = trimTokenText(token.text);
    if (!next) continue;

    if (!result) {
      result = next;
      continue;
    }

    const noSpaceBefore = /^[,.;:!?%)\]]/.test(next);
    const noSpaceAfterPrevious = /[(\[]$/.test(result);
    result += noSpaceBefore || noSpaceAfterPrevious ? next : ` ${next}`;
  }

  return result.trim();
}

function getTokenBounds(token: InkTextToken): BoundingBox {
  const { topLeft, topRight, bottomRight, bottomLeft } = token.quad;
  return {
    left: Math.min(topLeft.x, topRight.x, bottomRight.x, bottomLeft.x),
    top: Math.min(topLeft.y, topRight.y, bottomRight.y, bottomLeft.y),
    right: Math.max(topLeft.x, topRight.x, bottomRight.x, bottomLeft.x),
    bottom: Math.max(topLeft.y, topRight.y, bottomRight.y, bottomLeft.y),
  };
}

function getLineBounds(line: InkTextLine): BoundingBox | null {
  if (line.tokens.length === 0) return null;

  const boxes = line.tokens.map(getTokenBounds);
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function getAverageConfidence(tokens: InkTextToken[]): number {
  const confidences = tokens
    .map((token) => token.confidence)
    .filter((confidence): confidence is number => typeof confidence === 'number');

  if (confidences.length === 0) return 0.5;
  return confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length;
}

function getTokenWidth(token: InkTextToken): number {
  const bounds = getTokenBounds(token);
  return bounds.right - bounds.left;
}

function getTokenHeight(token: InkTextToken): number {
  const bounds = getTokenBounds(token);
  return bounds.bottom - bounds.top;
}

function getTokenCenterY(token: InkTextToken): number {
  const bounds = getTokenBounds(token);
  return (bounds.top + bounds.bottom) / 2;
}

function estimateLineBaseline(tokens: InkTextToken[]): number {
  if (tokens.length === 0) return 0;

  const bottoms = tokens.map((token) => getTokenBounds(token).bottom);
  const heights = tokens.map((token) => getTokenHeight(token));
  const averageHeight = heights.reduce((sum, height) => sum + height, 0) / heights.length;
  return Math.max(...bottoms) - averageHeight * 0.2;
}

function regroupInkTextLinesByVisualRows(lines: InkTextLine[]): InkTextLine[] {
  const tokens = lines.flatMap((line) => line.tokens);
  if (tokens.length === 0) return lines;

  const orderedTokens = [...tokens].sort((left, right) => {
    const verticalDelta = getTokenCenterY(left) - getTokenCenterY(right);
    if (Math.abs(verticalDelta) > 1) return verticalDelta;
    return getTokenBounds(left).left - getTokenBounds(right).left;
  });

  const rows: Array<{ tokens: InkTextToken[]; centerY: number; averageHeight: number }> = [];

  for (const token of orderedTokens) {
    const tokenCenterY = getTokenCenterY(token);
    const tokenHeight = getTokenHeight(token);
    let bestRow: { tokens: InkTextToken[]; centerY: number; averageHeight: number } | null = null;
    let bestDelta = Infinity;

    for (const row of rows) {
      const threshold = Math.max(18, Math.min(row.averageHeight, tokenHeight) * 0.9);
      const delta = Math.abs(row.centerY - tokenCenterY);
      if (delta <= threshold && delta < bestDelta) {
        bestRow = row;
        bestDelta = delta;
      }
    }

    if (bestRow) {
      bestRow.tokens.push(token);
      bestRow.centerY = (bestRow.centerY * (bestRow.tokens.length - 1) + tokenCenterY) / bestRow.tokens.length;
      bestRow.averageHeight =
        (bestRow.averageHeight * (bestRow.tokens.length - 1) + tokenHeight) / bestRow.tokens.length;
    } else {
      rows.push({
        tokens: [token],
        centerY: tokenCenterY,
        averageHeight: tokenHeight,
      });
    }
  }

  return rows
    .map((row) => {
      const rowTokens = [...row.tokens].sort((left, right) => getTokenBounds(left).left - getTokenBounds(right).left);
      return {
        tokens: rowTokens,
        baseline: estimateLineBaseline(rowTokens),
      };
    })
    .sort((left, right) => left.baseline - right.baseline);
}

function detectMarkerFromToken(token: InkTextToken): MarkerCandidate | null {
  const text = trimTokenText(token.text);
  if (!text) return null;

  const directCheckbox = CHECKBOX_MARKERS.get(text);
  if (directCheckbox) {
    return {
      kind: 'checklist',
      markerText: text,
      checkState: directCheckbox,
      confidence: 0.92,
    };
  }

  const orderedMatch = text.match(/^(\d+)([.)-])?$/);
  if (orderedMatch) {
    const punctuation = orderedMatch[2] ?? '';
    return {
      kind: 'ordered',
      markerText: `${orderedMatch[1]}${punctuation}`,
      order: Number(orderedMatch[1]),
      confidence: punctuation ? 0.9 : 0.72,
      ambiguous: punctuation === '',
    };
  }

  if (CLEAR_BULLET_MARKERS.has(text)) {
    return {
      kind: 'bullet',
      markerText: text,
      confidence: 0.88,
    };
  }

  if (AMBIGUOUS_BULLET_MARKERS.has(text)) {
    const tokenWidth = getTokenWidth(token);
    const tokenHeight = getTokenHeight(token);
    const narrowEnough = tokenWidth <= Math.max(10, tokenHeight * 0.75);
    return {
      kind: 'bullet',
      markerText: text,
      confidence: narrowEnough ? 0.66 : 0.52,
      ambiguous: true,
    };
  }

  return null;
}

function detectMarkerFromTextPrefix(text: string): { marker: MarkerCandidate; remainingText: string } | null {
  const trimmed = trimTokenText(text);
  if (!trimmed) return null;

  const checklistMatch = trimmed.match(/^(\[[ xX]?\]|\[\]|☐|☑|☒|✓|✔)\s+(.+)$/);
  if (checklistMatch) {
    const markerText = checklistMatch[1];
    return {
      marker: {
        kind: 'checklist',
        markerText,
        checkState: CHECKBOX_MARKERS.get(markerText) ?? 'unchecked',
        confidence: 0.9,
      },
      remainingText: checklistMatch[2].trim(),
    };
  }

  const orderedMatch = trimmed.match(/^(\d+)([.)-])?\s+(.+)$/);
  if (orderedMatch) {
    const punctuation = orderedMatch[2] ?? '';
    return {
      marker: {
        kind: 'ordered',
        markerText: `${orderedMatch[1]}${punctuation}`,
        order: Number(orderedMatch[1]),
        confidence: punctuation ? 0.9 : 0.72,
        ambiguous: punctuation === '',
      },
      remainingText: orderedMatch[3].trim(),
    };
  }

  const bulletMatch = trimmed.match(/^([.•·\-–—*+oOlI|/])\s+(.+)$/);
  if (bulletMatch) {
    const markerText = bulletMatch[1];
    return {
      marker: {
        kind: 'bullet',
        markerText,
        confidence: CLEAR_BULLET_MARKERS.has(markerText) ? 0.88 : 0.64,
        ambiguous: !CLEAR_BULLET_MARKERS.has(markerText),
      },
      remainingText: bulletMatch[2].trim(),
    };
  }

  return null;
}

function detectInlineMarker(tokens: InkTextToken[]): InlineMarkerMatch | null {
  if (tokens.length === 0) return null;

  const prefixMatch = detectMarkerFromTextPrefix(tokens[0].text);
  if (prefixMatch) {
    return {
      marker: prefixMatch.marker,
      tokenCountUsed: 1,
      firstTokenRemainder: prefixMatch.remainingText,
    };
  }

  const firstMarker = detectMarkerFromToken(tokens[0]);
  const secondText = tokens[1] ? trimTokenText(tokens[1].text) : '';
  if (firstMarker?.kind === 'ordered' && tokens.length >= 2 && ['.', ')', '-'].includes(secondText)) {
    return {
      marker: {
        ...firstMarker,
        markerText: `${trimTokenText(tokens[0].text)}${secondText}`,
        confidence: 0.9,
        ambiguous: false,
      },
      tokenCountUsed: 2,
    };
  }

  if (firstMarker) {
    return { marker: firstMarker, tokenCountUsed: 1 };
  }

  return null;
}

function clusterColumns(values: number[]): Array<{ x: number; count: number }> {
  const sorted = [...values].sort((left, right) => left - right);
  const clusters: Array<{ x: number; count: number }> = [];

  for (const value of sorted) {
    const cluster = clusters.find((candidate) => Math.abs(candidate.x - value) <= MARKER_COLUMN_THRESHOLD);
    if (cluster) {
      cluster.x = (cluster.x * cluster.count + value) / (cluster.count + 1);
      cluster.count += 1;
    } else {
      clusters.push({ x: value, count: 1 });
    }
  }

  return clusters;
}

function getColumnSupport(clusters: Array<{ x: number; count: number }>, value: number): number {
  return clusters
    .filter((cluster) => Math.abs(cluster.x - value) <= MARKER_COLUMN_THRESHOLD)
    .reduce((max, cluster) => Math.max(max, cluster.count), 0);
}

function createMetrics(lines: InkTextLine[]): LineMetrics[] {
  const prelim = lines.map((line, index) => {
    const orderedTokens = [...line.tokens].sort((left, right) => {
      const leftBounds = getTokenBounds(left);
      const rightBounds = getTokenBounds(right);
      return leftBounds.left - rightBounds.left;
    });
    const bounds = getLineBounds({ ...line, tokens: orderedTokens });
    const text = joinInkTextTokens(orderedTokens);
    const inlineMatch = detectInlineMarker(orderedTokens);
    const potentialMarker = inlineMatch?.marker ?? (orderedTokens.length === 1 ? detectMarkerFromToken(orderedTokens[0]) : null);
    const centerY = bounds ? (bounds.top + bounds.bottom) / 2 : line.baseline;
    const height = bounds ? Math.max(1, bounds.bottom - bounds.top) : 1;
    const left = bounds?.left ?? 0;
    const right = bounds?.right ?? left;
    const firstTokenLeft = orderedTokens[0] ? getTokenBounds(orderedTokens[0]).left : left;

    return {
      index,
      line,
      bounds,
      text,
      avgConfidence: getAverageConfidence(orderedTokens),
      centerY,
      height,
      left,
      right,
      firstTokenLeft,
      leadingTokens: orderedTokens,
      inlineMatch,
      potentialMarker,
      isMarkerOnly: !!potentialMarker && text === potentialMarker.markerText,
      markerSupport: 0,
    };
  });

  const columns = clusterColumns(
    prelim
      .filter((metric) => metric.potentialMarker)
      .map((metric) => metric.firstTokenLeft),
  );

  return prelim.map((metric) => ({
    ...metric,
    markerSupport: metric.potentialMarker ? getColumnSupport(columns, metric.firstTokenLeft) : 0,
  }));
}

function isMarkerSupported(metric: LineMetrics): boolean {
  if (!metric.potentialMarker) return false;
  if (!metric.potentialMarker.ambiguous) return true;
  return metric.markerSupport >= MIN_MARKER_SUPPORT || metric.avgConfidence < 0.72;
}

function getIndentLevels(anchorXs: number[]): number[] {
  const clusters: number[] = [];

  for (const x of [...anchorXs].sort((left, right) => left - right)) {
    const existing = clusters.findIndex((clusterX) => Math.abs(clusterX - x) <= INDENT_COLUMN_THRESHOLD);
    if (existing === -1) {
      clusters.push(x);
    }
  }

  return clusters;
}

function getIndentLevel(anchorX: number, columns: number[]): number {
  const index = columns.findIndex((column) => Math.abs(column - anchorX) <= INDENT_COLUMN_THRESHOLD);
  return index === -1 ? 0 : index;
}

function formatStructuredLine(line: InkTextLine, fallbackText: string): string {
  const content = (line.serializedText ?? '').trim();
  if (content) return content;

  const plain = fallbackText.trim();
  const indent = ' '.repeat((line.indentLevel ?? 0) * INDENT_SPACES);

  switch (line.kind) {
    case 'bullet':
      return plain ? `${indent}- ${plain}`.trimEnd() : `${indent}-`;
    case 'ordered': {
      const marker = line.markerText?.trim()
        ? line.markerText.trim().replace(/[.)-]?$/, '.') : `${line.order ?? 1}.`;
      return plain ? `${indent}${marker} ${plain}`.trimEnd() : `${indent}${marker}`;
    }
    case 'checklist': {
      const state = line.checkState === 'checked' ? 'x' : ' ';
      return plain ? `${indent}- [${state}] ${plain}`.trimEnd() : `${indent}- [${state}]`;
    }
    default:
      if (!plain) return '';
      return `${indent}${plain}`.trimEnd();
  }
}

function resetLineStructure(line: InkTextLine): InkTextLine {
  return {
    ...line,
    kind: undefined,
    markerText: undefined,
    indentLevel: undefined,
    order: undefined,
    checkState: undefined,
    structureConfidence: undefined,
    serializedText: undefined,
  };
}

export function applyLocalNoteStructure(lines: InkTextLine[]): InkTextLine[] {
  const nextLines = regroupInkTextLinesByVisualRows(lines).map(resetLineStructure);
  const metrics = createMetrics(nextLines);
  if (metrics.length === 0) return nextLines;

  const pairedMarkerLines = new Set<number>();
  const structuredLineIndices = new Set<number>();
  const orderedCandidates = metrics.filter(
    (metric) => metric.inlineMatch?.marker.kind === 'ordered' && isMarkerSupported(metric),
  ).length;

  for (const metric of metrics) {
    const line = nextLines[metric.index];
    const baseText = metric.text;

    if (!baseText) {
      line.kind = 'unknown';
      line.structureConfidence = 0.2;
      continue;
    }

    if (metric.inlineMatch && isMarkerSupported(metric)) {
      const marker = metric.inlineMatch.marker;
      const remainingTokens = metric.leadingTokens.slice(metric.inlineMatch.tokenCountUsed);
      const remainderParts = [
        metric.inlineMatch.firstTokenRemainder?.trim() ?? '',
        joinInkTextTokens(remainingTokens),
      ].filter(Boolean);
      const contentText = remainderParts.join(' ').trim();

      if (contentText) {
        const numericWithoutPunctuation = marker.kind === 'ordered' && marker.ambiguous;
        if (!numericWithoutPunctuation || orderedCandidates >= 2 || marker.markerText.includes('.')) {
          line.kind = marker.kind;
          line.markerText = marker.markerText;
          line.order = marker.order;
          line.checkState = marker.checkState ?? 'none';
          line.structureConfidence = marker.confidence;
          line.serializedText = formatStructuredLine(
            {
              ...line,
              kind: marker.kind,
              markerText: marker.markerText,
              order: marker.order,
              checkState: marker.checkState ?? 'none',
            },
            contentText,
          );
          structuredLineIndices.add(metric.index);
          continue;
        }
      }
    }

    if (metric.isMarkerOnly && metric.potentialMarker && metric.markerSupport >= MIN_MARKER_SUPPORT) {
      line.kind = metric.potentialMarker.kind;
      line.markerText = metric.potentialMarker.markerText;
      line.order = metric.potentialMarker.order;
      line.checkState = metric.potentialMarker.checkState ?? 'none';
      line.structureConfidence = Math.max(metric.potentialMarker.confidence - 0.15, 0.52);
      line.serializedText = formatStructuredLine(
        {
          ...line,
          kind: metric.potentialMarker.kind,
          markerText: metric.potentialMarker.markerText,
          order: metric.potentialMarker.order,
          checkState: metric.potentialMarker.checkState ?? 'none',
        },
        '',
      );
      continue;
    }

    line.kind = 'paragraph';
    line.structureConfidence = Math.max(metric.avgConfidence, 0.6);
    line.checkState = 'none';
  }

  for (const metric of metrics) {
    if (!metric.isMarkerOnly || !metric.potentialMarker || !isMarkerSupported(metric)) {
      continue;
    }

    let bestTargetIndex = -1;
    let bestScore = Infinity;

    for (const candidate of metrics) {
      if (candidate.index === metric.index || pairedMarkerLines.has(candidate.index)) continue;

      const candidateLine = nextLines[candidate.index];
      const candidateText = joinInkTextTokens(candidate.leadingTokens);
      if (!candidateText) continue;
      if (structuredLineIndices.has(candidate.index)) continue;

      const verticalTolerance = Math.max(20, Math.max(metric.height, candidate.height) * 1.1);
      const verticalDelta = Math.abs(candidate.centerY - metric.centerY);
      if (verticalDelta > verticalTolerance) continue;

      if (candidate.left <= metric.right) continue;

      const horizontalGap = candidate.left - metric.right;
      const score = verticalDelta * 3 + horizontalGap;
      if (score < bestScore) {
        bestScore = score;
        bestTargetIndex = candidate.index;
      }
    }

    if (bestTargetIndex === -1) continue;

    const targetLine = nextLines[bestTargetIndex];
    const targetText = joinInkTextTokens(metrics[bestTargetIndex].leadingTokens);
    if (!targetText) continue;

    targetLine.kind = metric.potentialMarker.kind;
    targetLine.markerText = metric.potentialMarker.markerText;
    targetLine.order = metric.potentialMarker.order;
    targetLine.checkState = metric.potentialMarker.checkState ?? 'none';
    targetLine.structureConfidence = metric.potentialMarker.confidence;
    targetLine.serializedText = formatStructuredLine(
      {
        ...targetLine,
        kind: metric.potentialMarker.kind,
        markerText: metric.potentialMarker.markerText,
        order: metric.potentialMarker.order,
        checkState: metric.potentialMarker.checkState ?? 'none',
      },
      targetText,
    );

    nextLines[metric.index].kind = 'unknown';
    nextLines[metric.index].structureConfidence = Math.max(metric.potentialMarker.confidence - 0.1, 0.5);
    nextLines[metric.index].serializedText = '';

    pairedMarkerLines.add(metric.index);
    structuredLineIndices.add(bestTargetIndex);
  }

  const listAnchors = metrics
    .filter((metric) => {
      const line = nextLines[metric.index];
      return line.kind === 'bullet' || line.kind === 'ordered' || line.kind === 'checklist';
    })
    .map((metric) => metric.firstTokenLeft);
  const indentColumns = getIndentLevels(listAnchors);

  for (const metric of metrics) {
    const line = nextLines[metric.index];
    if (line.kind !== 'bullet' && line.kind !== 'ordered' && line.kind !== 'checklist') continue;

    line.indentLevel = getIndentLevel(metric.firstTokenLeft, indentColumns);
    const plainTextParts = [
      metric.inlineMatch?.firstTokenRemainder?.trim() ?? '',
      joinInkTextTokens(
        metric.leadingTokens.slice(line.serializedText ? 0 : metric.inlineMatch?.tokenCountUsed ?? 0),
      ),
    ].filter(Boolean);
    const plainText = plainTextParts.join(' ').trim();

    if (!line.serializedText) {
      const contentText = metric.inlineMatch ? plainText : plainText;
      line.serializedText = formatStructuredLine(line, contentText);
    } else if (line.indentLevel > 0) {
      const trimmed = line.serializedText.trimStart();
      line.serializedText = `${' '.repeat(line.indentLevel * INDENT_SPACES)}${trimmed}`;
    }
  }

  return nextLines.map((line) => {
    if (!line.kind) {
      return {
        ...line,
        kind: joinInkTextTokens(line.tokens) ? 'paragraph' : 'unknown',
        checkState: line.checkState ?? 'none',
        structureConfidence: line.structureConfidence ?? 0.55,
      };
    }
    if ((line.kind === 'bullet' || line.kind === 'ordered' || line.kind === 'checklist') && line.checkState === undefined) {
      return { ...line, checkState: 'none' };
    }
    return line;
  });
}

export function buildInkTextMirrorText(lines: InkTextLine[]): string {
  return lines
    .map((line) => line.serializedText ?? joinInkTextTokens(line.tokens))
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function getListKind(listKind: string): InkTextLineKind {
  const lowered = listKind.trim().toLowerCase();
  if (lowered.includes('check')) return 'checklist';
  if (lowered.includes('order') || lowered.includes('sequence') || lowered.includes('number')) return 'ordered';
  return 'bullet';
}

function normalizeCheckState(value: string): InkTextCheckState {
  const lowered = value.trim().toLowerCase();
  if (lowered === 'checked') return 'checked';
  if (lowered === 'unchecked') return 'unchecked';
  if (lowered === 'indeterminate') return 'indeterminate';
  return 'none';
}

export function buildMirrorTextFromVisionAnalysis(analysis: StructuredImageAnalysis): string {
  const sections: string[] = [];

  for (const list of analysis.lists) {
    if (list.markdown.trim()) {
      sections.push(list.markdown.trim());
      continue;
    }

    const renderedItems = list.items.map((item) => {
      const indent = ' '.repeat(Math.max(0, item.indentLevel) * INDENT_SPACES);
      const checkState = normalizeCheckState(item.checkState);
      if (getListKind(list.kind) === 'checklist') {
        return `${indent}- [${checkState === 'checked' ? 'x' : ' '}] ${item.text.trim()}`.trimEnd();
      }
      if (getListKind(list.kind) === 'ordered') {
        const marker = item.marker.trim() || `${item.order}.`;
        const normalizedMarker = marker.replace(/[.)-]?$/, '.');
        return `${indent}${normalizedMarker} ${item.text.trim()}`.trimEnd();
      }
      return `${indent}- ${item.text.trim()}`.trimEnd();
    }).filter(Boolean);

    if (renderedItems.length > 0) {
      sections.push(renderedItems.join('\n'));
    }
  }

  for (const block of analysis.blocks) {
    if (block.markdown.trim()) {
      sections.push(block.markdown.trim());
    } else if (block.text.trim()) {
      sections.push(block.text.trim());
    }
  }

  for (const table of analysis.tables) {
    if (table.markdown.trim()) {
      sections.push(table.markdown.trim());
    } else if (table.cells.length > 0 && table.rowCount > 0 && table.columnCount > 0) {
      // Reconstruct a markdown table from cell data when the model didn't
      // emit a pre-formed markdown string.
      const grid: string[][] = Array.from({ length: table.rowCount }, () =>
        Array.from({ length: table.columnCount }, () => ''),
      );
      for (const cell of table.cells) {
        const r = Math.max(0, Math.min(cell.row, table.rowCount - 1));
        const c = Math.max(0, Math.min(cell.column, table.columnCount - 1));
        grid[r][c] = cell.text.replace(/\|/g, '\\|').trim();
      }
      const hasHeaderRow = table.cells.some((cell) => cell.isHeader && cell.row === 0);
      const rows = grid.map((row) => `| ${row.join(' | ')} |`);
      const separator = `| ${Array(table.columnCount).fill('---').join(' | ')} |`;
      const tableLines = hasHeaderRow
        ? [rows[0], separator, ...rows.slice(1)]
        : [rows[0], separator, ...rows.slice(1)];
      const md = tableLines.join('\n');
      if (md.trim()) sections.push(md);
    }
  }

  if (sections.length === 0 && analysis.markdown.trim()) {
    sections.push(analysis.markdown.trim());
  }

  if (sections.length > 0) {
    return sections.join('\n\n').trim();
  }

  return analysis.normalizedText.trim() || analysis.plainText.trim() || analysis.summary.trim();
}

export function applyVisionAnalysisToLines(
  lines: InkTextLine[],
  analysis: StructuredImageAnalysis,
): InkTextLine[] {
  const nextLines = lines.map((line) => ({ ...line }));
  const flattenedItems = analysis.lists.flatMap((list) =>
    list.items.map((item) => ({
      kind: getListKind(list.kind),
      title: list.title,
      text: item.text.trim(),
      markerText: item.marker.trim(),
      order: item.order,
      indentLevel: Math.max(0, item.indentLevel),
      checkState: normalizeCheckState(item.checkState),
    })),
  );

  if (flattenedItems.length === 0) {
    return nextLines;
  }

  const candidateIndices = nextLines
    .map((line, index) => ({
      index,
      text: joinInkTextTokens(line.tokens),
      looksListLike:
        line.kind === 'bullet' ||
        line.kind === 'ordered' ||
        line.kind === 'checklist' ||
        trimTokenText(line.markerText ?? '').length > 0,
    }))
    .filter((candidate) => candidate.text || candidate.looksListLike)
    .map((candidate) => candidate.index);

  for (let i = 0; i < flattenedItems.length && i < candidateIndices.length; i += 1) {
    const targetIndex = candidateIndices[i];
    const targetLine = nextLines[targetIndex];
    const item = flattenedItems[i];

    targetLine.kind = item.kind;
    targetLine.markerText = item.markerText || targetLine.markerText;
    targetLine.order = item.kind === 'ordered' ? item.order : undefined;
    targetLine.indentLevel = item.indentLevel;
    targetLine.checkState = item.kind === 'checklist' ? item.checkState : 'none';
    targetLine.structureConfidence = Math.max(targetLine.structureConfidence ?? 0, 0.85);
    targetLine.serializedText = formatStructuredLine(
      {
        ...targetLine,
        kind: item.kind,
        markerText: item.markerText || targetLine.markerText,
        order: item.order,
        indentLevel: item.indentLevel,
        checkState: item.kind === 'checklist' ? item.checkState : 'none',
      },
      item.text || joinInkTextTokens(targetLine.tokens),
    );
  }

  return nextLines;
}

export function shouldUseVisionNoteFallback(lines: InkTextLine[]): boolean {
  const structured = applyLocalNoteStructure(lines);
  const rawMetrics = createMetrics(regroupInkTextLinesByVisualRows(lines));
  const texts = structured.map((line) => joinInkTextTokens(line.tokens));
  const markerOnlyCount = structured.filter((line, index) => {
    const raw = texts[index].trim();
    return raw.length > 0 && (line.serializedText ?? '') === '' && line.kind === 'unknown';
  }).length;
  const ambiguousStructuredCount = structured.filter((line) =>
    (line.kind === 'bullet' || line.kind === 'ordered' || line.kind === 'checklist') &&
    (line.structureConfidence ?? 0) < 0.78,
  ).length;
  const singleCharLowConfidenceCount = structured.filter((line, index) =>
    texts[index].trim().length === 1 && (line.structureConfidence ?? 0.5) < 0.72,
  ).length;
  const inlineAmbiguousMarkerCount = rawMetrics.filter((metric) =>
    !!metric.inlineMatch?.marker.ambiguous &&
    (
      (metric.inlineMatch.firstTokenRemainder?.trim().length ?? 0) > 0 ||
      joinInkTextTokens(metric.leadingTokens.slice(metric.inlineMatch.tokenCountUsed)).length > 0
    ),
  ).length;
  const listLikeCandidateCount = rawMetrics.filter((metric) => metric.potentialMarker || metric.inlineMatch).length;
  const structuredListCount = structured.filter((line) =>
    line.kind === 'bullet' || line.kind === 'ordered' || line.kind === 'checklist',
  ).length;

  // Also trigger vision for any multi-line ink region — tables produce multiple
  // rows that local detection just calls "paragraph", and even well-recognised
  // plain lists benefit from a second pass on spatial layout.
  const nonEmptyLineCount = structured.filter(
    (line) => joinInkTextTokens(line.tokens).trim().length > 0,
  ).length;

  return (
    markerOnlyCount > 0 ||
    ambiguousStructuredCount > 0 ||
    singleCharLowConfidenceCount >= 2 ||
    inlineAmbiguousMarkerCount > 0 ||
    (listLikeCandidateCount >= 2 && structuredListCount === 0) ||
    nonEmptyLineCount >= 2
  );
}
