.DEFAULT_GOAL := help
SHELL := /bin/bash

ROOT := $(shell pwd)
REPO := $(abspath $(ROOT)/..)
SPA_SRC := $(REPO)/packages/app
SPA_DIST := $(SPA_SRC)/dist
SPA_DST := $(ROOT)/src/vs/workbench/contrib/opencode/media/spa
OPENCODE_BACKEND_VERSION := $(shell node -e "console.log(require('$(ROOT)/build/opencode-backend.json').builtFrom)" 2>/dev/null)
export OPENCODE_VERSION := $(OPENCODE_BACKEND_VERSION)
APP_NAME    := OpenCode IDE
APP_BUNDLE  := $(APP_NAME).app
BUILD_OUT   := $(REPO)/VSCode-darwin-arm64/$(APP_BUNDLE)
INSTALL_DST := /Applications/$(APP_BUNDLE)
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
	@echo "  Bundle backend:"
	@echo "    make vendor-opencode-backend             rebuild + validate + copy opencode binary into .vendored/"
	@echo "    make vendor-opencode-backend-validate-only  validate + copy without rebuild"
	@echo ""
	@echo "  Run:"
	@echo "    make run           launch dev build via scripts/code.sh"
	@echo ""
	@echo "  Install:"
	@echo "    make build         compile + vendor backend + build .app via gulp vscode-darwin-arm64"
	@echo "    make install       compile + build + cp .app to /Applications (with backup)"
	@echo "    make uninstall     restore the most recent /Applications/<app>.bak.*"
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

.PHONY: vendor-opencode-backend
vendor-opencode-backend:
	cd $(REPO) && bun packages/opencode/script/build.ts --single --skip-install
	node $(ROOT)/build/lib/vendor-opencode-backend.js

.PHONY: vendor-opencode-backend-validate-only
vendor-opencode-backend-validate-only:
	node $(ROOT)/build/lib/vendor-opencode-backend.js

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

.PHONY: build
build: compile vendor-opencode-backend
	@echo ">> gulp vscode-darwin-arm64..."
	bash -lc '$(NVM_SETUP) && NODE_OPTIONS=--max-old-space-size=8192 npx gulp vscode-darwin-arm64'
	@test -d "$(BUILD_OUT)" || { echo "ERROR: $(BUILD_OUT) not produced"; exit 1; }
	@echo ">> Built: $(BUILD_OUT)"

.PHONY: install
install: build
	@if [ -d "$(INSTALL_DST)" ]; then \
		BACKUP="$(INSTALL_DST).bak.$$(date +%Y%m%d-%H%M%S)"; \
		echo ">> Backing up $(INSTALL_DST) → $$BACKUP"; \
		mv "$(INSTALL_DST)" "$$BACKUP"; \
	fi
	@echo ">> Installing $(BUILD_OUT) → $(INSTALL_DST)"
	cp -R "$(BUILD_OUT)" "$(INSTALL_DST)"
	@stat -f ">> Installed at: %Sm" "$(INSTALL_DST)/Contents/Info.plist"
	@/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$(INSTALL_DST)/Contents/Info.plist" | xargs -I{} echo ">> Version: {}"

.PHONY: uninstall
uninstall:
	@LATEST=$$(ls -1dt "$(INSTALL_DST).bak."* 2>/dev/null | head -1); \
	if [ -z "$$LATEST" ]; then \
		echo "ERROR: No backup found matching $(INSTALL_DST).bak.*"; exit 1; \
	fi; \
	echo ">> Restoring backup: $$LATEST"; \
	rm -rf "$(INSTALL_DST)"; \
	mv "$$LATEST" "$(INSTALL_DST)"; \
	echo ">> Restored: $(INSTALL_DST)"
