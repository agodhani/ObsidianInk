import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { renderStroke } from '../../canvas/StrokeRenderer';
import { StrokeBuilder, createDefaultBrush, hexToArgb } from '../../input/StrokeBuilder';
import { getRecognitionService } from '../../recognition';
import type { Stroke } from '../../types';

const IDLE_RECOGNITION_DELAY_MS = 700;
const FEEDBACK_DURATION_MS = 1800;

export interface ResearchHandwritingPadHandle {
  flushPendingInk: () => Promise<void>;
}

interface ResearchHandwritingPadProps {
  preContext?: string;
  onAppendText: (text: string) => void;
}

function buildSuccessMessage(text: string): string {
  const condensed = text.replace(/\s+/g, ' ').trim();
  if (condensed.length <= 34) {
    return `Added "${condensed}"`;
  }
  return `Added "${condensed.slice(0, 31)}..."`;
}

export const ResearchHandwritingPad = forwardRef<ResearchHandwritingPadHandle, ResearchHandwritingPadProps>(
  function ResearchHandwritingPad({ preContext, onAppendText }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const strokeBuilderRef = useRef<StrokeBuilder | null>(null);
    const pointerIdRef = useRef<number | null>(null);
    const recognitionTimerRef = useRef<number | null>(null);
    const feedbackTimerRef = useRef<number | null>(null);
    const recognitionGenerationRef = useRef(0);
    const recognitionJobsRef = useRef<Set<Promise<void>>>(new Set());
    const strokesRef = useRef<Stroke[]>([]);
    const onAppendTextRef = useRef(onAppendText);
    const preContextRef = useRef(preContext);

    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const [previewStroke, setPreviewStroke] = useState<Stroke | null>(null);
    const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0, pixelRatio: 1 });
    const [pendingRecognitionCount, setPendingRecognitionCount] = useState(0);
    const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    if (!strokeBuilderRef.current) {
      strokeBuilderRef.current = new StrokeBuilder({
        brush: createDefaultBrush(hexToArgb('#24303a'), 3),
        minPointDistance: 0.8,
      });
    }

    useEffect(() => {
      onAppendTextRef.current = onAppendText;
    }, [onAppendText]);

    useEffect(() => {
      preContextRef.current = preContext;
    }, [preContext]);

    const syncStrokes = useCallback((nextStrokes: Stroke[]) => {
      strokesRef.current = nextStrokes;
      setStrokes(nextStrokes);
    }, []);

    const clearFeedbackTimer = useCallback(() => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    }, []);

    const clearRecognitionTimer = useCallback(() => {
      if (recognitionTimerRef.current !== null) {
        window.clearTimeout(recognitionTimerRef.current);
        recognitionTimerRef.current = null;
      }
    }, []);

    const setTransientFeedback = useCallback((message: string | null) => {
      clearFeedbackTimer();
      setFeedbackMessage(message);

      if (message) {
        feedbackTimerRef.current = window.setTimeout(() => {
          setFeedbackMessage(null);
          feedbackTimerRef.current = null;
        }, FEEDBACK_DURATION_MS);
      }
    }, [clearFeedbackTimer]);

    const runRecognition = useCallback((snapshot: Stroke[]): Promise<void> => {
      if (snapshot.length === 0) {
        return Promise.resolve();
      }

      const generation = recognitionGenerationRef.current;
      setPendingRecognitionCount((count) => count + 1);
      setErrorMessage(null);

      const job = (async () => {
        try {
          const result = await getRecognitionService().recognizeGoogle(
            snapshot,
            preContextRef.current?.trim() || undefined,
          );
          const recognizedText = result.rawText.trim();

          if (generation !== recognitionGenerationRef.current) {
            return;
          }

          if (recognizedText) {
            onAppendTextRef.current(recognizedText);
            setTransientFeedback(buildSuccessMessage(recognizedText));
          } else {
            setTransientFeedback('No text detected');
          }
        } catch (error) {
          if (generation === recognitionGenerationRef.current) {
            setErrorMessage(error instanceof Error ? error.message : 'Handwriting recognition failed');
          }
        } finally {
          setPendingRecognitionCount((count) => Math.max(0, count - 1));
        }
      })();

      recognitionJobsRef.current.add(job);
      void job.finally(() => {
        recognitionJobsRef.current.delete(job);
      });

      return job;
    }, [setTransientFeedback]);

    const flushPendingInk = useCallback(async () => {
      clearRecognitionTimer();

      const builder = strokeBuilderRef.current;
      let snapshot = strokesRef.current;

      if (builder?.isActive()) {
        const inProgressStroke = builder.finish();
        builder.cancel();
        setPreviewStroke(null);
        pointerIdRef.current = null;

        if (inProgressStroke) {
          snapshot = [...snapshot, inProgressStroke];
        }
      }

      if (snapshot.length > 0) {
        syncStrokes([]);
        await runRecognition(snapshot);
      }

      if (recognitionJobsRef.current.size > 0) {
        await Promise.all([...recognitionJobsRef.current]);
      }
    }, [clearRecognitionTimer, runRecognition, syncStrokes]);

    useImperativeHandle(ref, () => ({
      flushPendingInk,
    }), [flushPendingInk]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;

      const resizeCanvas = () => {
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const pixelRatio = window.devicePixelRatio || 1;

        canvas.width = Math.max(1, Math.round(width * pixelRatio));
        canvas.height = Math.max(1, Math.round(height * pixelRatio));
        setSurfaceSize({ width, height, pixelRatio });
      };

      resizeCanvas();

      const observer = new ResizeObserver(() => {
        resizeCanvas();
      });
      observer.observe(canvas);

      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || surfaceSize.width === 0 || surfaceSize.height === 0) return;

      const context = canvas.getContext('2d');
      if (!context) return;

      context.setTransform(surfaceSize.pixelRatio, 0, 0, surfaceSize.pixelRatio, 0, 0);
      context.clearRect(0, 0, surfaceSize.width, surfaceSize.height);

      for (const stroke of strokes) {
        renderStroke(context, stroke);
      }
      if (previewStroke) {
        renderStroke(context, previewStroke);
      }
    }, [previewStroke, strokes, surfaceSize]);

    useEffect(() => () => {
      clearRecognitionTimer();
      clearFeedbackTimer();
    }, [clearFeedbackTimer, clearRecognitionTimer]);

    const scheduleRecognition = useCallback(() => {
      clearRecognitionTimer();
      recognitionTimerRef.current = window.setTimeout(() => {
        void flushPendingInk();
      }, IDLE_RECOGNITION_DELAY_MS);
    }, [clearRecognitionTimer, flushPendingInk]);

    const getCanvasPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    }, []);

    const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      clearRecognitionTimer();
      clearFeedbackTimer();
      setFeedbackMessage(null);
      setErrorMessage(null);

      const builder = strokeBuilderRef.current;
      if (!builder) return;

      const point = getCanvasPoint(event);
      pointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      builder.start(point.x, point.y, event.pressure, event.pointerType);
      setPreviewStroke(builder.getCurrentStroke());
    }, [clearFeedbackTimer, clearRecognitionTimer, getCanvasPoint]);

    const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;

      const builder = strokeBuilderRef.current;
      if (!builder?.isActive()) return;

      const point = getCanvasPoint(event);
      builder.addPoint(point.x, point.y, event.pressure);
      setPreviewStroke(builder.getCurrentStroke());
    }, [getCanvasPoint]);

    const completeStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;

      const builder = strokeBuilderRef.current;
      if (!builder?.isActive()) return;

      const stroke = builder.finish();
      builder.cancel();
      pointerIdRef.current = null;
      setPreviewStroke(null);

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (!stroke) return;

      setStrokes((previous) => {
        const next = [...previous, stroke];
        strokesRef.current = next;
        return next;
      });
      scheduleRecognition();
    }, [scheduleRecognition]);

    const handleClear = useCallback(() => {
      recognitionGenerationRef.current += 1;
      pointerIdRef.current = null;
      clearRecognitionTimer();
      clearFeedbackTimer();
      strokeBuilderRef.current?.cancel();
      setPreviewStroke(null);
      setFeedbackMessage(null);
      setErrorMessage(null);
      syncStrokes([]);
    }, [clearFeedbackTimer, clearRecognitionTimer, syncStrokes]);

    const hasInk = strokes.length > 0 || previewStroke !== null;
    const statusTone = errorMessage
      ? 'error'
      : pendingRecognitionCount > 0
        ? 'busy'
        : feedbackMessage
          ? 'success'
          : 'idle';
    const statusMessage = errorMessage
      ?? (pendingRecognitionCount > 0
        ? 'Reading handwriting...'
        : feedbackMessage
          ?? (hasInk ? 'Pause for a moment to add this ink.' : 'Write here to append to the question.'));

    return (
      <div className="handwriting-pad">
        <div className="handwriting-pad-header">
          <div className="handwriting-pad-copy">
            <div className="handwriting-pad-title">Ink pad</div>
            <div className={`handwriting-pad-status ${statusTone}`}>{statusMessage}</div>
          </div>
          <button
            type="button"
            className="sidebar-mini-button"
            onClick={handleClear}
            disabled={!hasInk && pendingRecognitionCount === 0}
          >
            Clear
          </button>
        </div>

        <div className="handwriting-pad-surface">
          <canvas
            ref={canvasRef}
            className="handwriting-pad-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={completeStroke}
            onPointerCancel={completeStroke}
          />
          {!hasInk && (
            <div className="handwriting-pad-overlay">
              {pendingRecognitionCount > 0 ? 'Reading...' : 'Write here like the canvas to add to your question'}
            </div>
          )}
        </div>
      </div>
    );
  },
);
