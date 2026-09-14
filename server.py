#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8765

ALLOWED_STATIC = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
}

LEVELS = {
    1: (3, 3, "easy"),
    2: (3, 3, "medium"),
    3: (3, 3, "hard"),
    4: (4, 4, "easy"),
    5: (4, 4, "medium"),
    6: (4, 4, "hard"),
    7: (4, 6, "easy"),
    8: (4, 5, "medium"),
    9: (4, 5, "hard"),
    10: (6, 6, "easy"),
    11: (5, 5, "medium"),
    12: (5, 6, "hard"),
}


def load_dotenv(path: Path) -> None:
    """Minimal .env reader so this project has no third-party Python dependency."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(ROOT / ".env")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"


def response_text(payload: dict[str, Any]) -> str:
    text = payload.get("output_text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    for item in payload.get("output", []) or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content", []) or []:
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                return content["text"].strip()
    return ""


def openai_post(body: dict[str, Any]) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is empty. Add it to the .env file and restart the server.")

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=data,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            obj = json.loads(detail)
            message = obj.get("error", {}).get("message", detail)
        except Exception:
            message = detail
        raise RuntimeError(f"OpenAI API error ({exc.code}): {message}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach OpenAI API: {exc.reason}") from exc


def generate_question(level: int) -> dict[str, Any]:
    if level not in LEVELS:
        raise ValueError("Unknown level")
    rows, variables, difficulty = LEVELS[level]
    total_cols = variables + 1
    magnitude = {"easy": 5, "medium": 9, "hard": 14}[difficulty]

    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["matrix"],
        "properties": {
            "matrix": {
                "type": "array",
                "minItems": rows,
                "maxItems": rows,
                "items": {
                    "type": "array",
                    "minItems": total_cols,
                    "maxItems": total_cols,
                    "items": {"type": "integer", "minimum": -magnitude, "maximum": magnitude},
                },
            }
        },
    }

    instructions = (
        "You generate one row-reduction practice problem for a matrix-learning app. "
        "Return only data that matches the supplied JSON schema. The final column is the augmented RHS. "
        "Use integers only. Avoid a zero row in the starting matrix. Avoid trivial identity/diagonal matrices. "
        "Make the arithmetic appropriate for the requested difficulty. For square systems, prefer a unique solution. "
        "For underdetermined systems, use a consistent system with full row rank so the exercise has infinitely many solutions."
    )
    user_input = (
        f"Generate Level {level}: {rows} equations, {variables} variables, {difficulty} difficulty. "
        f"The displayed augmented matrix must therefore have exactly {rows} rows and {total_cols} columns."
    )

    body = {
        "model": OPENAI_MODEL,
        "instructions": instructions,
        "input": user_input,
        "reasoning": {"effort": "none"},
        "text": {
            "verbosity": "low",
            "format": {
                "type": "json_schema",
                "name": "matrix_question",
                "strict": True,
                "schema": schema,
            },
        },
        "store": False,
    }
    payload = openai_post(body)
    text = response_text(payload)
    if not text:
        raise RuntimeError("OpenAI returned no text output.")
    try:
        result = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError("OpenAI returned output that was not valid JSON.") from exc

    matrix = result.get("matrix")
    if not isinstance(matrix, list) or len(matrix) != rows:
        raise RuntimeError("Generated matrix had the wrong number of rows.")
    for row in matrix:
        if not isinstance(row, list) or len(row) != total_cols or not all(isinstance(v, int) for v in row):
            raise RuntimeError("Generated matrix had an invalid shape or non-integer entry.")

    return {
        "matrix": matrix,
        "level": level,
        "rows": rows,
        "variables": variables,
        "difficulty": difficulty,
        "model": OPENAI_MODEL,
    }


def explain_mistake(data: dict[str, Any]) -> dict[str, Any]:
    operation = str(data.get("operation", "")).strip()
    expected = data.get("expected")
    actual = data.get("actual")
    issue = str(data.get("issue", "")).strip()
    carried = bool(data.get("carried"))

    instructions = (
        "You are the concise error-analysis coach inside an augmented-matrix row-reduction app. "
        "The deterministic checker is authoritative. Do not redo or contradict its arithmetic. "
        "Explain only the student's local mistake in 1-3 short sentences. Mention the relevant row operation or matrix entry. "
        "Do not give a long lesson, do not praise, and do not reveal unrelated later solution steps."
    )
    if carried:
        instructions += " This step is locally valid but carries an earlier incorrect matrix; say that clearly and concisely."

    user_input = json.dumps(
        {
            "operation": operation,
            "checker_issue": issue,
            "expected_matrix_after_operation": expected,
            "student_matrix": actual,
            "carried_from_earlier_error": carried,
        },
        ensure_ascii=False,
    )

    body = {
        "model": OPENAI_MODEL,
        "instructions": instructions,
        "input": user_input,
        "reasoning": {"effort": "none"},
        "text": {"verbosity": "low"},
        "store": False,
        "max_output_tokens": 180,
    }
    payload = openai_post(body)
    text = response_text(payload)
    if not text:
        raise RuntimeError("OpenAI returned no explanation.")
    return {"explanation": text, "model": OPENAI_MODEL}


class Handler(BaseHTTPRequestHandler):
    server_version = "MatrixLine/3.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, status: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/api/status":
            self.send_json(200, {
                "ok": True,
                "aiConfigured": bool(OPENAI_API_KEY),
                "model": OPENAI_MODEL if OPENAI_API_KEY else None,
            })
            return

        path = self.path.split("?", 1)[0]
        filename = ALLOWED_STATIC.get(path)
        if not filename:
            self.send_error(404)
            return
        file_path = ROOT / filename
        if not file_path.exists():
            self.send_error(404)
            return
        data = file_path.read_bytes()
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > 1_000_000:
            self.send_json(413, {"ok": False, "error": "Request too large."})
            return
        try:
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            self.send_json(400, {"ok": False, "error": "Invalid JSON request."})
            return

        try:
            if self.path == "/api/generate-question":
                level = int(data.get("level", 1))
                result = generate_question(level)
                self.send_json(200, {"ok": True, **result})
                return
            if self.path == "/api/explain-mistake":
                result = explain_mistake(data)
                self.send_json(200, {"ok": True, **result})
                return
            self.send_json(404, {"ok": False, "error": "Unknown API route."})
        except (ValueError, RuntimeError) as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": f"Unexpected server error: {exc}"})


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    print(f"Serving Matrix Line at {url}")
    if OPENAI_API_KEY:
        print(f"OpenAI API: configured ({OPENAI_MODEL})")
    else:
        print("OpenAI API: not configured — add OPENAI_API_KEY to .env and restart")
    print("Security: .env is NOT served by this local web server.")
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
