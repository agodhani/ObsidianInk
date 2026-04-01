import { analyzeImageContent, isOpenRouterConfigured } from '../../ai/OpenRouterService';
import { getStrokesBounds, renderStrokes } from '../../canvas/StrokeRenderer';
import type { Stroke } from '../../types';
import type { InkTextLine } from './types';
import {
  applyVisionAnalysisToLines,
  buildInkTextMirrorText,
  buildMirrorTextFromVisionAnalysis,
  shouldUseVisionNoteFallback,
} from './noteStructure';

const VISION_PADDING = 24;
const MAX_RENDER_EDGE = 1400;

function renderStrokesToDataUrl(strokes: Stroke[]): string | null {
  const bounds = getStrokesBounds(strokes);
  if (!bounds) return null;

  const width = Math.max(1, Math.ceil(bounds.right - bounds.left + VISION_PADDING * 2));
  const height = Math.max(1, Math.ceil(bounds.bottom - bounds.top + VISION_PADDING * 2));
  const scale = Math.min(2, MAX_RENDER_EDGE / Math.max(width, height, 1));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.translate(-bounds.left + VISION_PADDING, -bounds.top + VISION_PADDING);
  renderStrokes(ctx, strokes);

  return canvas.toDataURL('image/png');
}

export async function enhanceNoteStructureWithVision(
  strokes: Stroke[],
  lines: InkTextLine[],
): Promise<{ lines: InkTextLine[]; mirrorText: string }> {
  const localMirrorText = buildInkTextMirrorText(lines);

  if (!isOpenRouterConfigured() || !shouldUseVisionNoteFallback(lines)) {
    return { lines, mirrorText: localMirrorText };
  }

  const imageDataUrl = renderStrokesToDataUrl(strokes);
  if (!imageDataUrl) {
    return { lines, mirrorText: localMirrorText };
  }

  try {
    const analysis = await analyzeImageContent(imageDataUrl, {
      additionalInstructions:
        'This image is a handwritten note region. Prioritize exact text transcription and note structure. ' +
        'Return note content as plain markdown-style text, using "-", "1.", and "- [ ]" / "- [x]" when appropriate. ' +
        'Preserve empty bullet rows as standalone list markers if the user clearly drew them. ' +
        'Identify bulleted lists, ordered steps, checklists, indentation, and line breaks. ' +
        'Ignore stray scaffold marks that do not pair with note text.',
      maxTokens: 1400,
    });

    const nextLines = applyVisionAnalysisToLines(lines, analysis);
    const mirrorText = buildMirrorTextFromVisionAnalysis(analysis) || buildInkTextMirrorText(nextLines);
    return { lines: nextLines, mirrorText };
  } catch {
    return { lines, mirrorText: localMirrorText };
  }
}
