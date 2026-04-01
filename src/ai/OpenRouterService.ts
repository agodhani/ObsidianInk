// OpenRouter service - client for LLM inference via OpenRouter
//
// WARNING: The API key (INK_OPENROUTER_API_KEY) is embedded into the client
// bundle at build time and visible in browser DevTools. Only use a scoped,
// low-privilege, rate-limited key. For production, route calls through a
// backend proxy that holds the secret server-side.

import { OpenRouter } from '@openrouter/sdk';

let openRouterInstance: OpenRouter | null = null;

export type ImageDetailLevel = 'low' | 'high' | 'auto';

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: ImageDetailLevel } };

function getOpenRouter(): OpenRouter {
  if (!openRouterInstance) {
    const apiKey = import.meta.env.INK_OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'INK_OPENROUTER_API_KEY is not set. ' +
        'Add it to your .env.local file (see .env.example).'
      );
    }

    openRouterInstance = new OpenRouter({
      apiKey,
      httpReferer: import.meta.env.INK_OPENROUTER_SITE_URL || window.location.origin,
      xTitle: import.meta.env.INK_OPENROUTER_SITE_NAME || 'Ink Playground',
    });
  }
  return openRouterInstance;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface JsonSchema {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** JSON mode: 'json' for unstructured JSON, or a json_schema for structured output. */
  responseFormat?: 'json' | { type: 'json_schema'; jsonSchema: JsonSchema };
}

const DEFAULT_MODEL = 'google/gemini-2.5-flash';

const STRUCTURED_IMAGE_ANALYSIS_PROMPT =
  'You convert screenshots, whiteboards, sketches, handwritten tables, and diagrams ' +
  'into structured text for downstream question answering. Treat shapes and layout as ' +
  'first-class information. If a hand-drawn shape is clearly intended to be a square, ' +
  'rectangle, table cell, connector, or arrow, normalize it to that intent instead of ' +
  'describing it vaguely. Preserve exact visible text whenever possible, including punctuation, ' +
  'line breaks, numbering, bullet markers, checkbox state, and indentation. Preserve numbers, ' +
  'labels, reading order, grouping, row/column structure, and containment relationships. Emit ' +
  'note-taking-friendly markdown, explicit text blocks, explicit lists, explicit tables, and ' +
  'explicit nodes and edges when diagrams are present. Use blocks for titles, headings, paragraphs, ' +
  'callouts, equations, code, legends, captions, or free text. Use lists for bulleted lists, ' +
  'checklists, and ordered sequences. Only add edges when a connection is visually explicit. For ' +
  'segmented rectangles, swimlanes, timelines, or box groups, emit nodes even if there are no arrows. ' +
  'If a layout is clearly tabular, also emit a table. Record ambiguity in uncertainties instead of guessing.';

const STRUCTURED_IMAGE_RESPONSE_FORMAT: { type: 'json_schema'; jsonSchema: JsonSchema } = {
  type: 'json_schema',
  jsonSchema: {
    name: 'structured_image_analysis',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        plainText: { type: 'string' },
        normalizedText: { type: 'string' },
        markdown: { type: 'string' },
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              text: { type: 'string' },
              markdown: { type: 'string' },
            },
            required: ['id', 'kind', 'text', 'markdown'],
          },
        },
        lists: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              title: { type: 'string' },
              markdown: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    text: { type: 'string' },
                    marker: { type: 'string' },
                    order: { type: 'integer' },
                    indentLevel: { type: 'integer' },
                    checkState: { type: 'string' },
                    parentId: { type: 'string' },
                  },
                  required: ['id', 'text', 'marker', 'order', 'indentLevel', 'checkState', 'parentId'],
                },
              },
            },
            required: ['id', 'kind', 'title', 'markdown', 'items'],
          },
        },
        tables: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              markdown: { type: 'string' },
              rowCount: { type: 'integer' },
              columnCount: { type: 'integer' },
              cells: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    row: { type: 'integer' },
                    column: { type: 'integer' },
                    text: { type: 'string' },
                    isHeader: { type: 'boolean' },
                  },
                  required: ['row', 'column', 'text', 'isHeader'],
                },
              },
            },
            required: ['id', 'title', 'description', 'markdown', 'rowCount', 'columnCount', 'cells'],
          },
        },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              shape: { type: 'string' },
              label: { type: 'string' },
              text: { type: 'string' },
              description: { type: 'string' },
              parentId: { type: 'string' },
            },
            required: ['id', 'kind', 'shape', 'label', 'text', 'description', 'parentId'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              kind: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
              directed: { type: 'boolean' },
            },
            required: ['id', 'from', 'to', 'kind', 'label', 'description', 'directed'],
          },
        },
        relationships: {
          type: 'array',
          items: { type: 'string' },
        },
        uncertainties: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: [
        'summary',
        'plainText',
        'normalizedText',
        'markdown',
        'blocks',
        'lists',
        'tables',
        'nodes',
        'edges',
        'relationships',
        'uncertainties',
      ],
    },
  },
};

export interface StructuredTextBlock {
  id: string;
  kind: string;
  text: string;
  markdown: string;
}

export interface StructuredListItem {
  id: string;
  text: string;
  marker: string;
  order: number;
  indentLevel: number;
  checkState: string;
  parentId: string;
}

export interface StructuredList {
  id: string;
  kind: string;
  title: string;
  markdown: string;
  items: StructuredListItem[];
}

export interface StructuredTableCell {
  row: number;
  column: number;
  text: string;
  isHeader: boolean;
}

export interface StructuredTable {
  id: string;
  title: string;
  description: string;
  markdown: string;
  rowCount: number;
  columnCount: number;
  cells: StructuredTableCell[];
}

export interface StructuredImageNode {
  id: string;
  kind: string;
  shape: string;
  label: string;
  text: string;
  description: string;
  parentId: string;
}

export interface StructuredImageEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  label: string;
  description: string;
  directed: boolean;
}

export interface StructuredImageAnalysis {
  summary: string;
  plainText: string;
  normalizedText: string;
  markdown: string;
  blocks: StructuredTextBlock[];
  lists: StructuredList[];
  tables: StructuredTable[];
  nodes: StructuredImageNode[];
  edges: StructuredImageEdge[];
  relationships: string[];
  uncertainties: string[];
}

export interface ImageAnalysisOptions {
  model?: string;
  question?: string;
  additionalInstructions?: string;
  detail?: ImageDetailLevel;
  maxTokens?: number;
}

export interface ImageQuestionOptions extends ImageAnalysisOptions {
  answerModel?: string;
  answerMaxTokens?: number;
}

export interface ImageQuestionAnswer {
  analysis: StructuredImageAnalysis;
  answer: string;
}

function getDefaultVisionModel(): string {
  return import.meta.env.INK_OPENROUTER_VISION_MODEL || DEFAULT_MODEL;
}

function buildImageAnalysisPrompt(options: ImageAnalysisOptions = {}): string {
  const instructions = [
    'Extract the image into structured text.',
    'Focus on note-taking structure: text fidelity, blocks, lists, ordered sequences, tables, nodes, edges, containers, labels, and spatial relationships.',
    'Return markdown that preserves readable note structure. Use markdown tables for true grids.',
    'Preserve bullets, numbering, checkbox state, indentation, and line breaks in both plainText and markdown.',
    'Emit lists whenever text is arranged as bullets, steps, outlines, or checklists.',
    'For diagrams, identify nodes and edges explicitly instead of only describing them.',
  ];

  if (options.question?.trim()) {
    instructions.push(`Downstream question to support: ${options.question.trim()}`);
  }

  if (options.additionalInstructions?.trim()) {
    instructions.push(options.additionalInstructions.trim());
  }

  return instructions.join('\n\n');
}

/**
 * Send a chat completion request via OpenRouter.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const client = getOpenRouter();

  // Map our responseFormat to the SDK's expected shape
  let responseFormat: { type: 'json_object' } | { type: 'json_schema'; jsonSchema: { name: string; strict?: boolean; schema: Record<string, unknown> } } | undefined;
  if (options.responseFormat === 'json') {
    responseFormat = { type: 'json_object' };
  } else if (options.responseFormat) {
    responseFormat = {
      type: 'json_schema',
      jsonSchema: options.responseFormat.jsonSchema,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completion: any = await client.chat.send({
    chatGenerationParams: {
      model: options.model ?? DEFAULT_MODEL,
      // Cast messages — our ChatMessage type is compatible but TS can't
      // narrow the discriminated union from a mapped array.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      stream: false,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      responseFormat,
    },
  });

  return completion?.choices?.[0]?.message?.content?.toString() ?? '';
}

/**
 * Convenience: send a chat request and parse the response as JSON.
 */
export async function chatCompletionJSON<T = unknown>(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<T> {
  const raw = await chatCompletion(messages, {
    ...options,
    responseFormat: options.responseFormat ?? 'json',
  });
  return JSON.parse(raw) as T;
}

/**
 * Check whether the OpenRouter API key is configured.
 */
export function isOpenRouterConfigured(): boolean {
  return !!import.meta.env.INK_OPENROUTER_API_KEY;
}

/**
 * Extract a structured transcription from an image so later questions can
 * reason over stable text instead of the raw bitmap alone.
 */
export async function analyzeImageContent(
  imageDataUrl: string,
  options: ImageAnalysisOptions = {},
): Promise<StructuredImageAnalysis> {
  return chatCompletionJSON<StructuredImageAnalysis>(
    [
      {
        role: 'system',
        content: STRUCTURED_IMAGE_ANALYSIS_PROMPT,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildImageAnalysisPrompt(options),
          },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl,
              detail: options.detail ?? 'high',
            },
          },
        ],
      },
    ],
    {
      model: options.model ?? getDefaultVisionModel(),
      temperature: 0,
      maxTokens: options.maxTokens ?? 1600,
      responseFormat: STRUCTURED_IMAGE_RESPONSE_FORMAT,
    },
  );
}

/**
 * Turn structured image analysis into indexable text that can be stored in a
 * note mirror or passed into a grounded Q&A flow.
 */
export function formatStructuredImageAnalysisAsText(
  analysis: StructuredImageAnalysis,
): string {
  const sections: string[] = [`Summary:\n${analysis.summary.trim()}`];

  if (analysis.plainText.trim()) {
    sections.push(`Raw transcription:\n${analysis.plainText.trim()}`);
  }

  if (analysis.normalizedText.trim()) {
    sections.push(`Normalized structure:\n${analysis.normalizedText.trim()}`);
  }

  if (analysis.markdown.trim()) {
    sections.push(`Markdown notes:\n${analysis.markdown.trim()}`);
  }

  if (analysis.blocks.length > 0) {
    const blocks = analysis.blocks
      .map((block) => {
        const details = [block.text.trim(), block.markdown.trim()]
          .filter(Boolean)
          .filter((value, index, all) => all.indexOf(value) === index)
          .join(' | ');
        return `- ${block.id} (${block.kind}): ${details}`;
      })
      .join('\n');
    sections.push(`Blocks:\n${blocks}`);
  }

  if (analysis.lists.length > 0) {
    const lists = analysis.lists
      .map((list) => {
        const header = [`- ${list.id}`, list.kind.trim(), list.title.trim()]
          .filter(Boolean)
          .join(' | ');
        const itemSummary = list.items
          .map((item) => {
            const details = [
              `#${item.order}`,
              item.marker.trim() ? `marker="${item.marker.trim()}"` : '',
              `indent=${item.indentLevel}`,
              item.checkState.trim() && item.checkState.trim() !== 'none'
                ? `check=${item.checkState.trim()}`
                : '',
              item.parentId.trim() ? `parent=${item.parentId.trim()}` : '',
              item.text.trim(),
            ]
              .filter(Boolean)
              .join(' | ');
            return `  - ${item.id}: ${details}`;
          })
          .join('\n');
        return `${header}\n${list.markdown.trim()}${itemSummary ? `\nItems:\n${itemSummary}` : ''}`;
      })
      .join('\n\n');
    sections.push(`Lists:\n${lists}`);
  }

  if (analysis.tables.length > 0) {
    const tables = analysis.tables
      .map((table) => {
        const header = [`- ${table.id}`, table.title.trim(), table.description.trim()]
          .filter(Boolean)
          .join(' | ');
        const cellSummary = table.cells
          .map((cell) => `[r${cell.row} c${cell.column}${cell.isHeader ? ' header' : ''}] ${cell.text.trim()}`)
          .filter(Boolean)
          .join('; ');
        return `${header}\n${table.markdown.trim()}\nCells: ${cellSummary}`;
      })
      .join('\n\n');
    sections.push(`Tables:\n${tables}`);
  }

  if (analysis.nodes.length > 0) {
    const nodes = analysis.nodes
      .map((node) => {
        const details = [
          node.shape.trim() ? `[${node.shape.trim()}]` : '',
          node.label.trim() ? `label="${node.label.trim()}"` : '',
          node.text.trim(),
          node.description.trim(),
          node.parentId.trim() ? `parent=${node.parentId.trim()}` : '',
        ]
          .filter(Boolean)
          .join(' | ');
        return `- ${node.id} (${node.kind}): ${details}`;
      })
      .join('\n');
    sections.push(`Nodes:\n${nodes}`);
  }

  if (analysis.edges.length > 0) {
    const edges = analysis.edges
      .map((edge) => {
        const direction = edge.directed ? '->' : '--';
        const details = [edge.kind.trim(), edge.label.trim(), edge.description.trim()]
          .filter(Boolean)
          .join(' | ');
        return `- ${edge.id}: ${edge.from} ${direction} ${edge.to}${details ? ` | ${details}` : ''}`;
      })
      .join('\n');
    sections.push(`Edges:\n${edges}`);
  }

  if (analysis.relationships.length > 0) {
    sections.push(`Relationships:\n${analysis.relationships.map((item) => `- ${item}`).join('\n')}`);
  }

  if (analysis.uncertainties.length > 0) {
    sections.push(`Uncertainties:\n${analysis.uncertainties.map((item) => `- ${item}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * Recommended multimodal flow: transcribe the picture first, then answer from
 * the structured transcription.
 */
export async function answerQuestionAboutImage(
  imageDataUrl: string,
  question: string,
  options: ImageQuestionOptions = {},
): Promise<ImageQuestionAnswer> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error('question is required');
  }

  const analysis = await analyzeImageContent(imageDataUrl, {
    ...options,
    question: trimmedQuestion,
  });

  const answer = await chatCompletion(
    [
      {
        role: 'system',
        content:
          'Answer the user question using the structured image transcription. ' +
          'If the transcription is ambiguous or incomplete, say so plainly instead of inventing details.',
      },
      {
        role: 'user',
        content:
          `Question:\n${trimmedQuestion}\n\n` +
          `Structured image transcription:\n${formatStructuredImageAnalysisAsText(analysis)}`,
      },
    ],
    {
      model: options.answerModel ?? options.model ?? DEFAULT_MODEL,
      temperature: 0,
      maxTokens: options.answerMaxTokens ?? 500,
    },
  );

  return { analysis, answer };
}
