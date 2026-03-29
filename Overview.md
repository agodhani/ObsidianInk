ObsidianInk (Ink Playground) — Comprehensive Overview

  1. Project Type

  Web SPA — React + TypeScript + Vite. An interactive ink-based canvas app with handwriting recognition, shape detection,
  AI-powered element generation, and a plugin-based element system.

  ---
  2. Tech Stack & Key Dependencies

  ┌───────────────┬─────────────────┬─────────┐
  │   Category    │  Library/Tool   │ Version │
  ├───────────────┼─────────────────┼─────────┤
  │ UI Framework  │ React           │ 19.2.0  │
  ├───────────────┼─────────────────┼─────────┤
  │ Language      │ TypeScript      │ 5.9.3   │
  ├───────────────┼─────────────────┼─────────┤
  │ Build Tool    │ Vite            │ 7.2.4   │
  ├───────────────┼─────────────────┼─────────┤
  │ LLM Inference │ @openrouter/sdk │ 0.9.11  │
  ├───────────────┼─────────────────┼─────────┤
  │ Geometry      │ concaveman      │ 2.0.0   │
  └───────────────┴─────────────────┴─────────┘

  External APIs (via .env):
  - INK_RECOGNITION_API_URL — Handwriting recognition backend (required)
  - INK_OPENROUTER_API_KEY — LLM inference (Gemini 2.5 Flash default)
  - INK_FAL_AI_API_KEY — Sketch-to-image generation (fal.ai)
  - INK_GEMINI_API_KEY — Image generation (Google Gemini)

  ---
  3. Architecture & Folder Structure

  src/
  ├── App.tsx                    # Main app orchestration
  ├── types/                     # Core types (primitives, brush, elements, noteContent)
  ├── canvas/                    # Dual-canvas rendering engine
  │   ├── InkCanvas.tsx          # Main canvas component
  │   ├── ViewportManager.ts     # Pan/zoom
  │   ├── StrokeRenderer.ts
  │   └── HandleRenderer.ts
  ├── elements/                  # Plugin-based element system
  │   ├── registry/              # ElementRegistry + ElementPlugin interface
  │   └── <type>/                # Each element self-contained (types, renderer, creator, interaction, icon)
  ├── input/                     # StrokeBuilder: pointer events → Stroke objects
  ├── recognition/               # Handwriting recognition REST client + stroke clustering
  ├── eraser/                    # Scribble-erase gesture detection
  ├── state/                     # useUndoRedo hook
  ├── ai/                        # OpenRouterService (LLM client)
  ├── hooks/                     # AI generation hooks (image, nonogram, jigsaw, colorconnect)
  ├── services/                  # FalAiService, GeminiImageService, compositing, stylePresets
  ├── geometry/                  # Shape recognition, rectangle+X detection
  ├── disambiguation/            # Disambiguation menu overlay
  ├── palette/                   # Palette menu (rectangle+X gesture)
  ├── lasso/                     # Lasso selection menu
  ├── toast/                     # Toast notifications
  └── debug/                     # DebugLogger + DebugConsole

  ---
  4. Element Types (19 total)

  ┌──────────────────────────┬───────────────────┬─────────────────────┐
  │                          │                   │                     │
  ├──────────────────────────┼───────────────────┼─────────────────────┤
  │ Stroke                   │ Shape (geometric) │ Glyph (single char) │
  ├──────────────────────────┼───────────────────┼─────────────────────┤
  │ InkText (multi-line)     │ TicTacToe         │ CoordinatePlane     │
  ├──────────────────────────┼───────────────────┼─────────────────────┤
  │ SketchableImage (AI-gen) │ Image             │ Sudoku              │
  ├──────────────────────────┼───────────────────┼─────────────────────┤
  │ Bridges                  │ Minesweeper       │ Nonogram            │
  ├──────────────────────────┼───────────────────┼─────────────────────┤
  │ Tango                    │ Queens            │ Jigsaw              │
  ├──────────────────────────┼───────────────────┼─────────────────────┤
  │ ColorConnect             │                   │                     │
  └──────────────────────────┴───────────────────┴─────────────────────┘

  ---
  5. Key Data Models

  - Element — Union type discriminated by type string literal
  - TransformableElement — Base: id + 3×3 affine transform matrix
  - Stroke — inputs (x, y, timeMillis, pressure?, tilt?) + brush
  - NoteElements — Top-level container: { elements: Element[], metadata? }
  - HandwritingRecognitionResult — lines[] of RecognizedToken[] with candidates + strokeIndices
  - ElementPlugin<T> — Plugin interface: canCreate(), createFromInk(), isInterestedIn(), acceptInk(), getHandles(), onHandleDrag()

  ---
  6. User Interaction Flow

  1. User draws → StrokeBuilder accumulates pointer events
  2. Pen up → 650ms debounce clusters strokes
  3. ElementRegistry dispatches to all plugins → best match wins
  4. If ambiguous → DisambiguationMenu overlay
  5. Element added to noteElements state → renders on main canvas
  6. Additional gestures:
    - Rectangle+X → PaletteMenu (create element from palette)
    - Lasso draw → LassoMenu (bulk select)
    - Scribble → erases overlapping elements
    - Tap → select/deselect
    - Pinch → zoom viewport
    - Ctrl+Z / Ctrl+Shift+Z → undo/redo

  ---
  7. Backend/API Integrations

  ┌─────────────────────────┬────────────────────────────────────────┬──────────────────────────────────┐
  │         Service         │              Endpoint/SDK              │             Purpose              │
  ├─────────────────────────┼────────────────────────────────────────┼──────────────────────────────────┤
  │ Handwriting Recognition │ POST /api/recognition/recognize_google │ Convert ink strokes → text       │
  ├─────────────────────────┼────────────────────────────────────────┼──────────────────────────────────┤
  │ OpenRouter              │ @openrouter/sdk                        │ Puzzle generation, LLM prompting │
  ├─────────────────────────┼────────────────────────────────────────┼──────────────────────────────────┤
  │ fal.ai                  │ REST API                               │ Sketch-to-image generation       │
  ├─────────────────────────┼────────────────────────────────────────┼──────────────────────────────────┤
  │ Google Gemini           │ REST API                               │ Image generation alternative     │
  └─────────────────────────┴────────────────────────────────────────┴──────────────────────────────────┘

  Persistence: localStorage for NoteElements (canvas state) and Viewport (pan/zoom).

  ---
  8. Key Patterns & Conventions

  - Plugin Architecture — Each element type fully self-contained; registers itself on import; no changes to App.tsx needed to add a
   new type
  - Immutable State — All types JSON-serializable; no mutations; enables undo/redo + localStorage
  - Dual Canvas — Main canvas (committed elements) + overlay canvas (in-progress strokes, selection, handles)
  - Transform Matrix — Column-major 3×3 affine matrix (Android-style) for all transformable elements
  - Async Creation — createFromInk() is async; elements can call APIs (puzzles, images) during creation
  - Branch naming — feature/INK-00/description, bug/INK-00/description
  - Commit messages — INK-00: Description of change
  - No test framework configured

  ---
  9. Key Files Quick Reference

  ┌──────────────────────────────────────────┬────────────────────────────────────┐
  │                   File                   │              Purpose               │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/App.tsx                              │ Main app logic & state             │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/canvas/InkCanvas.tsx                 │ Canvas component                   │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/types/elements.ts                    │ Element union type                 │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/elements/registry/ElementRegistry.ts │ Plugin dispatcher                  │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/elements/registry/ElementPlugin.ts   │ Plugin interface definition        │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/recognition/RecognitionService.ts    │ Handwriting API client             │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/ai/OpenRouterService.ts              │ LLM client                         │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ src/state/useUndoRedo.ts                 │ Undo/redo hook                     │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ docs/New element HOWTO.md                │ Guide for adding new element types │
  ├──────────────────────────────────────────┼────────────────────────────────────┤
  │ vite.config.ts                           │ Build config + dev proxy           │
  └──────────────────────────────────────────┴────────────────────────────────────┘

  ---
  This is a well-architected, extensible prototyping platform. The plugin system is the core design pattern — adding new
  interactive element types requires no changes to core files, just creating a new folder under src/elements/<type>/ and
  implementing the plugin interface.