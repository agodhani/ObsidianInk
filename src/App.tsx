import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import './App.css';
import { createEmptyNote, type NoteElements } from './types';
import { Toaster } from './toast/Toast';
import { CanvasNoteEditor } from './features/editor/CanvasNoteEditor';
import {
  createFolder,
  createNote,
  createResolvedLink,
  deleteNote,
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

type InspectorTab = 'mirror' | 'search' | 'research' | 'links';

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

function buildFolderOptions(
  folders: FolderSummary[],
  parentId: string | null = null,
  depth = 0,
): Array<{ id: string; label: string }> {
  const childFolders = sortFolders(folders.filter((folder) => folder.parentId === parentId));
  return childFolders.flatMap((folder) => [
    {
      id: folder.id,
      label: `${'  '.repeat(depth)}${folder.name}`,
    },
    ...buildFolderOptions(folders, folder.id, depth + 1),
  ]);
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 4.5h9m-7.5 0v8m3-8v8m3-8v8M6 2.75h4L10.5 4.5h-5L6 2.75Zm-1 1.75h6.5l-.4 8.2a1 1 0 0 1-1 .95H5.9a1 1 0 0 1-1-.95L4.5 4.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function PanelIcon({ lines }: { lines: number[] }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {lines.map((width, index) => (
        <path
          key={`${width}-${index}`}
          d={`M4 ${5 + index * 5}h${width}`}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.7"
        />
      ))}
    </svg>
  );
}

function NoteCard({
  note,
  isActive,
  onOpenNote,
  onDeleteNote,
}: {
  note: NoteSummary;
  isActive: boolean;
  onOpenNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
}) {
  return (
    <div className={`tree-note-card ${isActive ? 'active' : ''}`}>
      <button className={`tree-note ${isActive ? 'active' : ''}`} onClick={() => onOpenNote(note.id)}>
        <span className="tree-note-title">{note.title}</span>
        <span className="tree-note-excerpt">{note.excerpt || 'Empty note'}</span>
      </button>
      <button
        className="note-delete-button"
        onClick={() => onDeleteNote(note.id)}
        aria-label={`Delete ${note.title}`}
        title={`Delete ${note.title}`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function renderFolderBranch(
  folder: FolderSummary,
  folders: FolderSummary[],
  notes: NoteSummary[],
  activeNoteId: string | null,
  onOpenNote: (noteId: string) => void,
  onDeleteNote: (noteId: string) => void,
): ReactNode {
  const childFolders = sortFolders(folders.filter((entry) => entry.parentId === folder.id));
  const childNotes = orderNotes(notes.filter((note) => note.folderId === folder.id));

  return (
    <div key={folder.id} className="tree-group">
      <div className="tree-folder">{folder.name}</div>
      <div className="tree-children">
        {childNotes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            isActive={activeNoteId === note.id}
            onOpenNote={onOpenNote}
            onDeleteNote={onDeleteNote}
          />
        ))}
        {childFolders.map((childFolder) => renderFolderBranch(
          childFolder,
          folders,
          notes,
          activeNoteId,
          onOpenNote,
          onDeleteNote,
        ))}
      </div>
    </div>
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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('mirror');
  const [isSidebarVisible, setIsSidebarVisible] = useState(false);
  const [isInspectorVisible, setIsInspectorVisible] = useState(false);
  const [searchMode, setSearchMode] = useState<'current' | 'vault'>('vault');
  const [searchQuery, setSearchQuery] = useState('');
  const [vaultSearchResults, setVaultSearchResults] = useState<VaultSearchResponse>({ notes: [], documents: [] });
  const [wikiMatches, setWikiMatches] = useState<WikiLinkMatch[]>([]);
  const [researchQuery, setResearchQuery] = useState('');
  const [researchResult, setResearchResult] = useState<ResearchResponse | null>(null);
  const [isResearching, setIsResearching] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [toolbarPortalTarget, setToolbarPortalTarget] = useState<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const lastSavedSnapshotRef = useRef<string>('');
  const lastLoadedNoteIdRef = useRef<string | null>(null);

  const resetCurrentNote = useCallback(() => {
    lastLoadedNoteIdRef.current = null;
    lastSavedSnapshotRef.current = '';
    setCurrentNoteId(null);
    setCurrentNoteTitle('Untitled Note');
    setCurrentFolderId(null);
    setCurrentNoteCanvas(createEmptyNote());
    setCurrentNoteText('');
    setResolvedLinks([]);
  }, []);

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
          resetCurrentNote();
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
  }, [loadNoteById, resetCurrentNote]);

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
    if (pendingWikiLink) {
      setIsInspectorVisible(true);
      setInspectorTab('links');
    } else if (inspectorTab === 'links') {
      setInspectorTab('mirror');
    }
  }, [inspectorTab, pendingWikiLink]);

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
    if (!isInspectorVisible || inspectorTab !== 'search' || searchMode !== 'vault' || !searchQuery.trim()) {
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
  }, [currentNoteId, inspectorTab, isInspectorVisible, searchMode, searchQuery]);

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
      setIsSidebarVisible(true);
      await loadNoteById(created.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create note');
    }
  }, [currentFolderId, loadNoteById]);

  const handleCreateFolder = useCallback(async () => {
    try {
      const created = await createFolder('New Folder', null);
      setFolders((previous) => sortFolders([...previous, created]));
      setIsSidebarVisible(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create folder');
    }
  }, []);

  const handleOpenNote = useCallback(async (noteId: string) => {
    await loadNoteById(noteId);
  }, [loadNoteById]);

  const handleDeleteNote = useCallback(async (noteId: string) => {
    const targetNote = notes.find((note) => note.id === noteId);
    if (!targetNote) return;

    const confirmed = window.confirm(`Delete "${targetNote.title}"?`);
    if (!confirmed) return;

    try {
      await deleteNote(noteId);
      const remainingNotes = orderNotes(notes.filter((note) => note.id !== noteId));
      setNotes(remainingNotes);

      if (currentNoteId === noteId) {
        const nextNote = remainingNotes[0];
        if (nextNote) {
          await loadNoteById(nextNote.id);
        } else {
          resetCurrentNote();
        }
      } else {
        setResolvedLinks((previous) => previous.filter((link) => link.targetNoteId !== noteId));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to delete note');
    }
  }, [currentNoteId, loadNoteById, notes, resetCurrentNote]);

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
      setInspectorTab('mirror');
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
      setIsSidebarVisible(true);
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
      setIsInspectorVisible(true);
      setInspectorTab('research');
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
      setIsInspectorVisible(true);
      setInspectorTab('research');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Research request failed');
    } finally {
      setIsResearching(false);
    }
  }, [currentNoteId, researchQuery]);

  const toggleInspectorTab = useCallback((tab: InspectorTab) => {
    if (isInspectorVisible && inspectorTab === tab) {
      setIsInspectorVisible(false);
      return;
    }

    setInspectorTab(tab);
    setIsInspectorVisible(true);
  }, [inspectorTab, isInspectorVisible]);

  const rootFolders = useMemo(
    () => sortFolders(folders.filter((folder) => folder.parentId === null)),
    [folders],
  );
  const uncategorizedNotes = useMemo(
    () => orderNotes(notes.filter((note) => !note.folderId)),
    [notes],
  );
  const folderOptions = useMemo(() => buildFolderOptions(folders), [folders]);
  const activeNoteSummary = useMemo(
    () => notes.find((note) => note.id === currentNoteId) ?? null,
    [notes, currentNoteId],
  );
  const hasVaultContent = folders.length > 0 || notes.length > 0;

  return (
    <div className="app">
      <div className={`app-shell ${!isSidebarVisible ? 'sidebar-hidden' : ''} ${!isInspectorVisible ? 'inspector-hidden' : ''}`}>
        {isSidebarVisible && (
          <aside className="vault-sidebar">
            <div className="sidebar-brand">
              <div className="brand-mark">OI</div>
              <div>
                <h1>ObsidianInk</h1>
                <p>Canvas-first handwritten vault</p>
              </div>
            </div>

            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <span>Vault</span>
                {isSaving && <span className="sidebar-pill">Saving</span>}
              </div>
              <div className="sidebar-action-row">
                <button className="sidebar-action-button" onClick={handleCreateNote}>+ Note</button>
                <button className="sidebar-action-button" onClick={handleCreateFolder}>+ Folder</button>
              </div>

              {hasVaultContent ? (
                <>
                  <div className="tree-group">
                    <div className="tree-folder">Inbox</div>
                    <div className="tree-children">
                      {uncategorizedNotes.length === 0 ? (
                        <p className="sidebar-empty">Unfiled notes show up here.</p>
                      ) : (
                        uncategorizedNotes.map((note) => (
                          <NoteCard
                            key={note.id}
                            note={note}
                            isActive={activeNoteSummary?.id === note.id}
                            onOpenNote={handleOpenNote}
                            onDeleteNote={handleDeleteNote}
                          />
                        ))
                      )}
                    </div>
                  </div>

                  {rootFolders.map((folder) => renderFolderBranch(
                    folder,
                    folders,
                    notes,
                    currentNoteId,
                    handleOpenNote,
                    handleDeleteNote,
                  ))}
                </>
              ) : (
                <p className="sidebar-empty">No notes yet. Create one and start writing.</p>
              )}
            </div>

            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <span>References</span>
                <div className="sidebar-section-actions">
                  <span className="sidebar-pill">{documents.length}</span>
                  <button className="sidebar-mini-button" onClick={handleUploadClick} disabled={isUploading}>
                    {isUploading ? 'Uploading...' : 'Upload'}
                  </button>
                </div>
              </div>
              {documents.length === 0 ? (
                <p className="sidebar-empty">Upload PDFs, Markdown, or text files for keyword search and research.</p>
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
        )}

        <main className="workspace">
          <div className="workspace-controls">
            <div className="workspace-control-group workspace-control-group-left">
              <button
                className="icon-button"
                onClick={() => setIsSidebarVisible((value) => !value)}
                aria-label={isSidebarVisible ? 'Hide vault sidebar' : 'Show vault sidebar'}
                title={isSidebarVisible ? 'Hide vault sidebar' : 'Show vault sidebar'}
              >
                <PanelIcon lines={[12, 12, 12]} />
              </button>

              <input
                className="note-title-input"
                value={currentNoteTitle}
                onChange={(event) => setCurrentNoteTitle(event.target.value)}
                placeholder="Note title"
                disabled={!currentNoteId}
              />

              <select
                className="folder-select"
                value={currentFolderId ?? ''}
                onChange={(event) => setCurrentFolderId(event.target.value || null)}
                disabled={!currentNoteId}
              >
                <option value="">Inbox</option>
                {folderOptions.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="workspace-toolbar-slot" ref={setToolbarPortalTarget} />

            <div className="workspace-control-group workspace-control-group-right">
              <button className={`ghost-button ${isInspectorVisible && inspectorTab === 'search' ? 'active' : ''}`} onClick={() => toggleInspectorTab('search')}>
                Search
              </button>
              <button className={`ghost-button ${isInspectorVisible && inspectorTab === 'research' ? 'active' : ''}`} onClick={() => toggleInspectorTab('research')}>
                Research
              </button>
              <button
                className={`ghost-button ${isInspectorVisible && inspectorTab === 'links' ? 'active' : ''}`}
                onClick={() => toggleInspectorTab('links')}
                disabled={!pendingWikiLink}
              >
                Link
              </button>
              <button className={`ghost-button ${isInspectorVisible && inspectorTab === 'mirror' ? 'active' : ''}`} onClick={() => toggleInspectorTab('mirror')}>
                Text
              </button>
              <button className="ghost-button" onClick={handleUploadClick} disabled={isUploading}>
                {isUploading ? 'Uploading...' : 'Upload'}
              </button>
              <button
                className="icon-button"
                onClick={() => setIsInspectorVisible((value) => !value)}
                aria-label={isInspectorVisible ? 'Hide inspector panel' : 'Show inspector panel'}
                title={isInspectorVisible ? 'Hide inspector panel' : 'Show inspector panel'}
              >
                <PanelIcon lines={[12, 8, 12]} />
              </button>
            </div>
          </div>

          {errorMessage && <div className="error-banner">{errorMessage}</div>}

          <div className="workspace-stage">
            {isLoading || !currentNoteId ? (
              <div className="workspace-empty">
                <h2>{isLoading ? 'Loading vault...' : 'No note selected'}</h2>
                <p>Open a note from the vault or create a new one to start drawing.</p>
              </div>
            ) : (
              <CanvasNoteEditor
                key={currentNoteId}
                noteId={currentNoteId}
                initialNote={currentNoteCanvas}
                onNoteChange={setCurrentNoteCanvas}
                onNoteTextChange={setCurrentNoteText}
                topBarPortalTarget={toolbarPortalTarget}
              />
            )}
          </div>
        </main>

        {isInspectorVisible && (
          <aside className="inspector-panel">
            <div className="inspector-body">
              {inspectorTab === 'mirror' && (
                <div className="panel-card panel-card-fill">
                  <div className="mirror-panel-body">
                    {currentNoteText || 'Recognized handwritten text will appear here.'}
                  </div>
                </div>
              )}

              {inspectorTab === 'search' && (
                <div className="panel-card panel-card-fill">
                  <div className="panel-toolbar panel-toolbar-right">
                    <div className="panel-toggle">
                      <button className={searchMode === 'vault' ? 'active' : ''} onClick={() => setSearchMode('vault')}>Vault</button>
                      <button className={searchMode === 'current' ? 'active' : ''} onClick={() => setSearchMode('current')}>Current</button>
                    </div>
                  </div>
                  <input
                    className="panel-input"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={searchMode === 'vault' ? 'Keyword search notes and references' : 'Find in this note'}
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

              {inspectorTab === 'research' && (
                <div className="panel-card panel-card-fill">
                  <div className="panel-toolbar panel-toolbar-right">
                    <button onClick={handleRunResearch} disabled={isResearching}>
                      {isResearching ? 'Thinking...' : 'Ask'}
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

              {inspectorTab === 'links' && (
                <div className="panel-card panel-card-fill">
                  {pendingWikiLink ? (
                    <>
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
                    </>
                  ) : (
                    <p className="sidebar-empty">No pending handwritten links right now.</p>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

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
