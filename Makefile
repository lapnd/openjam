# OpenJam — build, package and test for Chrome and Firefox.
#
#   make install         npm ci
#   make build-chrome    build/chrome/   (load unpacked)  + build/openjam-chrome.zip
#   make build-firefox   build/firefox/  (load temporary) + build/openjam-firefox.zip
#   make test            unit + Chrome e2e + Firefox e2e
#   make clean
#
# Each browser builds into its own directory, so the two never mix, and the
# repo's manifest.json is only ever read. Requirements: Node >= 20, npm, zip,
# Bun (unit tests), and for the e2e suites Playwright's Chromium
# (`npx playwright install chromium`) and Firefox (`make firefox-install`).

NPM ?= npm
NODE ?= node

.DEFAULT_GOAL := help
.PHONY: help install bundles build build-chrome build-firefox verify \
        test test-unit test-chrome test-firefox firefox-install lint-firefox clean distclean

help: ## List the targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  make %-16s %s\n", $$1, $$2}'

install: ## Install dependencies from package-lock.json
	$(NPM) ci

bundles: ## Bundle rrweb into dist/ and src/generated/ (npm run build)
	$(NPM) run build

build-chrome: bundles ## Chrome/Chromium: build/chrome/ + build/openjam-chrome.zip
	$(NODE) scripts/build-extension.mjs chrome

build-firefox: bundles ## Firefox: build/firefox/ + build/openjam-firefox.zip
	$(NODE) scripts/build-extension.mjs firefox

build: build-chrome build-firefox ## Both browsers

verify: ## Re-check both built packages (manifest, every referenced path, nothing unreachable)
	$(NODE) scripts/verify-package.mjs build/chrome build/firefox

test: ## Everything npm test runs: bundles, unit, Chrome e2e, Firefox e2e
	$(NPM) test

test-unit: bundles ## Unit tests (Bun)
	$(NPM) run test:unit

test-chrome: build-chrome ## Chrome e2e (Playwright) against the packaged build/chrome/
	OPENJAM_EXTENSION_DIR=build/chrome npx playwright test

test-firefox: bundles ## Firefox e2e (real Firefox; needs `make firefox-install` or FIREFOX_PATH)
	$(NPM) run test:firefox

firefox-install: ## Download the pinned Firefox the e2e suite drives (into node_modules/.cache)
	$(NPM) run firefox:install

lint-firefox: build-firefox ## Mozilla's web-ext lint on the Firefox build (fetches web-ext via npx; exits non-zero on errors only)
	npx --yes web-ext lint --source-dir build/firefox

clean: ## Remove build output (build/, dist/, src/generated/, zips, test results)
	rm -rf build dist src/generated openjam.zip test-results

distclean: clean ## clean + node_modules
	rm -rf node_modules
