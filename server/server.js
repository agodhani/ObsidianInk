import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const uploadDir = path.resolve(rootDir, process.env.LOCAL_UPLOAD_DIR ?? './data/uploads');
const port = Number(process.env.PORT ?? 3001);
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const ollamaChatModel = process.env.OLLAMA_CHAT_MODEL ?? 'llama3.1';
const openRouterApiKey = process.env.OPENROUTER_LLMCHAT_API_KEY ?? '';
const openRouterModel = process.env.OPENROUTER_LLMCHAT_MODEL ?? '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/obsidianink',
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

function chunkText(text, maxLength = 700) {
  const sanitized = text.replace(/\r/g, '').trim();
  if (!sanitized) return [];

  const paragraphs = sanitized
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      chunks.push(paragraph);
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let current = '';
    for (const sentence of sentences) {
      if ((current + sentence).length > maxLength && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = `${current} ${sentence}`.trim();
      }
    }
    if (current) chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [sanitized.slice(0, maxLength)];
}

function normalizeSearchQuery(query) {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const terms = [...new Set(
    phrase
      .split(/\s+/)
      .map((term) => term.replace(/[^a-z0-9]/g, ''))
      .filter(Boolean),
  )];

  return { phrase, terms };
}

function countMatches(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;

  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }

  return count;
}

function buildKeywordSnippet(text, phrase, terms, fallback = 'No text yet.') {
  const condensed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!condensed) return fallback;

  const haystack = condensed.toLowerCase();
  let index = phrase ? haystack.indexOf(phrase) : -1;

  if (index === -1) {
    for (const term of terms) {
      index = haystack.indexOf(term);
      if (index !== -1) break;
    }
  }

  if (index === -1) {
    return condensed.slice(0, 240);
  }

  const start = Math.max(0, index - 72);
  const end = Math.min(condensed.length, index + 168);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < condensed.length ? '...' : '';
  return `${prefix}${condensed.slice(start, end).trim()}${suffix}`;
}

function scoreKeywordMatch(title, text, phrase, terms) {
  const titleLower = String(title ?? '').toLowerCase();
  const textLower = String(text ?? '').toLowerCase();
  const exactTitle = phrase ? titleLower === phrase : false;
  const titlePhrase = phrase ? titleLower.includes(phrase) : false;
  const textPhrase = phrase ? textLower.includes(phrase) : false;

  let titleTermHits = 0;
  let textTermHits = 0;
  for (const term of terms) {
    if (titleLower.includes(term)) titleTermHits += countMatches(titleLower, term);
    if (textLower.includes(term)) textTermHits += countMatches(textLower, term);
  }

  if (!exactTitle && !titlePhrase && !textPhrase && titleTermHits === 0 && textTermHits === 0) {
    return null;
  }

  return (
    (exactTitle ? 240 : 0) +
    (titlePhrase ? 140 : 0) +
    (textPhrase ? 90 : 0) +
    titleTermHits * 24 +
    textTermHits * 10
  );
}

function keywordSearch(records, {
  titleKey,
  textKey,
  phrase,
  terms,
  limit = 12,
  fallbackSnippet,
}) {
  return records
    .map((record) => {
      const title = String(record[titleKey] ?? '');
      const text = String(record[textKey] ?? '');
      const score = scoreKeywordMatch(title, text, phrase, terms);
      if (score === null) return null;

      return {
        id: record.id,
        title,
        snippet: buildKeywordSnippet(text, phrase, terms, fallbackSnippet),
        score,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.title.localeCompare(right.title);
    })
    .slice(0, limit);
}

async function answerWithOllama(question, context) {
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaChatModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are a research assistant for a handwritten notes app. Answer concisely and cite the provided sources by title when possible. If evidence is weak, say so.',
        },
        {
          role: 'user',
          content: `Question:\n${question}\n\nContext:\n${context}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama chat request failed (${response.status})`);
  }

  const payload = await response.json();
  return payload?.message?.content?.toString() ?? '';
}

async function answerWithOpenRouter(question, context) {
  if (!openRouterApiKey || !openRouterModel) {
    throw new Error('OpenRouter fallback is not configured');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openRouterModel,
      messages: [
        {
          role: 'system',
          content: 'You are a research assistant for a handwritten notes app. Use the provided context first, and mention when you need to rely on general knowledge.',
        },
        {
          role: 'user',
          content: `Question:\n${question}\n\nContext:\n${context}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status})`);
  }

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content?.toString() ?? '';
}

async function ensureStorage() {
  await fs.mkdir(uploadDir, { recursive: true });
}

async function ensureSchema() {
  const initSql = await fs.readFile(path.join(__dirname, 'init.sql'), 'utf8');
  await pool.query(initSql);
}

async function reindexNote(noteId, noteText) {
  const chunks = chunkText(noteText);
  await pool.query('DELETE FROM note_chunks WHERE note_id = $1', [noteId]);

  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index];
    await pool.query(
      `INSERT INTO note_chunks (id, note_id, chunk_index, content)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), noteId, index, content],
    );
  }
}

async function reindexDocument(documentId, text) {
  const chunks = chunkText(text);
  await pool.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);

  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index];
    await pool.query(
      `INSERT INTO document_chunks (id, document_id, chunk_index, content)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), documentId, index, content],
    );
  }
}

async function ensureSeedData() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM notes');
  if (rows[0]?.count > 0) return;

  const inboxId = randomUUID();
  const noteId = randomUUID();
  await pool.query('INSERT INTO folders (id, name) VALUES ($1, $2)', [inboxId, 'Inbox']);
  await pool.query(
    `INSERT INTO notes (id, title, folder_id, canvas_json, note_text)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      noteId,
      'Welcome Note',
      inboxId,
      JSON.stringify({ elements: [], version: 1, metadata: { title: 'Welcome Note' } }),
      'Write on the canvas to build your mirrored text note. Use [[links]] to connect notes and ??? questions to research uploaded sources.',
    ],
  );
  await reindexNote(
    noteId,
    'Write on the canvas to build your mirrored text note. Use [[links]] to connect notes and ??? questions to research uploaded sources.',
  );
}

async function serializeVault() {
  const [foldersResult, notesResult, documentsResult] = await Promise.all([
    pool.query('SELECT id, name, parent_id AS "parentId", created_at AS "createdAt", updated_at AS "updatedAt" FROM folders ORDER BY lower(name) ASC'),
    pool.query(`
      SELECT
        id,
        title,
        folder_id AS "folderId",
        note_text AS "noteText",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM notes
      ORDER BY updated_at DESC
    `),
    pool.query('SELECT id, name, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM documents ORDER BY updated_at DESC'),
  ]);

  return {
    folders: foldersResult.rows,
    notes: notesResult.rows.map((note) => ({
      ...note,
      excerpt: note.noteText.slice(0, 180),
    })),
    documents: documentsResult.rows,
  };
}

async function searchVault(query, sourceNoteId) {
  const trimmed = query.trim();
  if (!trimmed) return { notes: [], documents: [] };

  const { phrase, terms } = normalizeSearchQuery(trimmed);
  const notePromise = sourceNoteId
    ? pool.query(
      `
        SELECT id, title, note_text AS "noteText"
        FROM notes
        WHERE id <> $1
      `,
      [sourceNoteId],
    )
    : pool.query(
      `
        SELECT id, title, note_text AS "noteText"
        FROM notes
      `,
    );
  const documentPromise = pool.query(
    `
      SELECT id, name, extracted_text AS "extractedText"
      FROM documents
    `,
  );

  const [noteResult, documentResult] = await Promise.all([notePromise, documentPromise]);

  return {
    notes: keywordSearch(noteResult.rows, {
      titleKey: 'title',
      textKey: 'noteText',
      phrase,
      terms,
      limit: 12,
      fallbackSnippet: 'Empty note',
    }),
    documents: keywordSearch(documentResult.rows, {
      titleKey: 'name',
      textKey: 'extractedText',
      phrase,
      terms,
      limit: 12,
      fallbackSnippet: 'No extracted text yet.',
    }),
  };
}

app.get('/api/health', async (_request, response) => {
  const result = await pool.query('SELECT NOW() AS now');
  response.json({ ok: true, now: result.rows[0]?.now });
});

app.get('/api/vault/bootstrap', async (_request, response) => {
  response.json(await serializeVault());
});

app.post('/api/folders', async (request, response) => {
  const folder = {
    id: randomUUID(),
    name: String(request.body.name ?? 'Untitled Folder').trim() || 'Untitled Folder',
    parentId: request.body.parentId ?? null,
  };

  await pool.query(
    `INSERT INTO folders (id, name, parent_id)
     VALUES ($1, $2, $3)`,
    [folder.id, folder.name, folder.parentId],
  );

  response.status(201).json(folder);
});

app.post('/api/notes', async (request, response) => {
  const note = {
    id: randomUUID(),
    title: String(request.body.title ?? 'Untitled Note').trim() || 'Untitled Note',
    folderId: request.body.folderId ?? null,
    noteCanvas: request.body.noteCanvas ?? { elements: [], version: 1, metadata: {} },
    noteText: String(request.body.noteText ?? ''),
  };

  await pool.query(
    `INSERT INTO notes (id, title, folder_id, canvas_json, note_text)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [note.id, note.title, note.folderId, JSON.stringify(note.noteCanvas), note.noteText],
  );
  await reindexNote(note.id, note.noteText);

  response.status(201).json(note);
});

app.get('/api/notes/:noteId', async (request, response) => {
  const { rows } = await pool.query(
    `
      SELECT
        id,
        title,
        folder_id AS "folderId",
        canvas_json AS "noteCanvas",
        note_text AS "noteText",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM notes
      WHERE id = $1
    `,
    [request.params.noteId],
  );

  const note = rows[0];
  if (!note) {
    response.status(404).json({ error: 'Note not found' });
    return;
  }

  const linksResult = await pool.query(
    `
      SELECT
        nl.id,
        nl.raw_text AS "rawText",
        nl.target_note_id AS "targetNoteId",
        n.title AS "targetTitle"
      FROM note_links nl
      JOIN notes n ON n.id = nl.target_note_id
      WHERE nl.source_note_id = $1
      ORDER BY lower(n.title) ASC
    `,
    [request.params.noteId],
  );

  response.json({
    ...note,
    resolvedLinks: linksResult.rows,
  });
});

app.put('/api/notes/:noteId', async (request, response) => {
  const title = String(request.body.title ?? 'Untitled Note').trim() || 'Untitled Note';
  const folderId = request.body.folderId ?? null;
  const noteCanvas = request.body.noteCanvas ?? { elements: [], version: 1, metadata: {} };
  const noteText = String(request.body.noteText ?? '');

  await pool.query(
    `
      UPDATE notes
      SET
        title = $2,
        folder_id = $3,
        canvas_json = $4::jsonb,
        note_text = $5,
        updated_at = NOW()
      WHERE id = $1
    `,
    [request.params.noteId, title, folderId, JSON.stringify(noteCanvas), noteText],
  );

  await reindexNote(request.params.noteId, noteText);

  response.json({
    id: request.params.noteId,
    title,
    folderId,
    noteCanvas,
    noteText,
  });
});

app.delete('/api/notes/:noteId', async (request, response) => {
  const result = await pool.query('DELETE FROM notes WHERE id = $1', [request.params.noteId]);
  if (result.rowCount === 0) {
    response.status(404).json({ error: 'Note not found' });
    return;
  }

  response.status(204).send();
});

app.get('/api/wiki-links', async (request, response) => {
  const query = String(request.query.q ?? '').trim();
  const sourceNoteId = typeof request.query.sourceNoteId === 'string' ? request.query.sourceNoteId : undefined;
  const results = await searchVault(query, sourceNoteId);

  response.json({
    matches: results.notes.map((result) => ({
      noteId: result.id,
      title: result.title,
      snippet: result.snippet,
      score: Number(result.score),
      isExactTitleMatch: result.title.toLowerCase() === query.toLowerCase(),
    })),
  });
});

app.post('/api/notes/:noteId/links', async (request, response) => {
  const { noteId } = request.params;
  const rawText = String(request.body.rawText ?? '').trim();
  const targetNoteId = String(request.body.targetNoteId ?? '').trim();

  if (!rawText || !targetNoteId) {
    response.status(400).json({ error: 'rawText and targetNoteId are required' });
    return;
  }

  const linkId = randomUUID();
  await pool.query(
    `
      INSERT INTO note_links (id, source_note_id, target_note_id, raw_text)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (source_note_id, target_note_id, raw_text) DO NOTHING
    `,
    [linkId, noteId, targetNoteId, rawText],
  );

  response.status(201).json({ id: linkId, sourceNoteId: noteId, targetNoteId, rawText });
});

app.get('/api/search', async (request, response) => {
  const query = String(request.query.q ?? '').trim();
  const sourceNoteId = typeof request.query.sourceNoteId === 'string' ? request.query.sourceNoteId : undefined;
  const results = await searchVault(query, sourceNoteId);
  response.json(results);
});

app.post('/api/uploads', upload.single('file'), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: 'File is required' });
    return;
  }

  const extension = path.extname(request.file.originalname || '').toLowerCase();
  const documentId = randomUUID();
  const safeName = `${documentId}${extension}`;
  const filePath = path.join(uploadDir, safeName);

  await fs.writeFile(filePath, request.file.buffer);

  let extractedText = '';
  try {
    if (request.file.mimetype === 'application/pdf' || extension === '.pdf') {
      const parser = new PDFParse({ data: request.file.buffer });
      const parsed = await parser.getText();
      extractedText = parsed.text ?? '';
      await parser.destroy();
    } else {
      extractedText = request.file.buffer.toString('utf8');
    }
  } catch {
    extractedText = '';
  }

  await pool.query(
    `
      INSERT INTO documents (id, name, mime_type, file_path, extracted_text, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [documentId, request.file.originalname, request.file.mimetype, filePath, extractedText, extractedText ? 'ready' : 'needs_review'],
  );

  if (extractedText.trim()) {
    await reindexDocument(documentId, extractedText);
  }

  response.status(201).json({
    id: documentId,
    name: request.file.originalname,
    status: extractedText.trim() ? 'ready' : 'needs_review',
  });
});

app.post('/api/research', async (request, response) => {
  const question = String(request.body.question ?? '').trim();
  const sourceNoteId = typeof request.body.sourceNoteId === 'string' ? request.body.sourceNoteId : undefined;

  if (!question) {
    response.status(400).json({ error: 'question is required' });
    return;
  }

  const searchResults = await searchVault(question, sourceNoteId);
  const noteSources = searchResults.notes.slice(0, 4).map((item) => ({
    kind: 'note',
    id: item.id,
    title: item.title,
    snippet: item.snippet,
    score: Number(item.score),
  }));
  const documentSources = searchResults.documents.slice(0, 4).map((item) => ({
    kind: 'document',
    id: item.id,
    title: item.title,
    snippet: item.snippet,
    score: Number(item.score),
  }));
  const sources = [...noteSources, ...documentSources]
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);

  const context = sources
    .map((source, index) => `[${index + 1}] ${source.title}\n${source.snippet}`)
    .join('\n\n');

  let answer = '';
  let fallbackUsed = false;
  const grounded = sources.length > 0;

  try {
    answer = await answerWithOllama(question, context || 'No indexed context was found. Answer carefully and say when evidence is missing.');
  } catch {
    fallbackUsed = true;
    try {
      answer = await answerWithOpenRouter(question, context || 'No indexed context was found. Answer carefully and say when evidence is missing.');
    } catch {
      answer = grounded
        ? `I found related material but couldn't reach a model provider. Relevant sources include ${sources.map((source) => source.title).join(', ')}.`
        : 'I could not find indexed source material for that question, and no model provider is currently available.';
    }
  }

  response.json({
    answer,
    sources,
    fallbackUsed,
    grounded,
  });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
});

async function start() {
  await ensureStorage();
  await ensureSchema();
  await ensureSeedData();

  app.listen(port, () => {
    console.log(`ObsidianInk API listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
