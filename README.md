# Matrix Line v3

A local augmented-matrix row-reduction practice app with exact arithmetic checking and optional OpenAI question generation / concise error analysis.

## 1. Add your OpenAI Platform key

Open `.env` in this folder and paste your key after the equals sign:

```env
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-5.6-luna
```

Do not put the key in `index.html` or `app.js`. `.env` is included in `.gitignore`, and the local web server explicitly refuses to serve `.env`.

## 2. Start the app

### macOS
Double-click `run.command`, or in Terminal:

```bash
cd /path/to/matrix-line-platform
./run.command
```

The browser opens at:

```text
http://127.0.0.1:8765
```

Press Control-C in the Terminal window to stop the server.

No pip packages are required: `server.py` uses Python's standard library for the HTTPS API call and reads `.env` itself.

## OpenAI connection

The browser never calls OpenAI directly:

```text
Browser (app.js)
   ↓ POST /api/generate-question or /api/explain-mistake
Local server.py
   ↓ HTTPS POST https://api.openai.com/v1/responses
OpenAI Responses API
```

The key stays on the Python side. API requests use `store: false`.

If the key is missing or an AI request fails, exact matrix checking still works and New Question falls back to a local validated generator.

## Transformation box behavior

Typing:

```text
R3 - 2R1 --> R3
```

immediately becomes:

```text
R3 - 2R1 → R3
```

Typing `<-->` becomes `↔` for row swaps.

Each transformation box supports multiple operations, one per line, applied from top to bottom, e.g.:

```text
R3 - 2R1 → R3
R2 + R1 → R2
R4 ↔ R3
-(1/4)R4 → R4
```

## Checking colors

- **Green**: this transformation is locally correct.
- **Red**: a new mistake occurs in this step.
- **Amber**: this operation is valid, but it carries an earlier incorrect matrix forward.
- A new later mistake turns red again even after amber carried-error steps.

The arithmetic checker is deterministic and uses exact rational arithmetic. The LLM only generates questions and turns an exact checker result into a concise explanation.
