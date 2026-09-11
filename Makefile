# Kerros — developer entry points. Thin wrappers over the npm scripts, which stay the source of
# truth; this is here so `make` alone tells you what you can do. Run `make` for the list.

NPM      ?= npm
PORT     ?= 5173
DOCS_PORT ?= 5174

.DEFAULT_GOAL := help
.PHONY: help install dev docs test watch e2e check format format-check types build preview site lib media clean clean-all plan-stats plan-extract plan-apply plan-agent

help: ## List the available tasks
	@echo "Kerros — make <task>"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  Variables: PORT=$(PORT) DOCS_PORT=$(DOCS_PORT)"

install: ## Install dependencies
	$(NPM) install

# ——— Running things

dev: ## Run the reference apps — hub, editor and viewer (prints the URLs)
	@echo "  hub     http://127.0.0.1:$(PORT)/"
	@echo "  editor  http://127.0.0.1:$(PORT)/app.html"
	@echo "  viewer  http://127.0.0.1:$(PORT)/viewer.html"
	@echo
	$(NPM) run dev -- --port $(PORT) --strictPort

docs: ## Run the VitePress manual
	$(NPM) run docs:dev -- --port $(DOCS_PORT) --strictPort

preview: build ## Serve the production build locally
	$(NPM) run preview -- --port $(PORT) --strictPort

# ——— Checking things

test: ## Run the unit tests once
	$(NPM) test

watch: ## Run the unit tests in watch mode
	npx vitest

e2e: ## Run the Playwright end-to-end tests (starts its own server)
	$(NPM) run test:e2e

types: ## Type-check without emitting
	npx tsc -b

format: ## Format the source in place
	$(NPM) run format

format-check: ## Check formatting without writing
	$(NPM) run format:check

check: format-check types test ## Formatting, types and tests — run this before committing

# ——— Building things

build: ## Type-check and build the reference apps
	$(NPM) run build

site: ## Build the full published site (apps + manual) into dist/
	$(NPM) run build:site

lib: ## Build the publishable packages
	$(NPM) run build:lib

media: ## Re-capture the docs hero and showcase (needs .env.local and ffmpeg)
	$(NPM) run capture:media

# ——— CAD plan import. DWG=<file> is required; see scripts/plan-import/README.md.

plan-stats: ## Per-layer census of a drawing (DWG=path/to/plan.dwg)
	@test -n "$(DWG)" || { echo "usage: make plan-stats DWG=path/to/plan.dwg"; exit 2; }
	node scripts/plan-import/extract.mjs "$(DWG)" --expand --units m --stats

plan-extract: ## Extract a drawing to normalized JSON (DWG=… OUT=slice.json)
	@test -n "$(DWG)" || { echo "usage: make plan-extract DWG=path/to/plan.dwg [OUT=slice.json]"; exit 2; }
	node scripts/plan-import/extract.mjs "$(DWG)" --expand --units m --out "$(or $(OUT),slice.json)"

plan-apply: ## Apply a mutation script to a document (SCRIPT=script.json OUT=doc.json)
	@test -n "$(SCRIPT)" || { echo "usage: make plan-apply SCRIPT=script.json [OUT=doc.json]"; exit 2; }
	npx vite-node scripts/plan-import/apply.ts -- "$(SCRIPT)" --out "$(or $(OUT),doc.json)" --svg "$(or $(OUT),doc).svg"

plan-agent: ## Drive the AI import loop over a drawing (DWG=… OUT=…; needs ANTHROPIC_API_KEY)
	@test -n "$(DWG)" || { echo "usage: make plan-agent DWG=path/to/plan.dwg [OUT=imported.json]"; exit 2; }
	npx vite-node scripts/plan-import/agent.ts -- "$(DWG)" --out "$(or $(OUT),imported.json)"

# ——— Cleaning up

clean: ## Remove build output and caches
	rm -rf dist docs/.vitepress/dist docs/.vitepress/cache node_modules/.vite* test-results *.tsbuildinfo

clean-all: clean ## Remove build output and node_modules
	rm -rf node_modules
