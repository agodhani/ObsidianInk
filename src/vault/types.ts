import type { NoteElements } from '../types';

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  folderId: string | null;
  noteText: string;
  excerpt: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DocumentSummary {
  id: string;
  name: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResolvedWikiLink {
  id: string;
  rawText: string;
  targetNoteId: string;
  targetTitle: string;
}

export interface NoteRecord {
  id: string;
  title: string;
  folderId: string | null;
  noteCanvas: NoteElements;
  noteText: string;
  resolvedLinks: ResolvedWikiLink[];
  createdAt?: string;
  updatedAt?: string;
}

export interface VaultBootstrap {
  folders: FolderSummary[];
  notes: NoteSummary[];
  documents: DocumentSummary[];
}

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
}

export interface VaultSearchResponse {
  notes: SearchResult[];
  documents: SearchResult[];
}

export interface WikiLinkMatch {
  noteId: string;
  title: string;
  snippet: string;
  score: number;
  isExactTitleMatch: boolean;
}

export interface ResearchSource {
  kind: 'note' | 'document';
  id: string;
  title: string;
  snippet: string;
  score: number;
}

export interface ResearchResponse {
  answer: string;
  sources: ResearchSource[];
  fallbackUsed: boolean;
  grounded: boolean;
}
