#!/usr/bin/env bash
# =============================================================================
# SentinelPulse — Auto-Rebuild & Redeploy Script
#
# Usage:
#   ./deploy.sh [OPTIONS]
#
# Options:
#   --env-file <path>   Path to env file (default: .env.local)
#   --branch  <name>    Expected branch (aborts if current branch differs)
#   --no-pull           Skip git pull (useful when called from a git hook)
#   --rollback          Roll back to the previous image tag
#   --dry-run           Print what would run without executing
#
# Exit codes:
#   0 — success
#   1 — build / deploy failure (previous containers stay running)
#   2 — health-check failure (rollback attempted automatically)
#
# What this script does on every invocation:
#   1. Optionally pulls the latest code from origin
#   2. Tags the currently running images as "<service>:rollback" (safety net)
#   3. Builds fresh Docker images via docker compose build
#   4. Brings the new containers up with a rolling restart (--no-deps per service
#      on the API so workers keep processing during the swap)
#   5. Waits for the API health-check to pass
#   6. If the health-check fails, automatically rolls back to :rollback images
#   7. Prunes dangling images to reclaim disk space
#
# Secrets / env:
#   All runtime config is read from the --env-file (default .env.local).
#   Never commit that file. In CI/CD pipelines inject it via secrets.
#
# =============================================================================
set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"

log()     { echo -e "${CYAN}[deploy]${RESET} $*"; }
success() { echo -e "${GREEN}[deploy] ✓ $*${RESET}"; }
warn()    { echo -e "${YELLOW}[deploy] ⚠ $*${RESET}"; }
error()   { echo -e "${RED}[deploy] ✗ $*${RESET}" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}══════════════════════════════════════════${RESET}"; echo -e "${BOLD}${CYAN}  $*${RESET}"; echo -e "${BOLD}${CYAN}══════════════════════════════════════════${RESET}\n"; }

run() {
  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    echo -e "${YELLOW}[dry-run]${RESET} $*"
  else
    "$@"
  fi
}

# ── Defaults ─────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.local"
COMPOSE_FILE="${SCRIPT_DIR}/docker/docker-compose.yml"
EXPECTED_BRANCH=""
SKIP_PULL=false
ROLLBACK_MODE=false
DRY_RUN=false

# Health-check settings
HEALTH_URL="http://localhost:3001/health"
HEALTH_MAX_RETRIES=30    # 30 × 5 s = 150 s max wait
HEALTH_RETRY_INTERVAL=5  # seconds between retries

# ── Parse arguments ───────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)  ENV_FILE="$2";         shift 2 ;;
    --branch)    EXPECTED_BRANCH="$2";  shift 2 ;;
    --no-pull)   SKIP_PULL=true;        shift   ;;
    --rollback)  ROLLBACK_MODE=true;    shift   ;;
    --dry-run)   DRY_RUN=true;          shift   ;;
    *)
      error "Unknown option: $1"
      echo "Usage: $0 [--env-file FILE] [--branch NAME] [--no-pull] [--rollback] [--dry-run]"
      exit 1
      ;;
  esac
done

# ── Compose shorthand ─────────────────────────────────────────────────────────

DC="docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE}"

# ── Validate environment ──────────────────────────────────────────────────────

header "SentinelPulse — Auto Redeploy"

log "Script dir : ${SCRIPT_DIR}"
log "Env file   : ${ENV_FILE}"
log "Compose    : ${COMPOSE_FILE}"
[[ "${DRY_RUN}" == "true" ]] && warn "DRY RUN — no changes will be made"

if [[ ! -f "${ENV_FILE}" ]]; then
  error "Env file not found: ${ENV_FILE}"
  error "Copy .env.example → ${ENV_FILE} and fill in real values."
  exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  error "docker-compose.yml not found: ${COMPOSE_FILE}"
  exit 1
fi

# Check docker is available
if ! command -v docker &>/dev/null; then
  error "'docker' not found in PATH. Install Docker Engine first."
  exit 1
fi

# ── Branch guard ─────────────────────────────────────────────────────────────

if [[ -n "${EXPECTED_BRANCH}" ]]; then
  CURRENT_BRANCH="$(git -C "${SCRIPT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
  if [[ "${CURRENT_BRANCH}" != "${EXPECTED_BRANCH}" ]]; then
    warn "Current branch is '${CURRENT_BRANCH}', expected '${EXPECTED_BRANCH}'. Skipping deploy."
    exit 0
  fi
  log "Branch check passed: ${CURRENT_BRANCH}"
fi

# ── Rollback mode ─────────────────────────────────────────────────────────────

if [[ "${ROLLBACK_MODE}" == "true" ]]; then
  header "Rolling Back to Previous Images"

  # All app services built from Dockerfile share the same compose-managed image.
  # Rollback by re-tagging :rollback → :latest then restarting.
  SERVICES="api scheduler worker-normalize worker-dedup worker-entity worker-event worker-sentiment worker-impact worker-feature worker-embed cron-velocity cron-breadth cron-regime"

  PROJECT_NAME="sentinel-pulse"
  for svc in $SERVICES; do
    IMAGE="${PROJECT_NAME}-${svc}"
    if docker image inspect "${IMAGE}:rollback" &>/dev/null; then
      log "Restoring ${IMAGE}:rollback → ${IMAGE}:latest"
      run docker tag "${IMAGE}:rollback" "${IMAGE}:latest"
    else
      warn "No rollback image found for ${IMAGE}, skipping."
    fi
  done

  log "Restarting services with rollback images..."
  run ${DC} up -d --no-build
  success "Rollback complete."
  exit 0
fi

# ── Step 1: Pull latest code ──────────────────────────────────────────────────

if [[ "${SKIP_PULL}" == "false" ]]; then
  header "Step 1/5 — Pulling latest code"
  CURRENT_SHA="$(git -C "${SCRIPT_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
  log "Current commit: ${CURRENT_SHA}"
  run git -C "${SCRIPT_DIR}" pull --ff-only origin "$(git -C "${SCRIPT_DIR}" rev-parse --abbrev-ref HEAD)"
  NEW_SHA="$(git -C "${SCRIPT_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
  log "After pull   : ${NEW_SHA}"
  if [[ "${CURRENT_SHA}" == "${NEW_SHA}" ]]; then
    warn "No new commits since last deploy (${CURRENT_SHA}). Continuing anyway."
  fi
else
  header "Step 1/5 — Skipping git pull (--no-pull)"
  log "Using working tree as-is."
fi

# ── Step 2: Tag running images as :rollback ───────────────────────────────────

header "Step 2/5 — Tagging current images as :rollback"

APP_SERVICES="api scheduler worker-normalize worker-dedup worker-entity worker-event worker-sentiment worker-impact worker-feature worker-embed cron-velocity cron-breadth cron-regime scrapling"
PROJECT_NAME="sentinel-pulse"
ROLLBACK_AVAILABLE=false

for svc in $APP_SERVICES; do
  # Compose-built images are named <project>-<service>
  IMAGE="${PROJECT_NAME}-${svc}"
  if docker image inspect "${IMAGE}:latest" &>/dev/null 2>&1; then
    run docker tag "${IMAGE}:latest" "${IMAGE}:rollback"
    log "Tagged ${IMAGE}:latest → ${IMAGE}:rollback"
    ROLLBACK_AVAILABLE=true
  else
    warn "No existing image for ${IMAGE}, nothing to tag for rollback."
  fi
done

if [[ "${ROLLBACK_AVAILABLE}" == "true" ]]; then
  success "Rollback snapshots saved."
else
  warn "No existing images found. This appears to be a fresh deployment."
fi

# ── Step 3: Build new images ──────────────────────────────────────────────────

header "Step 3/5 — Building Docker images"
log "Running: docker compose build (no cache for clean builds)"

BUILD_START=$(date +%s)
# --pull ensures base images are refreshed; drop it if you want faster builds
run ${DC} build --pull
BUILD_END=$(date +%s)
success "Build complete in $(( BUILD_END - BUILD_START ))s"

# ── Step 4: Rolling restart ───────────────────────────────────────────────────

header "Step 4/5 — Deploying new containers"

# Restart non-API services first (workers, crons, scheduler, scrapling).
# They don't serve external traffic so there is no user-facing downtime.
NON_API_SERVICES="scrapling scheduler worker-normalize worker-dedup worker-entity worker-event worker-sentiment worker-impact worker-feature worker-embed cron-velocity cron-breadth cron-regime"

log "Restarting background services..."
run ${DC} up -d --no-deps --remove-orphans ${NON_API_SERVICES}

# Then restart the API — entrypoint.sh runs prisma migrate deploy before
# the server starts, so migrations run automatically during this step.
log "Restarting API service (migrations will run via entrypoint)..."
run ${DC} up -d --no-deps api

success "All containers started."

# ── Step 5: Health check ──────────────────────────────────────────────────────

header "Step 5/5 — Waiting for API health check"

log "Polling ${HEALTH_URL} (max ${HEALTH_MAX_RETRIES} attempts × ${HEALTH_RETRY_INTERVAL}s)"

ATTEMPT=0
HEALTHY=false

while [[ ${ATTEMPT} -lt ${HEALTH_MAX_RETRIES} ]]; do
  ATTEMPT=$(( ATTEMPT + 1 ))

  if [[ "${DRY_RUN}" == "true" ]]; then
    success "Health check skipped in dry-run mode."
    HEALTHY=true
    break
  fi

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "${HEALTH_URL}" 2>/dev/null || echo "000")

  if [[ "${HTTP_STATUS}" == "200" ]]; then
    HEALTHY=true
    break
  fi

  log "Attempt ${ATTEMPT}/${HEALTH_MAX_RETRIES}: status=${HTTP_STATUS}, waiting ${HEALTH_RETRY_INTERVAL}s..."
  sleep "${HEALTH_RETRY_INTERVAL}"
done

if [[ "${HEALTHY}" == "true" ]]; then
  success "API is healthy after ${ATTEMPT} attempt(s)."
else
  error "API failed to become healthy after $(( HEALTH_MAX_RETRIES * HEALTH_RETRY_INTERVAL ))s."
  error "Attempting automatic rollback..."

  # Print recent API logs to aid debugging
  echo ""
  warn "=== Recent API logs ==="
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" logs --tail=50 api 2>/dev/null || true
  echo ""

  # Roll back
  ROLLBACK_FAILED=false
  for svc in $APP_SERVICES; do
    IMAGE="${PROJECT_NAME}-${svc}"
    if docker image inspect "${IMAGE}:rollback" &>/dev/null 2>&1; then
      docker tag "${IMAGE}:rollback" "${IMAGE}:latest"
    fi
  done

  ${DC} up -d --no-build --remove-orphans || ROLLBACK_FAILED=true

  if [[ "${ROLLBACK_FAILED}" == "false" ]]; then
    warn "Rolled back to previous images. Investigate the failed build before re-deploying."
  else
    error "Rollback also failed! Manual intervention required."
    error "Run: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs"
  fi

  exit 2
fi

# ── Cleanup: prune dangling images ────────────────────────────────────────────

header "Cleanup — Pruning dangling images"
run docker image prune -f
success "Dangling images removed."

# ── Summary ───────────────────────────────────────────────────────────────────

DEPLOY_SHA="$(git -C "${SCRIPT_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
DEPLOY_TIME="$(date '+%Y-%m-%d %H:%M:%S %Z')"

echo ""
success "════════════════════════════════════════════"
success "  Deployment complete!"
success "  Commit : ${DEPLOY_SHA}"
success "  Time   : ${DEPLOY_TIME}"
success "  API    : ${HEALTH_URL}"
success "════════════════════════════════════════════"
echo ""
