import type { NoteElements } from '../types';
import type {
  FolderSummary,
  NoteRecord,
  ResearchResponse,
  ResolvedWikiLink,
  VaultBootstrap,
  VaultSearchResponse,
  WikiLinkMatch,
} from './types';

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = response.statusText;
    try {
      const payload = await response.json();
      message = String(payload.error ?? payload.message ?? message);
    } catch {
      // Ignore JSON parsing errors and keep the status text.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export async function fetchVaultBootstrap(): Promise<VaultBootstrap> {
  return parseResponse(await fetch('/api/vault/bootstrap'));
}

export async function fetchNote(noteId: string): Promise<NoteRecord> {
  return parseResponse(await fetch(`/api/notes/${noteId}`));
}

export async function createFolder(name: string, parentId: string | null): Promise<FolderSummary> {
  return parseResponse(
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId }),
    }),
  );
}

export async function createNote(payload: {
  title: string;
  folderId: string | null;
  noteCanvas?: NoteElements;
  noteText?: string;
}): Promise<NoteRecord> {
  return parseResponse(
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function saveNote(note: {
  id: string;
  title: string;
  folderId: string | null;
  noteCanvas: NoteElements;
  noteText: string;
}): Promise<NoteRecord> {
  return parseResponse(
    await fetch(`/api/notes/${note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note),
    }),
  );
}

export async function searchVault(query: string, sourceNoteId?: string): Promise<VaultSearchResponse> {
  const searchParams = new URLSearchParams({ q: query });
  if (sourceNoteId) searchParams.set('sourceNoteId', sourceNoteId);
  return parseResponse(await fetch(`/api/search?${searchParams.toString()}`));
}

export async function searchWikiLinks(query: string, sourceNoteId?: string): Promise<WikiLinkMatch[]> {
  const searchParams = new URLSearchParams({ q: query });
  if (sourceNoteId) searchParams.set('sourceNoteId', sourceNoteId);
  const payload = await parseResponse<{ matches: WikiLinkMatch[] }>(await fetch(`/api/wiki-links?${searchParams.toString()}`));
  return payload.matches;
}

export async function createResolvedLink(noteId: string, rawText: string, targetNoteId: string): Promise<Pick<ResolvedWikiLink, 'id' | 'rawText' | 'targetNoteId'>> {
  return parseResponse(
    await fetch(`/api/notes/${noteId}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText, targetNoteId }),
    }),
  );
}

export async function uploadReferenceFile(file: File): Promise<{ id: string; name: string; status: string }> {
  const formData = new FormData();
  formData.append('file', file);

  return parseResponse(
    await fetch('/api/uploads', {
      method: 'POST',
      body: formData,
    }),
  );
}

export async function researchQuestion(question: string, sourceNoteId?: string): Promise<ResearchResponse> {
  return parseResponse(
    await fetch('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, sourceNoteId }),
    }),
  );
}
