.PHONY: setup dev start build test serve mcp

setup:            ## Install backend (Python venv) and app (npm) dependencies
	cd backend && (command -v uv >/dev/null && uv venv -q .venv && uv pip install -q --python .venv -e '.[dev]' \
	  || (python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]'))
	cd app && npm install

dev:              ## Run the desktop app with hot reload
	cd app && npm run dev

start:            ## Build the UI and run the desktop app
	cd app && npm start

build:            ## Type-check and build the UI
	cd app && npm run build

test:             ## Backend tests + UI type-check
	cd backend && .venv/bin/pytest -q
	cd app && npm run typecheck

serve:            ## Server mode: API + web UI on http://127.0.0.1:8765 (prints the access token)
	cd app && npm run build
	cd backend && .venv/bin/python -m brain2 serve

mcp:              ## MCP server over stdio
	cd backend && .venv/bin/python -m brain2 mcp
