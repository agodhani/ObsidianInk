// InkTextElement: Recognized handwriting with tokens

import type { Quad } from '../../types/primitives';
import type { TransformableElement } from '../../types/primitives';
import type { Stroke } from '../../types/brush';

export interface InkTextToken {
  text: string;
  quad: Quad; // Bounding quad for this token
  strokeIndices: number[]; // Indices into sourceStrokes
  baseline?: number; // Y position of text baseline
  confidence?: number;
}

export type InkTextLineKind = 'paragraph' | 'bullet' | 'ordered' | 'checklist' | 'heading' | 'unknown';
export type InkTextCheckState = 'checked' | 'unchecked' | 'indeterminate' | 'none';

export interface InkTextLine {
  tokens: InkTextToken[];
  baseline: number;
  kind?: InkTextLineKind;
  markerText?: string;
  indentLevel?: number;
  order?: number;
  checkState?: InkTextCheckState;
  structureConfidence?: number;
  serializedText?: string;
}

export interface InkTextElement extends TransformableElement {
  type: 'inkText';
  lines: InkTextLine[];
  sourceStrokes: Stroke[];
  layoutWidth?: number; // Width for text wrapping
  writingAngle?: number; // Estimated writing angle in radians
  mirrorText?: string;
}
