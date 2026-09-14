# Matrix Line AI behavior

The app uses OpenAI only for two narrow tasks. Exact row-operation grading is done locally with rational arithmetic in `app.js`.

## 1. Question generation

`server.py` calls the OpenAI Responses API with Structured Outputs (`text.format.type = json_schema`). The schema requires exactly one integer augmented matrix with the selected dimensions. The prompt requests nontrivial arithmetic appropriate to easy / medium / hard difficulty.

The browser validates a returned square system before accepting it. If the API is unavailable or validation fails, it uses the local question generator.

## 2. Error explanation

The local checker sends the already-determined operation, expected matrix, actual matrix, and exact issue to `/api/explain-mistake`. The model is instructed that the deterministic checker is authoritative and must explain only the local error in 1–3 short sentences.

## Model

Default:

```env
OPENAI_MODEL=gpt-5.6-luna
```

Change this value in `.env` if you want another OpenAI Responses API model.
