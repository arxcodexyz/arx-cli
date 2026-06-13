.PHONY: all install build dev clean test typecheck lint link unlink help

# ── ArxCode CLI Makefile ──────────────────────────────────────────
# Default target
all: install build

# Install dependencies
install:
	npm install

# Build TypeScript → dist/
build:
	npx tsc

# Build + link globally
dev: build
	npm link

# Clean build artifacts
clean:
	rm -rf dist/
	rm -f *.tsbuildinfo

# Typecheck without emitting
typecheck:
	npx tsc --noEmit

# Lint (biome when available)
lint:
	@if command -v biome >/dev/null 2>&1; then \
		npx biome check . --write 2>/dev/null || true; \
	else \
		echo "  ⚠ biome not installed — skip lint"; \
	fi

# Run tests (placeholder)
test:
	@echo "  ℹ No test suite yet. Test manually: node dist/bin/arx.js 'say hello'"

# Quick smoke test
smoke:
	node dist/bin/arx.js "say hi in 3 words" 2>&1 | tail -3

# Link CLI globally
link:
	npm link

# Unlink
unlink:
	npm unlink -g arx-cli

# Help
help:
	@echo "ArxCode CLI Makefile"
	@echo ""
	@echo "  make install   — npm install"
	@echo "  make build     — compile TypeScript"
	@echo "  make dev       — build + npm link (dev mode)"
	@echo "  make clean     — remove dist/"
	@echo "  make typecheck — tsc --noEmit"
	@echo "  make lint      — biome check"
	@echo "  make test      — placeholder"
	@echo "  make smoke     — quick smoke test"
	@echo "  make link      — npm link (global arx)"
	@echo "  make unlink    — npm unlink"
	@echo "  make all       — install + build"
