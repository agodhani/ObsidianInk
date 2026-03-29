import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import './App.css';
import { createEmptyNote, type NoteElements } from './types';
import { Toaster } from './toast/Toast';
import { CanvasNoteEditor } from './features/editor/CanvasNoteEditor';
import {
  createFolder,
  createNote,
  createResolvedLink,
  fetchNote,
  fetchVaultBootstrap,
  researchQuestion,
  saveNote,
  searchVault,
  searchWikiLinks,
  uploadReferenceFile,
} from './vault/api';
import { buildSearchSnippets, extractResearchPrompts, extractWikiLinks } from './vault/noteText';
import type {
  DocumentSummary,
  FolderSummary,
  NoteSummary,
  ResearchResponse,
  ResolvedWikiLink,
  SearchResult,
  VaultSearchResponse,
  WikiLinkMatch,
} from './vault/types';

function noteSnapshot(note: {
  id: string;
  title: string;
  folderId: string | null;
  noteCanvas: NoteElements;
  noteText: string;
}): string {
  return JSON.stringify(note);
}

function orderNotes(notes: NoteSummary[]): NoteSummary[] {
  return [...notes].sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTime - leftTime;
  });
}

function sortFolders(folders: FolderSummary[]): FolderSummary[] {
  return [...folders].sort((left, right) => left.name.localeCompare(right.name));
}

function mergeNoteSummary(notes: NoteSummary[], note: {
  id: string;
  title: string;
  folderId: string | null;
  noteText: string;
  updatedAt?: string;
}): NoteSummary[] {
  const next = notes.filter((entry) => entry.id !== note.id);
  next.push({
    id: note.id,
    title: note.title,
    folderId: note.folderId,
    noteText: note.noteText,
    excerpt: note.noteText.slice(0, 180),
    updatedAt: note.updatedAt ?? new Date().toISOString(),
  });
  return orderNotes(next);
}

function renderFolderTree(
  folders: FolderSummary[],
  notes: NoteSummary[],
  activeNoteId: string | null,
  onOpenNote: (noteId: string) => void,
  parentId: string | null = null,
): ReactNode {
  const childFolders = sortFolders(folders.filter((folder) => folder.parentId === parentId));
  const childNotes = parentId === null ? [] : orderNotes(notes.filter((note) => note.folderId === parentId));

  return (
    <>
      {childFolders.map((folder) => (
        <div key={folder.id} className="tree-group">
          <div className="tree-folder">{folder.name}</div>
          <div className="tree-children">
            {renderFolderTree(folders, notes, activeNoteId, onOpenNote, folder.id)}
          </div>
        </div>
      ))}
      {childNotes.map((note) => (
        <button
          key={note.id}
          className={`tree-note ${activeNoteId === note.id ? 'active' : ''}`}
          onClick={() => onOpenNote(note.id)}
        >
          <span className="tree-note-title">{note.title}</span>
          <span className="tree-note-excerpt">{note.excerpt || 'Empty note'}</span>
        </button>
      ))}
    </>
  );
}

function App() {
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);
  const [currentNoteCanvas, setCurrentNoteCanvas] = useState<NoteElements>(createEmptyNote());
  const [currentNoteText, setCurrentNoteText] = useState('');
  const [currentNoteTitle, setCurrentNoteTitle] = useState('Untitled Note');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [resolvedLinks, setResolvedLinks] = useState<ResolvedWikiLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<'search' | 'research' | null>(null);
  const [searchMode, setSearchMode] = useState<'current' | 'vault'>('vault');
  const [searchQuery, setSearchQuery] = useState('');
  const [vaultSearchResults, setVaultSearchResults] = useState<VaultSearchResponse>({ notes: [], documents: [] });
  const [wikiMatches, setWikiMatches] = useState<WikiLinkMatch[]>([]);
  const [researchQuery, setResearchQuery] = useState('');
  const [researchResult, setResearchResult] = useState<ResearchResponse | null>(null);
  const [isResearching, setIsResearching] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const lastSavedSnapshotRef = useRef<string>('');
  const lastLoadedNoteIdRef = useRef<string | null>(null);

  const loadNoteById = useCallback(async (noteId: string) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const note = await fetchNote(noteId);
      lastLoadedNoteIdRef.current = noteId;
      setCurrentNoteId(note.id);
      setCurrentNoteTitle(note.title);
      setCurrentFolderId(note.folderId);
      setCurrentNoteCanvas(note.noteCanvas);
      setCurrentNoteText(note.noteText);
      setResolvedLinks(note.resolvedLinks);
      lastSavedSnapshotRef.current = noteSnapshot({
        id: note.id,
        title: note.title,
        folderId: note.folderId,
        noteCanvas: note.noteCanvas,
        noteText: note.noteText,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load note');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    (async () => {
      setIsLoading(true);
      try {
        const bootstrap = await fetchVaultBootstrap();
        if (!active) return;
        setFolders(sortFolders(bootstrap.folders));
        setNotes(orderNotes(bootstrap.notes));
        setDocuments(bootstrap.documents);

        const nextNoteId = bootstrap.notes[0]?.id ?? null;
        if (nextNoteId) {
          await loadNoteById(nextNoteId);
        } else {
          setIsLoading(false);
        }
      } catch (error) {
        if (!active) return;
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load the vault');
        setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [loadNoteById]);

  useEffect(() => {
    if (!currentNoteId || currentNoteId !== lastLoadedNoteIdRef.current) return;

    const payload = {
      id: currentNoteId,
      title: currentNoteTitle.trim() || 'Untitled Note',
      folderId: currentFolderId,
      noteCanvas: currentNoteCanvas,
      noteText: currentNoteText,
    };

    const nextSnapshot = noteSnapshot(payload);
    if (nextSnapshot === lastSavedSnapshotRef.current) return;

    const timeout = window.setTimeout(async () => {
      setIsSaving(true);
      try {
        const saved = await saveNote(payload);
        lastSavedSnapshotRef.current = noteSnapshot({
          id: saved.id,
          title: saved.title,
          folderId: saved.folderId,
          noteCanvas: saved.noteCanvas,
          noteText: saved.noteText,
        });
        setNotes((previous) => mergeNoteSummary(previous, saved));
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to save note');
      } finally {
        setIsSaving(false);
      }
    }, 900);

    return () => window.clearTimeout(timeout);
  }, [currentFolderId, currentNoteCanvas, currentNoteId, currentNoteText, currentNoteTitle]);

  const pendingWikiLink = useMemo(() => {
    const links = extractWikiLinks(currentNoteText);
    const resolved = new Set(resolvedLinks.map((link) => link.rawText));
    return [...links].reverse().find((link) => !resolved.has(link.rawText)) ?? null;
  }, [currentNoteText, resolvedLinks]);

  useEffect(() => {
    let active = true;
    if (!pendingWikiLink || !currentNoteId) {
      setWikiMatches([]);
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        const matches = await searchWikiLinks(pendingWikiLink.label, currentNoteId);
        if (active) setWikiMatches(matches);
      } catch {
        if (active) setWikiMatches([]);
      }
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [currentNoteId, pendingWikiLink]);

  const researchPrompts = useMemo(() => extractResearchPrompts(currentNoteText), [currentNoteText]);

  useEffect(() => {
    if (!researchQuery && researchPrompts[0]) {
      setResearchQuery(researchPrompts[0]);
    }
  }, [researchPrompts, researchQuery]);

  useEffect(() => {
    let active = true;
    if (activePanel !== 'search' || searchMode !== 'vault' || !searchQuery.trim()) {
      if (searchMode === 'vault') {
        setVaultSearchResults({ notes: [], documents: [] });
      }
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        const results = await searchVault(searchQuery, currentNoteId ?? undefined);
        if (active) setVaultSearchResults(results);
      } catch (error) {
        if (active) setErrorMessage(error instanceof Error ? error.message : 'Search failed');
      }
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [activePanel, currentNoteId, searchMode, searchQuery]);

  const currentNoteMatches = useMemo(
    () => buildSearchSnippets(currentNoteText, searchQuery),
    [currentNoteText, searchQuery],
  );

  const handleCreateNote = useCallback(async () => {
    try {
      const created = await createNote({
        title: 'New Note',
        folderId: currentFolderId,
        noteCanvas: createEmptyNote(),
        noteText: '',
      });
      setNotes((previous) => mergeNoteSummary(previous, created));
      await loadNoteById(created.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create note');
    }
  }, [currentFolderId, loadNoteById]);

  const handleCreateFolder = useCallback(async () => {
    try {
      const created = await createFolder('New Folder', null);
      setFolders((previous) => sortFolders([...previous, created]));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create folder');
    }
  }, []);

  const handleOpenNote = useCallback(async (noteId: string) => {
    await loadNoteById(noteId);
  }, [loadNoteById]);

  const handleResolveLink = useCallback(async (targetNoteId: string, rawText: string) => {
    if (!currentNoteId) return;
    try {
      const created = await createResolvedLink(currentNoteId, rawText, targetNoteId);
      const targetNote = notes.find((entry) => entry.id === targetNoteId);
      setResolvedLinks((previous) => [
        ...previous,
        {
          ...created,
          targetTitle: targetNote?.title ?? rawText,
        },
      ]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to resolve wiki link');
    }
  }, [currentNoteId, notes]);

  const handleCreateLinkedNote = useCallback(async () => {
    if (!pendingWikiLink) return;
    try {
      const created = await createNote({
        title: pendingWikiLink.label,
        folderId: currentFolderId,
        noteCanvas: createEmptyNote(),
        noteText: '',
      });
      setNotes((previous) => mergeNoteSummary(previous, created));
      if (currentNoteId) {
        await handleResolveLink(created.id, pendingWikiLink.rawText);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create linked note');
    }
  }, [currentFolderId, currentNoteId, handleResolveLink, pendingWikiLink]);

  const handleUploadClick = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsUploading(true);
    try {
      const uploaded = await uploadReferenceFile(file);
      setDocuments((previous) => [
        {
          id: uploaded.id,
          name: uploaded.name,
          status: uploaded.status,
        },
        ...previous,
      ]);
      setActivePanel('research');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, []);

  const handleRunResearch = useCallback(async () => {
    if (!researchQuery.trim()) return;
    setIsResearching(true);
    try {
      const result = await researchQuestion(researchQuery, currentNoteId ?? undefined);
      setResearchResult(result);
      setActivePanel('research');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Research request failed');
    } finally {
      setIsResearching(false);
    }
  }, [currentNoteId, researchQuery]);

  const activeNoteSummary = useMemo(
    () => notes.find((note) => note.id === currentNoteId) ?? null,
    [notes, currentNoteId],
  );

  const uncategorizedNotes = useMemo(
    () => orderNotes(notes.filter((note) => !note.folderId)),
    [notes],
  );

  const hasVaultContent = folders.length > 0 || notes.length > 0;

  return (
    <div className="app">
      <header className="app-topbar">
        <div className="app-topbar-brand">
          <div className="brand-mark">OI</div>
          <div>
            <h1>ObsidianInk</h1>
            <p>Tablet-first handwritten note vault</p>
          </div>
        </div>

        <div className="app-topbar-actions">
          <input
            className="note-title-input"
            value={currentNoteTitle}
            onChange={(event) => setCurrentNoteTitle(event.target.value)}
            placeholder="Note title"
            disabled={!currentNoteId}
          />
          <button onClick={() => setActivePanel(activePanel === 'search' ? null : 'search')}>Search</button>
          <button onClick={handleUploadClick} disabled={isUploading}>{isUploading ? 'Uploading…' : 'Upload'}</button>
          <button onClick={() => setActivePanel(activePanel === 'research' ? null : 'research')}>Research</button>
          <button onClick={handleCreateFolder}>New Folder</button>
          <button onClick={handleCreateNote}>New Note</button>
        </div>
      </header>

      <div className="app-shell">
        <aside className="vault-sidebar">
          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Vault</span>
              {isSaving && <span className="sidebar-pill">Saving</span>}
            </div>
            {hasVaultContent ? renderFolderTree(folders, notes, currentNoteId, handleOpenNote) : <p className="sidebar-empty">No notes yet.</p>}
            {uncategorizedNotes.length > 0 && (
              <div className="tree-group">
                <div className="tree-folder">Loose Notes</div>
                <div className="tree-children">
                  {uncategorizedNotes.map((note) => (
                    <button
                      key={note.id}
                      className={`tree-note ${activeNoteSummary?.id === note.id ? 'active' : ''}`}
                      onClick={() => handleOpenNote(note.id)}
                    >
                      <span className="tree-note-title">{note.title}</span>
                      <span className="tree-note-excerpt">{note.excerpt || 'Empty note'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span>References</span>
              <span className="sidebar-pill">{documents.length}</span>
            </div>
            {documents.length === 0 ? (
              <p className="sidebar-empty">Upload PDFs, Markdown, or text for grounded research.</p>
            ) : (
              <div className="document-list">
                {documents.map((document) => (
                  <div key={document.id} className="document-item">
                    <span className="document-name">{document.name}</span>
                    <span className={`document-status ${document.status}`}>{document.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <main className="workspace">
          {errorMessage && <div className="error-banner">{errorMessage}</div>}

          <div className="workspace-stage">
            {isLoading || !currentNoteId ? (
              <div className="workspace-empty">
                <h2>{isLoading ? 'Loading vault…' : 'No note selected'}</h2>
                <p>Open an existing note or create a new one to start writing on the canvas.</p>
              </div>
            ) : (
              <CanvasNoteEditor
                key={currentNoteId}
                noteId={currentNoteId}
                initialNote={currentNoteCanvas}
                onNoteChange={setCurrentNoteCanvas}
                onNoteTextChange={setCurrentNoteText}
              />
            )}
          </div>

          <div className="mirror-panel">
            <div className="mirror-panel-header">
              <span>Text Mirror</span>
              <span className="sidebar-pill">{currentNoteText ? currentNoteText.length : 0} chars</span>
            </div>
            <div className="mirror-panel-body">
              {currentNoteText ? currentNoteText : 'Recognized handwritten text will appear here for search, wiki links, and RAG indexing.'}
            </div>
          </div>
        </main>

        <aside className={`side-panel ${activePanel ? 'open' : ''}`}>
          {activePanel === 'search' && (
            <div className="panel-card">
              <div className="panel-header">
                <h2>Search</h2>
                <div className="panel-toggle">
                  <button className={searchMode === 'vault' ? 'active' : ''} onClick={() => setSearchMode('vault')}>Vault</button>
                  <button className={searchMode === 'current' ? 'active' : ''} onClick={() => setSearchMode('current')}>Current Note</button>
                </div>
              </div>
              <input
                className="panel-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={searchMode === 'vault' ? 'Search notes and references' : 'Find in current note'}
              />

              {searchMode === 'current' ? (
                <div className="panel-results">
                  {currentNoteMatches.length === 0 ? (
                    <p className="sidebar-empty">No current-note matches yet.</p>
                  ) : (
                    currentNoteMatches.map((snippet, index) => (
                      <div key={`${snippet}-${index}`} className="result-item">
                        <div className="result-title">Match {index + 1}</div>
                        <div className="result-snippet">{snippet}</div>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="panel-results">
                  {[...vaultSearchResults.notes, ...vaultSearchResults.documents].length === 0 ? (
                    <p className="sidebar-empty">No vault results yet.</p>
                  ) : (
                    <>
                      {vaultSearchResults.notes.map((result: SearchResult) => (
                        <button key={`note-${result.id}`} className="result-item buttonish" onClick={() => handleOpenNote(result.id)}>
                          <div className="result-title">Note: {result.title}</div>
                          <div className="result-snippet">{result.snippet}</div>
                        </button>
                      ))}
                      {vaultSearchResults.documents.map((result: SearchResult) => (
                        <div key={`document-${result.id}`} className="result-item">
                          <div className="result-title">Reference: {result.title}</div>
                          <div className="result-snippet">{result.snippet}</div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {activePanel === 'research' && (
            <div className="panel-card">
              <div className="panel-header">
                <h2>Research</h2>
                <button onClick={handleRunResearch} disabled={isResearching}>
                  {isResearching ? 'Thinking…' : 'Ask'}
                </button>
              </div>
              <textarea
                className="panel-textarea"
                value={researchQuery}
                onChange={(event) => setResearchQuery(event.target.value)}
                placeholder="Write a ??? question here or tap a detected prompt below."
              />

              {researchPrompts.length > 0 && (
                <div className="chip-row">
                  {researchPrompts.map((prompt) => (
                    <button key={prompt} className="chip" onClick={() => setResearchQuery(prompt)}>
                      {prompt}
                    </button>
                  ))}
                </div>
              )}

              {researchResult && (
                <div className="panel-results">
                  <div className="result-item">
                    <div className="result-title">Answer</div>
                    <div className="result-snippet">{researchResult.answer}</div>
                  </div>
                  {researchResult.sources.map((source) => (
                    <div key={`${source.kind}-${source.id}`} className="result-item">
                      <div className="result-title">{source.kind === 'note' ? 'Note' : 'Reference'}: {source.title}</div>
                      <div className="result-snippet">{source.snippet}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {pendingWikiLink && (
        <div className="wiki-link-panel">
          <div className="panel-header">
            <h2>Link “{pendingWikiLink.label}”</h2>
          </div>
          <p className="wiki-link-copy">Choose an existing note or create a new one from this handwritten `[[...]]` link.</p>
          <div className="panel-results">
            {wikiMatches.map((match) => (
              <button
                key={match.noteId}
                className="result-item buttonish"
                onClick={() => handleResolveLink(match.noteId, pendingWikiLink.rawText)}
              >
                <div className="result-title">{match.title}</div>
                <div className="result-snippet">{match.snippet}</div>
              </button>
            ))}
          </div>
          <button className="primary-button" onClick={handleCreateLinkedNote}>
            Create New Note
          </button>
        </div>
      )}

      <input
        ref={uploadInputRef}
        type="file"
        accept=".pdf,.md,.txt,text/plain,text/markdown,application/pdf"
        hidden
        onChange={handleFileSelected}
      />

      <Toaster />
    </div>
  );
}

export default App;
