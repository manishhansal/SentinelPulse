# =============================================================================
# SentinelPulse — Multi-stage production Dockerfile (task 39.1)
# =============================================================================
#
# Stage 1 (builder): Installs ALL dependencies, compiles TypeScript, and
#   generates the Prisma client.
#
# Stage 2 (runner): Copies only the compiled output and production-only
#   node_modules to keep the final image as small as possible.
#
# Build:
#   docker build -f docker/Dockerfile -t sentinel-pulse:latest .
#
# Run:
#   docker run --env-file .env -p 3000:3000 sentinel-pulse:latest
# =============================================================================

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Add build tools needed by some native addons (e.g. node-gyp).
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy manifests first — allows Docker layer caching to skip npm ci when only
# source files change.
COPY package*.json ./
RUN npm ci

# Copy source + config
COPY tsconfig.json ./
COPY src/ ./src/
COPY prisma/ ./prisma/

# Generate Prisma client (must run after prisma schema is available)
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Create a non-root user for the application process (security best practice)
RUN addgroup --system --gid 1001 sentinel \
 && adduser  --system --uid 1001 --ingroup sentinel sentinel

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# Copy the generated Prisma client (engine binaries live inside node_modules/.prisma)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy Prisma schema (needed for migrate deploy at container start-time)
COPY prisma/ ./prisma/

# Drop to non-root user
USER sentinel

# ── Runtime configuration ─────────────────────────────────────────────────────

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Liveness probe: hit /health and expect HTTP 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e \
    "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))" \
    || exit 1

CMD ["node", "dist/app.js"]
