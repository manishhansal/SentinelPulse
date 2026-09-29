# =============================================================================
# SentinelPulse — Makefile
#
# Convenience targets that wrap deploy.sh and docker compose.
# All docker targets use .env.local by default; override with:
#   make deploy ENV_FILE=.env.production
#
# Usage:
#   make deploy          — full rebuild + redeploy (what CI runs)
#   make rollback        — restore previous :rollback images
#   make status          — show running containers + health
#   make logs            — tail all service logs
#   make logs-api        — tail only the API logs
#   make up              — start stack without rebuilding
#   make down            — stop all containers
#   make build           — build images only (no restart)
#   make restart         — restart without rebuilding
#   make shell-api       — open a shell in the running API container
#   make migrate         — run Prisma migrate deploy manually
#   make seed            — seed news sources into the database
#   make ps              — alias for status
#   make clean           — stop containers + prune dangling images/networks
# =============================================================================

SHELL := /usr/bin/env bash

# ── Configurable variables ────────────────────────────────────────────────────

ENV_FILE      ?= .env.local
COMPOSE_FILE  ?= docker/docker-compose.yml
COMPOSE       := docker compose -f $(COMPOSE_FILE) --env-file $(ENV_FILE)
DEPLOY_SCRIPT := ./deploy.sh

# Coloured output helpers
BOLD  := \033[1m
CYAN  := \033[0;36m
GREEN := \033[0;32m
RESET := \033[0m

.DEFAULT_GOAL := help

# ── Help ──────────────────────────────────────────────────────────────────────

.PHONY: help
help:
	@echo ""
	@printf "$(BOLD)$(CYAN)SentinelPulse — Available Targets$(RESET)\n"
	@echo "────────────────────────────────────────────────────"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-18s$(RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "  Override env file:  make deploy ENV_FILE=.env.production"
	@echo ""

# ── Deployment ────────────────────────────────────────────────────────────────

.PHONY: deploy
deploy: ## Full rebuild & redeploy (pull code, build images, rolling restart, health check)
	@bash $(DEPLOY_SCRIPT) --env-file $(ENV_FILE)

.PHONY: deploy-no-pull
deploy-no-pull: ## Rebuild & redeploy using current working tree (no git pull)
	@bash $(DEPLOY_SCRIPT) --no-pull --env-file $(ENV_FILE)

.PHONY: rollback
rollback: ## Roll back to the previous :rollback images
	@bash $(DEPLOY_SCRIPT) --rollback --env-file $(ENV_FILE)

.PHONY: dry-run
dry-run: ## Preview what deploy would do without making any changes
	@bash $(DEPLOY_SCRIPT) --dry-run --env-file $(ENV_FILE)

# ── Stack lifecycle ───────────────────────────────────────────────────────────

.PHONY: build
build: ## Build Docker images without restarting containers
	$(COMPOSE) build --pull

.PHONY: up
up: ## Start all containers (no rebuild)
	$(COMPOSE) up -d --remove-orphans

.PHONY: down
down: ## Stop and remove all containers
	$(COMPOSE) down

.PHONY: restart
restart: ## Restart all containers without rebuilding
	$(COMPOSE) restart

.PHONY: restart-api
restart-api: ## Restart only the API container (runs migrations on startup)
	$(COMPOSE) restart api

# ── Observability ─────────────────────────────────────────────────────────────

.PHONY: status
status: ## Show running containers, ports, and health status
	$(COMPOSE) ps

.PHONY: ps
ps: status ## Alias for status

.PHONY: logs
logs: ## Tail logs from all services (Ctrl-C to stop)
	$(COMPOSE) logs -f --tail=100

.PHONY: logs-api
logs-api: ## Tail logs from the API service only
	$(COMPOSE) logs -f --tail=100 api

.PHONY: logs-worker
logs-worker: ## Tail logs from all worker services
	$(COMPOSE) logs -f --tail=50 \
		worker-normalize worker-dedup worker-entity worker-event \
		worker-sentiment worker-impact worker-feature worker-embed

.PHONY: logs-cron
logs-cron: ## Tail logs from all cron services
	$(COMPOSE) logs -f --tail=50 cron-velocity cron-breadth cron-regime

.PHONY: health
health: ## Curl the API health endpoint
	@curl -s http://localhost:3001/health | python3 -m json.tool || \
		curl -sv http://localhost:3001/health

# ── Database ──────────────────────────────────────────────────────────────────

.PHONY: migrate
migrate: ## Run Prisma migrate deploy against the configured DATABASE_URL
	$(COMPOSE) exec api node_modules/.bin/prisma migrate deploy

.PHONY: seed
seed: ## Seed news sources into the database
	$(COMPOSE) exec api node dist/scripts/seed-sources.js

.PHONY: backfill
backfill: ## Start historical news backfill (2021-01-01 → today, batch=200, all sources)
	@echo "▶  Starting SentinelPulse historical news backfill..."
	@echo "   This enqueues the job. The backfill worker must be running to process it."
	@echo "   Worker: make worker-backfill  (separate terminal)"
	@set -a && source $(ENV_FILE) && set +a && \
		npx tsx src/scripts/start-backfill.ts \
			--start $${BACKFILL_START:-2021-01-01} \
			--end $${BACKFILL_END:-$(shell date +%Y-%m-%d)} \
			--batch $${BACKFILL_BATCH:-200}

.PHONY: backfill-status
backfill-status: ## Show status of backfill job (JOB_ID=<uuid> make backfill-status, or list all)
	@set -a && source $(ENV_FILE) && set +a && \
		JOB_ID=$(JOB_ID) npx tsx src/scripts/backfill-status.ts

.PHONY: worker-backfill
worker-backfill: ## Run the backfill worker locally (processes news.backfill queue)
	@echo "▶  Starting backfill worker (WORKER_BACKFILL_CONCURRENCY=1)..."
	@echo "   This process must stay running while backfill is active."
	@set -a && source $(ENV_FILE) && set +a && \
		WORKER_BACKFILL_CONCURRENCY=1 \
		BACKFILL_BATCH_DELAY_MS=500 \
		npx tsx src/workers/backfill.worker.ts

.PHONY: backfill-full
backfill-full: ## Start backfill AND launch worker in background (convenience target)
	@echo "▶  Starting full backfill sequence (enqueue + worker)..."
	@$(MAKE) worker-backfill &
	@sleep 2
	@$(MAKE) backfill
	@echo ""
	@echo "Worker is running in background. Monitor with: make backfill-status"
	@echo "Stop worker: kill %% (or Ctrl+C in its terminal)"

.PHONY: prisma-studio
prisma-studio: ## Open Prisma Studio (runs on host, not in container)
	@set -a && source $(ENV_FILE) && set +a && npx prisma studio

# ── Shell access ──────────────────────────────────────────────────────────────

.PHONY: shell-api
shell-api: ## Open an interactive shell in the running API container
	$(COMPOSE) exec api sh

.PHONY: shell-scrapling
shell-scrapling: ## Open an interactive shell in the scrapling container
	$(COMPOSE) exec scrapling sh

# ── Cleanup ───────────────────────────────────────────────────────────────────

.PHONY: clean
clean: ## Stop containers and prune dangling images + networks
	$(COMPOSE) down --remove-orphans
	docker image prune -f
	docker network prune -f
	@printf "$(GREEN)Clean complete.$(RESET)\n"

.PHONY: clean-all
clean-all: ## WARNING: stop containers, remove volumes, prune everything
	@echo "This will remove all containers, volumes, and dangling images."
	@read -p "Are you sure? [y/N] " CONFIRM && [[ "$$CONFIRM" == "y" ]] || exit 1
	$(COMPOSE) down --volumes --remove-orphans
	docker image prune -af
	docker network prune -f
	docker volume prune -f
	@printf "$(GREEN)Full clean complete.$(RESET)\n"
