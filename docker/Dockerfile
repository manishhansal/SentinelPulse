# =============================================================================
# SentinelPulse — Multi-stage production Dockerfile
# =============================================================================
#
# Stage 1 (builder): Installs all deps, compiles TypeScript, generates Prisma
#   client with binaryTargets for Alpine (linux-musl-openssl-3.0.x).
#
# Stage 2 (runner): Copies compiled output + prod-only node_modules.
#   Adds openssl3 so the Prisma engine binary can load at runtime.
#   Runs as non-root (sentinel) for the application process.
#   Migration is handled by docker-entrypoint.sh on API startup.
#
# Build:
#   docker build -f docker/Dockerfile -t sentinel-pulse:latest .
#
# Run:
#   docker run --env-file .env.local -p 3001:3001 sentinel-pulse:latest
# =============================================================================

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Build tools for native addons
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY prisma/ ./prisma/

# Generate Prisma client — binaryTargets in schema.prisma includes
# linux-musl-openssl-3.0.x so the correct engine ships in the image
RUN npx prisma generate

RUN npm run build

# ── Stage 2: runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# openssl is required by the Prisma query engine at runtime on Alpine
# (Prisma 5.x uses openssl-3.0.x on linux-musl)
RUN apk add --no-cache openssl

# Non-root user for security
RUN addgroup --system --gid 1001 sentinel \
 && adduser  --system --uid 1001 --ingroup sentinel sentinel

WORKDIR /app

# Production dependencies (includes prisma CLI for migrate deploy)
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled application
COPY --from=builder /app/dist ./dist

# Prisma generated client + engine binaries
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Prisma schema (required by migrate deploy)
COPY prisma/ ./prisma/

# Entrypoint script
COPY docker/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

# node_modules/.prisma is owned by root at this point — the sentinel user
# needs read access to the engine .so files but not write access.
# The prisma generate output is already in node_modules/.prisma from builder.
# We give the sentinel user ownership of the app directory.
RUN chown -R sentinel:sentinel /app

USER sentinel

# ── Runtime ───────────────────────────────────────────────────────────────────

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e \
    "require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1))" \
    || exit 1

# Entrypoint runs migrations (API only) then execs the CMD.
# Workers override CMD via docker-compose command: — migrations are skipped.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
