.DEFAULT_GOAL := help
SHELL := /bin/bash

ROOT := $(shell pwd)
REPO := $(abspath $(ROOT)/..)
SPA_SRC := $(REPO)/packages/app
SPA_DIST := $(SPA_SRC)/dist
SPA_DST := $(ROOT)/src/vs/workbench/contrib/opencode/media/spa
NVM_SETUP := source $$HOME/.nvm/nvm.sh && nvm use 22

.PHONY: help
help:
	@echo "opencode-ide-fork - Makefile targets:"
	@echo ""
	@echo "  Build:"
	@echo "    make install-deps  npm install (root)"
	@echo "    make compile       gulp compile (full build)"
	@echo "    make watch         watch mode for dev"
	@echo "    make typecheck     TypeScript --noEmit check"
	@echo ""
	@echo "  SPA vendor:"
	@echo "    make vendor-spa    rebuild SPA from packages/app and copy to media/spa/"
	@echo "    make clean-spa     remove vendored SPA"
	@echo ""
	@echo "  Run:"
	@echo "    make run           launch dev build via scripts/code.sh"
	@echo ""
	@echo "  Test:"
	@echo "    make smoke         run full smoke suite"
	@echo "    make smoke-opencode smoke filtered to OpenCode tests"
	@echo ""
	@echo "  Clean:"
	@echo "    make clean         remove out/"

.PHONY: install-deps
install-deps:
	@echo ">> Installing deps..."
	bash -lc '$(NVM_SETUP) && npm install'

.PHONY: compile
compile:
	@echo ">> Running npm run compile (gulp)..."
	bash -lc '$(NVM_SETUP) && NODE_OPTIONS=--max-old-space-size=8192 npm run compile'

.PHONY: watch
watch:
	bash -lc '$(NVM_SETUP) && NODE_OPTIONS=--max-old-space-size=8192 npm run watch'

.PHONY: vendor-spa
vendor-spa:
	@echo ">> Building SPA at $(SPA_SRC)..."
	cd $(SPA_SRC) && bun run build
	@test -f "$(SPA_DIST)/index.html" || { echo "ERROR: $(SPA_DIST)/index.html not produced"; exit 1; }
	@echo ">> Copying dist to $(SPA_DST)..."
	rm -rf "$(SPA_DST)"
	mkdir -p "$(SPA_DST)"
	cp -R "$(SPA_DIST)/." "$(SPA_DST)/"
	@echo ">> Vendored $$(ls -1 $(SPA_DST) | wc -l | tr -d ' ') top-level entries"

.PHONY: clean-spa
clean-spa:
	rm -rf "$(SPA_DST)"
	@echo ">> Removed $(SPA_DST)"

.PHONY: run
run:
	bash -lc '$(NVM_SETUP) && ./scripts/code.sh'

.PHONY: smoke
smoke:
	bash -lc '$(NVM_SETUP) && npm run smoketest -- --verbose'

.PHONY: smoke-opencode
smoke-opencode:
	bash -lc '$(NVM_SETUP) && npm run smoketest -- --verbose -g "OpenCode"'

.PHONY: typecheck
typecheck:
	bash -lc '$(NVM_SETUP) && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit --skipLibCheck -p src/tsconfig.json'

.PHONY: clean
clean:
	rm -rf out/ node_modules/*cache
	@echo ">> Removed out/ and node_modules/*cache"
