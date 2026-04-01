import { useState, useCallback, useEffect, useRef, useMemo, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { InkCanvas } from '../../canvas/InkCanvas';
import type { Tool } from '../../canvas/InkCanvas';
import type { Viewport } from '../../canvas/ViewportManager';
import type { NoteElements, Stroke, Element } from '../../types';
import {
  supportsBackgroundColor,
  getElementStrokeColor,
  getElementBackgroundColor,
  setElementStrokeColor,
  setElementBackgroundColor,
} from '../../types';
import { generateId, IDENTITY_MATRIX } from '../../types/primitives';
import { createStrokeElement } from '../../elements/stroke/types';
import type { ShapeElement } from '../../elements/shape/types';
import { createSketchableImageElement } from '../../elements/sketchableimage/types';
import { useUndoRedo, useUndoRedoKeyboard } from '../../state/useUndoRedo';
import { getMostRecentCluster } from '../../recognition/StrokeClustering';
import { tryCreateElement, tryInteraction, tryCreateElementWithDisambiguation, getPlugin } from '../../elements';
import { createDisambiguationIntent } from '../../disambiguation';
import type { DisambiguationIntent, DisambiguationAction, DisambiguationCandidate } from '../../disambiguation';
import { beautifyShape, extractFeatures } from '../../geometry/shapeRecognition';
import { colorToHex } from '../../types/brush';
import { hexToArgb } from '../../input/StrokeBuilder';
import type { ShapeType } from '../../geometry/shapeRecognition';
import { debugLog, logElementCreated, logElementMutated, logElementDeleted } from '../../debug/DebugLogger';
import { isMultiStrokeScribbleEraseGesture, getMultiStrokePoints } from '../../eraser/scribbleDetection';
import { performScribbleErase } from '../../eraser/ScribbleEraser';
import { findElementsInLasso, getStrokePoints, createSelectionIntent } from '../../lasso';
import type { SelectionIntent } from '../../lasso';
import { useSketchableImageGeneration } from '../../hooks/useSketchableImageGeneration';
import type { RefinementMode } from '../../hooks/useSketchableImageGeneration';
import { useNonogramGeneration } from '../../hooks/useNonogramGeneration';
import { useJigsawGeneration } from '../../hooks/useJigsawGeneration';
import { useColorConnectGeneration } from '../../hooks/useColorConnectGeneration';
import { STYLE_PRESETS, DEFAULT_STYLE_PRESET } from '../../services/stylePresets';
import type { StylePresetKey } from '../../services/stylePresets';
import { detectRectangleX, lastRectXRejection, type RectangleXResult } from '../../geometry/rectangleXDetection';
import { createPaletteIntent } from '../../palette';
import type { PaletteIntent, PaletteAction } from '../../palette';
import { extractNoteTextMirror } from '../../vault/noteText';
import './CanvasNoteEditor.css';

const STROKE_ANIMATION_DURATION = 500;
const STROKE_DEBOUNCE_MS = 650;

function removeConsumedStrokeElements(elements: Element[], consumedStrokes: Set<Stroke>): Element[] {
  return elements.filter((element) => {
    if (element.type !== 'stroke') return true;
    return !element.strokes.every((stroke) => consumedStrokes.has(stroke));
  });
}

function loadSavedViewport(noteId: string): Viewport | undefined {
  try {
    const saved = localStorage.getItem(`obsidianink-viewport-${noteId}`);
    if (!saved) return undefined;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed.panX === 'number' && typeof parsed.panY === 'number' && typeof parsed.zoom === 'number') {
      return parsed as Viewport;
    }
  } catch {
    // Ignore storage failures.
  }
  return undefined;
}

export interface CanvasNoteEditorProps {
  noteId: string;
  initialNote: NoteElements;
  onNoteChange: (note: NoteElements) => void;
  onNoteTextChange: (text: string) => void;
  topBarPortalTarget?: HTMLDivElement | null;
}

export function CanvasNoteEditor({
  noteId,
  initialNote,
  onNoteChange,
  onNoteTextChange,
  topBarPortalTarget = null,
}: CanvasNoteEditorProps) {
  const {
    current: currentNote,
    set: setCurrentNote,
    undo: undoBase,
    redo: redoBase,
    canUndo,
    canRedo,
    reset: resetNote,
  } = useUndoRedo<NoteElements>(initialNote);

  useEffect(() => {
    resetNote(initialNote);
  }, [initialNote, resetNote]);

  const [stylePreset, setStylePreset] = useState<StylePresetKey>(DEFAULT_STYLE_PRESET);
  const [refinementMode, setRefinementMode] = useState<RefinementMode>('twoImage');

  useSketchableImageGeneration(currentNote, setCurrentNote, stylePreset, refinementMode);
  useNonogramGeneration(currentNote, setCurrentNote);
  useJigsawGeneration(currentNote, setCurrentNote);
  useColorConnectGeneration(currentNote, setCurrentNote);

  const currentNoteRef = useRef(currentNote);

  useEffect(() => {
    currentNoteRef.current = currentNote;
  }, [currentNote]);

  useEffect(() => {
    onNoteChange(currentNote);
    onNoteTextChange(extractNoteTextMirror(currentNote));
  }, [currentNote, onNoteChange, onNoteTextChange]);

  const pendingStrokesRef = useRef<Stroke[]>([]);
  const strokeBufferRef = useRef<Stroke[]>([]);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [animatingElements, setAnimatingElements] = useState<Map<string, number>>(new Map());
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(new Set());
  const [selectionIntent, setSelectionIntent] = useState<SelectionIntent | null>(null);
  const [disambiguationIntent, setDisambiguationIntent] = useState<DisambiguationIntent | null>(null);
  const [paletteIntent, setPaletteIntent] = useState<PaletteIntent | null>(null);
  const [strokesToClearFromOverlay, setStrokesToClearFromOverlay] = useState<{ strokes: Stroke[]; requestId: number } | null>(null);

  const startElementAnimation = useCallback((elementIds: string[]) => {
    const now = performance.now();
    setAnimatingElements((previous) => {
      const next = new Map(previous);
      for (const id of elementIds) {
        next.set(id, now);
      }
      return next;
    });
  }, []);

  const handleAnimationComplete = useCallback((elementId: string) => {
    setAnimatingElements((previous) => {
      const next = new Map(previous);
      next.delete(elementId);
      return next;
    });
  }, []);

  const handleSelectionChange = useCallback((newSelection: Set<string>) => {
    setSelectedElementIds(newSelection);
  }, []);

  const handleElementsMove = useCallback((elementIds: Set<string>, dx: number, dy: number) => {
    if (elementIds.size === 0 || (dx === 0 && dy === 0)) return;

    const note = currentNoteRef.current;
    setCurrentNote({
      ...note,
      elements: note.elements.map((element) => {
        if (!elementIds.has(element.id)) return element;

        if (element.type === 'stroke') {
          return {
            ...element,
            strokes: element.strokes.map((stroke) => ({
              ...stroke,
              inputs: {
                ...stroke.inputs,
                inputs: stroke.inputs.inputs.map((input) => ({
                  ...input,
                  x: input.x + dx,
                  y: input.y + dy,
                })),
              },
            })),
          };
        }

        const values = [...element.transform.values] as [number, number, number, number, number, number, number, number, number];
        values[6] += dx;
        values[7] += dy;
        return {
          ...element,
          transform: { values },
        };
      }),
    });
  }, [setCurrentNote]);

  const clearTransientState = useCallback(() => {
    pendingStrokesRef.current = [];
    strokeBufferRef.current = [];
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    setSelectedElementIds(new Set());
    setSelectionIntent(null);
    setDisambiguationIntent(null);
    setPaletteIntent(null);
  }, []);

  const undo = useCallback(() => {
    clearTransientState();
    undoBase();
  }, [clearTransientState, undoBase]);

  const redo = useCallback(() => {
    clearTransientState();
    redoBase();
  }, [clearTransientState, redoBase]);

  const [showDebug, setShowDebug] = useState(false);
  const [currentTool, setCurrentTool] = useState<Tool>('pen');
  const [brushColor, setBrushColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(3);

  const selectedElements = useMemo(
    () => currentNote.elements.filter((element) => selectedElementIds.has(element.id)),
    [currentNote.elements, selectedElementIds],
  );

  const hasSelectedSketchImage = selectedElements.some((element) => element.type === 'sketchableImage');

  const selectionStrokeColor = useMemo((): number | 'mixed' | undefined => {
    if (selectedElements.length === 0) return undefined;
    const colors = selectedElements.map(getElementStrokeColor);
    const firstDefined = colors.find((color) => color !== undefined);
    if (firstDefined === undefined) return undefined;
    const allSame = colors.every((color) => color === firstDefined);
    return allSame ? firstDefined : 'mixed';
  }, [selectedElements]);

  const selectionBackgroundColor = useMemo((): number | 'mixed' | undefined => {
    if (selectedElements.length === 0) return undefined;
    const supportsBackground = selectedElements.filter(supportsBackgroundColor);
    if (supportsBackground.length === 0) return undefined;
    const colors = supportsBackground.map(getElementBackgroundColor);
    const firstDefined = colors.find((color) => color !== undefined);
    const allSame = colors.every((color) => color === firstDefined);
    return allSame ? firstDefined : 'mixed';
  }, [selectedElements]);

  const backgroundColorEnabled = useMemo(
    () => selectedElements.length > 0 && selectedElements.every(supportsBackgroundColor),
    [selectedElements],
  );

  const drawingControlsEnabled = currentTool === 'pen' || selectedElements.length > 0;

  useUndoRedoKeyboard(undo, redo);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (event.key.toLowerCase()) {
        case 'p':
          setCurrentTool('pen');
          break;
        case 'e':
          setCurrentTool('eraser');
          break;
        case 'h':
          setCurrentTool('pan');
          break;
        case 's':
          setCurrentTool('select');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleStrokeColorChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const newHexColor = event.target.value;
    setBrushColor(newHexColor);

    if (selectedElementIds.size > 0) {
      const argbColor = hexToArgb(newHexColor);
      setCurrentNote({
        ...currentNoteRef.current,
        elements: currentNoteRef.current.elements.map((element) => {
          if (!selectedElementIds.has(element.id)) return element;
          return setElementStrokeColor(element, argbColor);
        }),
      });
    }
  }, [selectedElementIds, setCurrentNote]);

  const handleBackgroundColorChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const argbColor = hexToArgb(event.target.value);
    setCurrentNote({
      ...currentNoteRef.current,
      elements: currentNoteRef.current.elements.map((element) => {
        if (!selectedElementIds.has(element.id)) return element;
        return setElementBackgroundColor(element, argbColor);
      }),
    });
  }, [selectedElementIds, setCurrentNote]);

  const [savedViewport] = useState<Viewport | undefined>(() => loadSavedViewport(noteId));
  const viewportRef = useRef<Viewport | undefined>(savedViewport);
  const viewportSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleViewportChange = useCallback((viewport: Viewport) => {
    viewportRef.current = viewport;
    if (viewportSaveTimeoutRef.current) clearTimeout(viewportSaveTimeoutRef.current);
    viewportSaveTimeoutRef.current = setTimeout(() => {
      try {
        localStorage.setItem(`obsidianink-viewport-${noteId}`, JSON.stringify(viewport));
      } catch {
        // Ignore storage failures.
      }
    }, 700);
  }, [noteId]);

  useEffect(() => () => {
    if (viewportSaveTimeoutRef.current) clearTimeout(viewportSaveTimeoutRef.current);
  }, []);

  const handleAddSketchableImage = useCallback(() => {
    const note = currentNoteRef.current;
    const centerX = Math.max(0, window.innerWidth / 2 - 420);
    const centerY = Math.max(0, window.innerHeight / 2 - 320);
    const element = createSketchableImageElement(centerX, centerY);
    setCurrentNote({
      ...note,
      elements: [...note.elements, element],
    });
    setSelectedElementIds(new Set([element.id]));
  }, [setCurrentNote]);

  const processStrokes = useCallback(async (strokes: Stroke[]) => {
    if (strokes.length === 0) return;

    const interactionResult = await tryInteraction(currentNoteRef.current.elements, strokes);
    if (interactionResult) {
      const { elementId, result } = interactionResult;
      const element = currentNoteRef.current.elements.find((entry) => entry.id === elementId);
      logElementMutated(element?.type ?? 'unknown', elementId, 'Interaction consumed strokes');
      if (result.strokesConsumed.length > 0) {
        setStrokesToClearFromOverlay({ strokes: result.strokesConsumed, requestId: Date.now() });
      }
      setCurrentNote((prev) => ({
        ...prev,
        elements: prev.elements.map((entry) => (
          entry.id === elementId ? result.element : entry
        )),
      }));
      setSelectedElementIds(new Set([elementId]));
      return;
    }

    pendingStrokesRef.current = [...pendingStrokesRef.current, ...strokes];

    let rectXRejection = 'not enough strokes';
    if (pendingStrokesRef.current.length >= 3) {
      let rectXResult: RectangleXResult | null = null;
      for (let windowSize = 3; windowSize <= Math.min(6, pendingStrokesRef.current.length); windowSize += 1) {
        rectXResult = detectRectangleX(pendingStrokesRef.current.slice(-windowSize));
        if (rectXResult) break;
      }
      rectXRejection = rectXResult ? '' : lastRectXRejection;
      if (rectXResult) {
        const intent = createPaletteIntent(rectXResult);
        if (intent.entries.length > 0) {
          setPaletteIntent(intent);
          const strokeElement = createStrokeElement(rectXResult.allStrokes);
          setCurrentNote((prev) => ({
            ...prev,
            elements: [...prev.elements, strokeElement],
          }));
          const consumedSet = new Set(rectXResult.allStrokes);
          pendingStrokesRef.current = pendingStrokesRef.current.filter((stroke) => !consumedSet.has(stroke));
          return;
        }
      }
    }

    if (pendingStrokesRef.current.length >= 1) {
      try {
        const disambigResult = await tryCreateElementWithDisambiguation(
          pendingStrokesRef.current.slice(-3),
          {
            existingElements: currentNoteRef.current.elements,
            canvasWidth: 1000,
            canvasHeight: 1000,
          },
        );

        if (disambigResult.result && disambigResult.result.elements.length > 0) {
          const result = disambigResult.result;

          if (disambigResult.needsDisambiguation && disambigResult.candidates) {
            setDisambiguationIntent(createDisambiguationIntent(disambigResult.candidates, result.consumedStrokes));
            const strokeElement = createStrokeElement(result.consumedStrokes);
            setCurrentNote((prev) => ({
              ...prev,
              elements: [...prev.elements, strokeElement],
            }));
            const consumedSet = new Set(result.consumedStrokes);
            pendingStrokesRef.current = pendingStrokesRef.current.filter((stroke) => !consumedSet.has(stroke));
            return;
          }

          const consumedSet = new Set(result.consumedStrokes);
          pendingStrokesRef.current = pendingStrokesRef.current.filter((stroke) => !consumedSet.has(stroke));
          for (const element of result.elements) {
            logElementCreated(element.type, element.id, `confidence: ${result.confidence.toFixed(2)}`);
          }
          startElementAnimation(result.elements.map((element) => element.id));
          const consumedIds = result.consumedElementIds ? new Set(result.consumedElementIds) : null;
          setCurrentNote((prev) => {
            const surviving = removeConsumedStrokeElements(prev.elements, consumedSet)
              .filter((element) => !consumedIds || !consumedIds.has(element.id));
            return { ...prev, elements: [...surviving, ...result.elements] };
          });
          return;
        }
      } catch (error) {
        debugLog.error('Element creation error', error);
      }
    }

    if (pendingStrokesRef.current.length >= 4) {
      const cluster = getMostRecentCluster(pendingStrokesRef.current, {
        spatialThreshold: 150,
        temporalThreshold: 10000,
        minStrokes: 4,
      });

      if (cluster && cluster.strokes.length >= 4) {
        try {
          const result = await tryCreateElement(cluster.strokes, {
            existingElements: currentNoteRef.current.elements,
            canvasWidth: 1000,
            canvasHeight: 1000,
          });

          if (result && result.elements.length > 0) {
            const consumedSet = new Set(result.consumedStrokes);
            pendingStrokesRef.current = pendingStrokesRef.current.filter((stroke) => !consumedSet.has(stroke));
            for (const element of result.elements) {
              logElementCreated(element.type, element.id, `confidence: ${result.confidence.toFixed(2)}`);
            }
            startElementAnimation(result.elements.map((element) => element.id));
            setCurrentNote((prev) => ({
              ...prev,
              elements: [...removeConsumedStrokeElements(prev.elements, consumedSet), ...result.elements],
            }));
            return;
          }
        } catch (error) {
          debugLog.error('Element creation error', error);
        }
      }
    }

    if (pendingStrokesRef.current.length >= 2) {
      const cluster = getMostRecentCluster(pendingStrokesRef.current, {
        spatialThreshold: 150,
        temporalThreshold: 5000,
        minStrokes: 2,
      });

      if (cluster && cluster.strokes.length >= 2) {
        try {
          const result = await tryCreateElement(cluster.strokes, {
            existingElements: currentNoteRef.current.elements,
            canvasWidth: 1000,
            canvasHeight: 1000,
          });

          if (result && result.elements.length > 0) {
            const consumedSet = new Set(result.consumedStrokes);
            pendingStrokesRef.current = pendingStrokesRef.current.filter((stroke) => !consumedSet.has(stroke));
            for (const element of result.elements) {
              logElementCreated(element.type, element.id, `confidence: ${result.confidence.toFixed(2)}`);
            }
            startElementAnimation(result.elements.map((element) => element.id));
            setCurrentNote((prev) => ({
              ...prev,
              elements: [...removeConsumedStrokeElements(prev.elements, consumedSet), ...result.elements],
            }));
            return;
          }
        } catch (error) {
          debugLog.error('InkText creation error', error);
        }
      }
    }

    if (rectXRejection) {
      debugLog.warn('RectX detection failed', { reason: rectXRejection, pendingStrokes: pendingStrokesRef.current.length });
    }
    const strokeElement = createStrokeElement(strokes);
    setCurrentNote((prev) => ({
      ...prev,
      elements: [...prev.elements, strokeElement],
    }));
  }, [setCurrentNote, startElementAnimation]);

  const handleDrawingStart = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
  }, []);

  const handleStrokeComplete = useCallback(async (stroke: Stroke) => {
    const immediateResult = await tryInteraction(currentNoteRef.current.elements, [stroke], undefined, true);
    if (immediateResult) {
      const { elementId, result } = immediateResult;
      if (result.strokesConsumed.length > 0) {
        setStrokesToClearFromOverlay({ strokes: result.strokesConsumed, requestId: Date.now() });
      }
      setCurrentNote((prev) => ({
        ...prev,
        elements: prev.elements.map((entry) => (
          entry.id === elementId ? result.element : entry
        )),
      }));
      setSelectedElementIds(new Set([elementId]));
      return;
    }

    strokeBufferRef.current = [...strokeBufferRef.current, stroke];
    if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);

    debounceTimeoutRef.current = setTimeout(() => {
      const strokesToProcess = strokeBufferRef.current;
      strokeBufferRef.current = [];
      debounceTimeoutRef.current = null;

      const latestElements = currentNoteRef.current.elements;
      if (isMultiStrokeScribbleEraseGesture(strokesToProcess, latestElements)) {
        const result = performScribbleErase(currentNoteRef.current.elements, getMultiStrokePoints(strokesToProcess));
        if (result.success) {
          for (const elementId of result.removedElementIds) {
            const element = currentNoteRef.current.elements.find((entry) => entry.id === elementId);
            if (element) logElementDeleted(element.type, element.id);
          }
          for (const element of result.modifiedElements) {
            logElementMutated(element.type, element.id, 'Partial token erasure');
          }
          setStrokesToClearFromOverlay({ strokes: strokesToProcess, requestId: Date.now() });
          setCurrentNote((prev) => ({
            ...prev,
            elements: result.remainingElements,
          }));
        }
        return;
      }

      if (strokesToProcess.length === 1 && latestElements.length > 0) {
        const lassoStroke = strokesToProcess[0];
        const lassoResult = findElementsInLasso(getStrokePoints(lassoStroke), latestElements, lassoStroke);
        if (lassoResult.isValid && lassoResult.selectedElements.length > 0) {
          const lassoElement = createStrokeElement(strokesToProcess);
          setCurrentNote((prev) => ({
            ...prev,
            elements: [...prev.elements, lassoElement],
          }));
          setSelectionIntent(createSelectionIntent(
            strokesToProcess,
            lassoElement.id,
            lassoResult.selectionPolygon,
            lassoResult.selectedElements,
            lassoResult.selectionBounds,
          ));
          return;
        }
      }

      processStrokes(strokesToProcess);
    }, STROKE_DEBOUNCE_MS);
  }, [processStrokes, setCurrentNote]);

  const handleElementsChange = useCallback((elements: Element[]) => {
    const remainingIds = new Set(elements.map((element) => element.id));
    for (const element of currentNoteRef.current.elements) {
      if (!remainingIds.has(element.id)) {
        logElementDeleted(element.type, element.id);
      }
    }
    setCurrentNote({
      ...currentNoteRef.current,
      elements,
    });
  }, [setCurrentNote]);

  const handleDisambiguationAction = useCallback(async (
    action: DisambiguationAction,
    selectedCandidate?: DisambiguationCandidate,
  ) => {
    if (!disambiguationIntent) return;

    if (action === 'select' && selectedCandidate) {
      const strokes = disambiguationIntent.pendingStrokes;
      const strokeSet = new Set(strokes);
      const remainingElements = currentNoteRef.current.elements.filter((element) => {
        if (element.type !== 'stroke') return true;
        return !element.strokes.some((stroke) => strokeSet.has(stroke));
      });

      if (selectedCandidate.elementType === 'shape' && selectedCandidate.shapeType) {
        const features = extractFeatures(strokes);
        if (features) {
          const brush = strokes[0]?.brush ?? { color: 0xff000000, size: 2 };
          const shapeElement: ShapeElement = {
            type: 'shape',
            id: generateId(),
            transform: IDENTITY_MATRIX,
            paths: [
              beautifyShape(
                selectedCandidate.shapeType as ShapeType,
                features,
                brush.color,
                brush.size,
              ),
            ],
            sourceStrokes: strokes,
          };
          logElementCreated('shape', shapeElement.id, `selected: ${selectedCandidate.label}`);
          startElementAnimation([shapeElement.id]);
          setCurrentNote({
            ...currentNoteRef.current,
            elements: [...remainingElements, shapeElement],
          });
        }
      } else {
        const plugin = getPlugin(selectedCandidate.elementType);
        if (plugin?.createFromInk) {
          try {
            const result = await plugin.createFromInk(strokes, {
              existingElements: remainingElements,
              canvasWidth: 1000,
              canvasHeight: 1000,
            });
            if (result && result.elements.length > 0) {
              for (const element of result.elements) {
                logElementCreated(element.type, element.id, `selected: ${selectedCandidate.label}`);
              }
              startElementAnimation(result.elements.map((element) => element.id));
              setCurrentNote({
                ...currentNoteRef.current,
                elements: [...remainingElements, ...result.elements],
              });
            } else {
              setCurrentNote({
                ...currentNoteRef.current,
                elements: remainingElements,
              });
            }
          } catch {
            setCurrentNote({
              ...currentNoteRef.current,
              elements: remainingElements,
            });
          }
        }
      }
    }

    setDisambiguationIntent(null);
  }, [disambiguationIntent, setCurrentNote, startElementAnimation]);

  const handlePaletteAction = useCallback(async (action: PaletteAction, entryId?: string) => {
    if (!paletteIntent) return;

    if (action === 'select' && entryId) {
      const entry = paletteIntent.entries.find((candidate) => candidate.id === entryId);
      if (!entry) {
        setPaletteIntent(null);
        return;
      }

      let consumed = false;
      const consumedElementIds: string[] = [];
      const consumeStrokes = (...elementIds: string[]) => {
        consumed = true;
        consumedElementIds.push(...elementIds);
      };

      const newElement = await entry.onSelect(
        paletteIntent.rectangleBounds,
        consumeStrokes,
        { elements: currentNoteRef.current.elements, gestureStrokes: paletteIntent.pendingStrokes },
      );

      const latestNote = currentNoteRef.current;
      const gestureStrokeSet = new Set(paletteIntent.pendingStrokes);
      const consumedIdSet = new Set(consumedElementIds);
      const remainingElements = latestNote.elements.filter((element) => {
        if (consumedIdSet.has(element.id)) return false;
        if (element.type !== 'stroke') return true;
        return !element.strokes.some((stroke) => gestureStrokeSet.has(stroke));
      });

      if (newElement && consumed) {
        logElementCreated(newElement.type, newElement.id, `palette: ${entry.label}`);
        startElementAnimation([newElement.id]);
        setCurrentNote({
          ...latestNote,
          elements: [...remainingElements, newElement],
        });
      } else if (consumed) {
        setCurrentNote({
          ...latestNote,
          elements: remainingElements,
        });
      }
    }

    setPaletteIntent(null);
  }, [paletteIntent, setCurrentNote, startElementAnimation]);

  const primaryToolbar = (
    <div className={`toolbar editor-toolbar ${topBarPortalTarget ? 'toolbar-inline editor-toolbar-inline' : ''}`}>
      <div className="toolbar-section tool-buttons">
        <button className={currentTool === 'pen' ? 'active' : ''} onClick={() => setCurrentTool('pen')} title="Pen tool">
          Pen
        </button>
        <button className={currentTool === 'select' ? 'active' : ''} onClick={() => setCurrentTool('select')} title="Select tool">
          Select
        </button>
        <button className={currentTool === 'eraser' ? 'active' : ''} onClick={() => setCurrentTool('eraser')} title="Eraser tool">
          Erase
        </button>
        <button className={currentTool === 'pan' ? 'active' : ''} onClick={() => setCurrentTool('pan')} title="Pan tool">
          Pan
        </button>
        <button onClick={handleAddSketchableImage} title="Add AI sketch canvas">
          AI Canvas
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section tool-buttons">
        <button onClick={undo} disabled={!canUndo} style={{ opacity: canUndo ? 1 : 0.45 }}>
          Undo
        </button>
        <button onClick={redo} disabled={!canRedo} style={{ opacity: canRedo ? 1 : 0.45 }}>
          Redo
        </button>
        <button className={showDebug ? 'active' : ''} onClick={() => setShowDebug((value) => !value)}>
          Debug
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section color-picker" style={{ opacity: drawingControlsEnabled ? 1 : 0.4 }}>
        <div className="color-picker-item" title="Stroke color">
          <input
            type="color"
            value={selectionStrokeColor !== undefined && selectionStrokeColor !== 'mixed'
              ? colorToHex(selectionStrokeColor)
              : brushColor}
            onChange={handleStrokeColorChange}
            disabled={!drawingControlsEnabled}
            className={selectionStrokeColor === 'mixed' ? 'mixed-color' : ''}
          />
          {selectionStrokeColor === 'mixed' && <span className="mixed-indicator">?</span>}
        </div>
        <div className="color-picker-item" title="Background color">
          <input
            type="color"
            value={selectionBackgroundColor !== undefined && selectionBackgroundColor !== 'mixed'
              ? colorToHex(selectionBackgroundColor)
              : '#ffffff'}
            onChange={handleBackgroundColorChange}
            disabled={!drawingControlsEnabled || !backgroundColorEnabled}
            className={selectionBackgroundColor === 'mixed' ? 'mixed-color' : ''}
          />
          {selectionBackgroundColor === 'mixed' && <span className="mixed-indicator">?</span>}
        </div>
      </div>

      <div className="toolbar-section brush-size" style={{ opacity: drawingControlsEnabled ? 1 : 0.4 }}>
        <input
          type="range"
          min="1"
          max="20"
          value={brushSize}
          onChange={(event) => setBrushSize(Number(event.target.value))}
          title="Brush size"
          disabled={!drawingControlsEnabled}
        />
        <span>{brushSize}</span>
      </div>
    </div>
  );

  return (
    <div className="canvas-editor">
      <div className="canvas-container">
        <InkCanvas
          noteElements={currentNote}
          showDebugOverlay={showDebug}
          currentTool={currentTool}
          brushColor={brushColor}
          brushSize={brushSize}
          onStrokeComplete={handleStrokeComplete}
          onDrawingStart={handleDrawingStart}
          onElementsChange={handleElementsChange}
          initialViewport={savedViewport}
          onViewportChange={handleViewportChange}
          animatingElements={animatingElements}
          animationDuration={STROKE_ANIMATION_DURATION}
          onAnimationComplete={handleAnimationComplete}
          selectedElementIds={selectedElementIds}
          onSelectionChange={handleSelectionChange}
          onElementsMove={handleElementsMove}
          selectionIntent={selectionIntent}
          onSelectionIntentChange={setSelectionIntent}
          disambiguationIntent={disambiguationIntent}
          onDisambiguationAction={handleDisambiguationAction}
          paletteIntent={paletteIntent}
          onPaletteAction={handlePaletteAction}
          strokesToClearFromOverlay={strokesToClearFromOverlay}
        />
      </div>

      {topBarPortalTarget ? createPortal(primaryToolbar, topBarPortalTarget) : primaryToolbar}

      {hasSelectedSketchImage && (
        <div className="toolbar toolbar-secondary editor-secondary-toolbar">
          <label>
            Style
            <select value={stylePreset} onChange={(event) => setStylePreset(event.target.value as StylePresetKey)}>
              {Object.keys(STYLE_PRESETS).map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </label>
          <label>
            Refine
            <select value={refinementMode} onChange={(event) => setRefinementMode(event.target.value as RefinementMode)}>
              <option value="twoImage">Two-Image</option>
              <option value="composite">Composite</option>
            </select>
          </label>
        </div>
      )}

      <footer className="status-bar editor-status-bar">
        <span>Elements: {currentNote.elements.length}</span>
        <span>|</span>
        <span>Touch tools: pen, select, erase, pan</span>
      </footer>
    </div>
  );
}
