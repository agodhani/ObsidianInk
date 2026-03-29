# ObsidianInk

React + TypeScript + Vite tablet-first handwritten note vault with:
- a canvas-based ink editor
- mirrored recognized text for search and linking
- Obsidian-style `[[wiki links]]`
- uploaded reference documents for grounded `???` research
- a local API server plus Docker Postgres/pgvector

## Getting Started

### Prerequisites
- Node.js (v18+)
- npm
- Docker Desktop or compatible Docker engine
- Optional: Ollama for local chat + embeddings

### Installation
```bash
npm install
```

### Environment Setup
Copy the example env file and configure:
```bash
cp .env.example .env
```

Required variables:
| Variable | Description | Default |
|----------|-------------|---------|
| `INK_RECOGNITION_API_URL` | Handwriting recognition API endpoint | *(none — must be set)* |
| `DATABASE_URL` | Local Postgres connection string | `postgres://postgres:postgres@localhost:5433/obsidianink` |
| `OLLAMA_BASE_URL` | Local Ollama endpoint | `http://localhost:11434` |
| `OLLAMA_CHAT_MODEL` | Local chat model for research answers | `llama3.1` |
| `OLLAMA_EMBED_MODEL` | Local embedding model for note/document indexing | `nomic-embed-text` |
| `OPENROUTER_LLMCHAT_API_KEY` | Fallback chat provider API key | *(optional)* |
| `OPENROUTER_LLMCHAT_MODEL` | Fallback OpenRouter model | *(optional)* |

You'll need a running instance of the recognition API. Set the URL in your `.env` file.

### Start the Local Stack
Start Postgres with pgvector:
```bash
docker compose up -d
```

Start the local API server:
```bash
npm run dev:server
```

Start the frontend:
```bash
npm run dev
```

### Running
```bash
npm run dev      # Start dev server, accessible on the local network
npm run dev:server # Start the local API server
npm run server     # Start the local API server (same as above)
npm run build    # TypeScript compile + Vite production bundle
npm run lint     # ESLint check
npm run preview  # Preview production build locally
```

The dev server is exposed on all network interfaces. The terminal output will show your network URL (e.g. `http://<your-ip>:5173`) that other devices on the same network can use to access the app.

### How It Works
Draw on the canvas with a pointer device. Strokes are captured, clustered,
and sent to the handwriting recognition API. Recognized text is mirrored into
the note index so the app can search notes, suggest `[[links]]`, and ground
`???` research questions against uploaded references.

The local API server stores notes, folders, mirrored text, resolved links,
uploaded files, chunks, and embeddings in Postgres/pgvector.

See `docs/New element HOWTO.md` for a guide on adding new element types.
