.PHONY: install run dev test lint pages

# Tests run against the venv when it exists (local), against the ambient
# interpreter when it does not (CI can point PYTHON wherever it installed).
PYTHON ?= .venv/bin/python

install:
	python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt

run:
	. .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000

dev:
	. .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

pages:
	python3 scripts/build_pages.py

test:
	node tests/smoke.js
	node tests/pages.js
	node tests/offline.js
	node tests/viewport.js
	node tests/download.js
	node tests/grounding.js
	node tests/sw.js
	node --experimental-vm-modules tests/prep.js
	node --experimental-vm-modules tests/model.js
	$(PYTHON) -m pytest tests/ -q

lint:
	@if command -v ruff >/dev/null 2>&1; then \
		ruff check app tests scripts; \
	elif [ -x .venv/bin/ruff ]; then \
		.venv/bin/ruff check app tests scripts; \
	else \
		echo "ruff not installed; falling back to compileall"; \
		$(PYTHON) -m compileall -q app tests scripts; \
	fi
