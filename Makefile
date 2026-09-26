.PHONY: install run dev test lint

install:
	python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt

run:
	. .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000

dev:
	. .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

test:
	node tests/smoke.js
	node tests/offline.js
	node --experimental-vm-modules tests/model.js
	.venv/bin/python -m pytest tests/ -q
