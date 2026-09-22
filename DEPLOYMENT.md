# SentinelPulse — Deployment Guide

Every push to `main` or `develop` automatically rebuilds all Docker images and redeploys the full stack. This guide explains the three deployment paths and how to set each one up.

---

## How it works

```
git push origin main
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Option A — GitHub Actions                                           │
│  .github/workflows/deploy.yml  (CI passes → SSH into server →       │
│   git pull → deploy.sh --no-pull)                                    │
├──────────────────────────────────────────────────────────────────────┤
│  Option B — Self-hosted git server (bare repo)                       │
│  .git/hooks/post-receive (installed from scripts/post-receive)       │
│  fires automatically on the server after every push                  │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                         deploy.sh
  1. Tag current images → :rollback   (safety net)
  2. docker compose build --pull      (fresh images)
  3. Restart background services      (workers, crons, scheduler)
  4. Restart API                      (entrypoint runs prisma migrate)
  5. Poll GET /health until 200       (up to 150 s)
  6. On failure → auto-rollback       (restores :rollback images)
  7. Prune dangling images
```

---

## Option A — GitHub Actions (recommended for GitHub-hosted repos)

### 1. Add repository secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Description |
|---|---|
| `DEPLOY_HOST` | IP or hostname of your server, e.g. `192.168.1.100` |
| `DEPLOY_USER` | SSH user on the server, e.g. `ubuntu` |
| `DEPLOY_SSH_KEY` | Full contents of an SSH private key that has access to `DEPLOY_USER@DEPLOY_HOST` |
| `DEPLOY_PATH` | Absolute path to the repo checkout on the server, e.g. `/opt/sentinelpulse` |
| `ENV_FILE_CONTENTS` | Full contents of `.env.local` (see [Environment file](#environment-file)) |
| `SLACK_WEBHOOK_URL` | *(optional)* Slack incoming webhook URL for deploy notifications |

### 2. Add the public key to the server

```bash
# On your local machine — generate a dedicated deploy key
ssh-keygen -t ed25519 -C "sentinelpulse-deploy" -f ~/.ssh/sentinelpulse_deploy -N ""

# Copy the public key to the server
ssh-copy-id -i ~/.ssh/sentinelpulse_deploy.pub ubuntu@your-server

# Paste the contents of ~/.ssh/sentinelpulse_deploy into the DEPLOY_SSH_KEY secret
cat ~/.ssh/sentinelpulse_deploy
```

### 3. Clone the repo on the server

```bash
ssh ubuntu@your-server
git clone https://github.com/your-org/sentinelpulse.git /opt/sentinelpulse
```

### 4. Create the env file on the server

```bash
cp /opt/sentinelpulse/.env.example /opt/sentinelpulse/.env.local
# Edit .env.local and fill in real DATABASE_URL, REDIS_URL, API keys, etc.
nano /opt/sentinelpulse/.env.local
```

### 5. Push to trigger a deploy

```bash
git push origin main    # → production environment
git push origin develop # → staging environment
```

The workflow is at `.github/workflows/deploy.yml`. It runs CI first, then deploys only if tests pass.

---

## Option B — Self-hosted git server (bare repo hook)

Use this if you manage your own git server (Gitea, Forgejo, plain bare repo over SSH, etc.).

### 1. Create a bare repo on the server

```bash
ssh user@git-server
git init --bare /srv/git/sentinelpulse.git
```

### 2. Install the post-receive hook

```bash
# On the git server
cp /path/to/sentinelpulse/scripts/post-receive \
   /srv/git/sentinelpulse.git/hooks/post-receive
chmod +x /srv/git/sentinelpulse.git/hooks/post-receive
```

### 3. Edit the two variables at the top of the hook

```bash
nano /srv/git/sentinelpulse.git/hooks/post-receive
```

```bash
WORK_TREE="/opt/sentinelpulse"   # where the live checkout lives
DEPLOY_BRANCH="main"             # which branch triggers a redeploy
```

### 4. Create the work-tree checkout

```bash
git clone /srv/git/sentinelpulse.git /opt/sentinelpulse
cp /opt/sentinelpulse/.env.example /opt/sentinelpulse/.env.local
# fill in .env.local with real values
```

### 5. Add the bare repo as a remote on your dev machine

```bash
git remote add prod ssh://user@git-server/srv/git/sentinelpulse.git
git push prod main    # triggers auto-deploy
```

---

## Manual deployment (Makefile)

For one-off deploys or when running on the server directly:

```bash
# Full rebuild + redeploy (pulls latest code first)
make deploy

# Rebuild using the current working tree (no git pull)
make deploy-no-pull

# Preview what deploy would do — no changes made
make dry-run

# Roll back to the previous set of images
make rollback

# Useful day-to-day commands
make status         # running containers + health
make logs           # tail all logs
make logs-api       # tail API logs only
make health         # curl /health endpoint
make migrate        # run Prisma migrations manually
make clean          # stop containers + prune dangling images
make help           # full list of targets
```

---

## deploy.sh flags

```
./deploy.sh [OPTIONS]

  --env-file <path>   Env file to use          (default: .env.local)
  --branch  <name>    Abort if not on branch   (optional guard)
  --no-pull           Skip git pull            (used by hooks/CI)
  --rollback          Restore :rollback images
  --dry-run           Print commands, no changes
```

---

## Environment file

All runtime configuration lives in `.env.local`. It is **gitignored** — never commit it.

```bash
# Copy the template and fill in real values
cp .env.example .env.local
```

Minimum required variables:

```bash
DATABASE_URL=postgresql://sentinel:PASSWORD@localhost:5444/sentinel_pulse
REDIS_URL=redis://localhost:6379
SENTINEL_API_KEY=your-api-key
DATA_SERVICE_URL=http://localhost:8200
DATA_SERVICE_API_KEY=your-data-service-key
SCRAPLING_URL=http://scrapling:8001
ML_SERVICE_URL=http://localhost:8100
FEATURE_VERSION=1.0.0
PIPELINE_VERSION=1.0.0
```

See `.env.example` for the full list with descriptions.

---

## Rollback

A rollback snapshot is saved before every deploy. To restore it:

```bash
# Via Makefile
make rollback

# Or directly
./deploy.sh --rollback

# Or manually
docker tag sentinel-pulse-api:rollback sentinel-pulse-api:latest
docker compose -f docker/docker-compose.yml --env-file .env.local up -d --no-build
```

The `:rollback` tag is overwritten on every successful deploy, so only one generation of rollback is kept.

---

## Troubleshooting

**Deploy fails at health check**
```bash
make logs-api          # check for startup errors
make status            # verify all containers started
docker inspect sentinel-pulse-api-1 | grep -A5 Health
```

**Prisma migration errors on startup**
```bash
make migrate           # run migrations manually inside the container
make logs-api          # look for migration error details
```

**Containers can't reach Postgres/Redis**
The compose file connects to external AlphaForge services via `host.docker.internal`. Verify those services are running:
```bash
docker ps | grep -E 'data-service-postgres|alpha-forge-redis'
```

**Out of disk space after many deploys**
```bash
make clean             # prune dangling images + stopped containers
docker system df       # check current usage
```

---

## Architecture overview

```
┌──────────────────────── sentinel-pulse Docker stack ──────────────────────┐
│                                                                            │
│  scrapling (8001)  ←── content extraction sidecar (Python/FastAPI)        │
│                                                                            │
│  api (3001)        ←── Fastify REST API + health endpoint                 │
│  scheduler         ←── ingestion scheduler (triggers source polling)      │
│                                                                            │
│  worker-normalize  ┐                                                       │
│  worker-dedup      │                                                       │
│  worker-entity     │  BullMQ pipeline workers (8 stages)                  │
│  worker-event      │  ← each reads from Redis queue                       │
│  worker-sentiment  │                                                       │
│  worker-impact     │                                                       │
│  worker-feature    │                                                       │
│  worker-embed      ┘                                                       │
│                                                                            │
│  cron-velocity     ┐  Periodic background jobs                            │
│  cron-breadth      │  (run on schedule, not queue-driven)                 │
│  cron-regime       ┘                                                       │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  data-service-postgres          alpha-forge-redis
  (AlphaForge stack,             (AlphaForge stack,
   localhost:5444)                localhost:6379)
```

Postgres and Redis are **not** managed by this compose file — they run as part of the existing AlphaForge stack and must be up before deploying SentinelPulse.
