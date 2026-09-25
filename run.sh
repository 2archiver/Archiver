#!/usr/bin/env bash
# Start Archiver. Usage: ./run.sh [port]
set -euo pipefail
cd "$(dirname "$0")"
# Prefer an explicit argument, then the platform's $PORT (Render, Fly, Heroku…),
# then 8000 for local use.
PORT="${1:-${PORT:-8000}}"
if [ -d .venv ]; then . .venv/bin/activate; fi
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
