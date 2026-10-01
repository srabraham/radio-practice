CH ?= 5
CALLSIGN ?= BOT1
ADDR ?= :5580

# Easy-to-guess passwords for local practice only; serve leaves them unset
# so the server generates random ones unless you set your own.
run bot: export RADIO_PASSWORD ?= practice
run bot: export RADIO_INSTRUCTOR_PASSWORD ?= control

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: run
run: ## Run the server in dev mode (serves web/ from disk)
	go run . -dev

.PHONY: serve
serve: ## Build and run for production over plain HTTP (ADDR=:5580)
	go build -o radio .
	./radio -addr $(ADDR)

.PHONY: bot
bot: ## Run a scripted radio (CALLSIGN=BOT1 CH=5)
	go run ./cmd/radiobot -password $(RADIO_PASSWORD) -callsign $(CALLSIGN) -ch $(CH)

.PHONY: build
build: ## Build the radio and radiobot binaries
	go build -o radio .
	go build -o radiobot ./cmd/radiobot

.PHONY: build-linux
build-linux: ## Cross-compile the server for linux/arm64
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o radio .

.PHONY: test
test: ## Run Go tests
	go test ./...

.PHONY: vet
vet: ## Run go vet
	go vet ./...

.PHONY: fmt
fmt: ## Format Go code
	gofmt -w .

.PHONY: check
check: vet test e2e-typecheck ## Run vet, Go tests, and e2e typecheck

e2e/node_modules: e2e/package-lock.json
	cd e2e && npm ci
	@touch $@

.PHONY: e2e-install
e2e-install: e2e/node_modules ## Install e2e deps and Playwright browsers
	cd e2e && npx playwright install chromium firefox webkit

.PHONY: e2e
e2e: e2e/node_modules ## Run Playwright tests (PROJECT=firefox to pick one)
	cd e2e && npx playwright test $(if $(PROJECT),--project=$(PROJECT))

.PHONY: e2e-typecheck
e2e-typecheck: e2e/node_modules ## Typecheck the e2e suite
	cd e2e && npm run typecheck

.PHONY: e2e-report
e2e-report: ## Open the last Playwright report
	cd e2e && npm run report

.PHONY: docker
docker: ## Build and start with docker compose
	docker compose up -d --build

.PHONY: clean
clean: ## Remove build outputs and test results
	rm -f radio radiobot
	rm -rf e2e/test-results e2e/playwright-report
