# ==============================================================================
# Multi-stage Hardened Dockerfile for GCDIS Core API (NestJS + Prisma)
# Base images pinned by SHA256 digest
# Build context: repository root (see /.dockerignore - host node_modules/dist/.env
# are excluded so `COPY apps/api` never overlays host artefacts).
#
# Targets:
#   builder  - full toolchain incl. prisma CLI; used by the one-shot `migrate`
#              service in docker-compose.prod.yml (prisma migrate deploy).
#   runner   - default; production-only dependencies, non-root.
# ==============================================================================

# Stage 1: Build Dependencies & Compile TypeScript
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS builder

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache openssl libc6-compat

# Copy workspace package manifests
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json ./apps/api/

# Install dependencies across monorepo (dev deps needed for nest build / prisma CLI). Install scripts are
# disabled so no dependency runs code at install time; the only packages that have one are Prisma's, and
# `prisma generate` below fetches the query engine and generates the client explicitly.
RUN npm ci --ignore-scripts

# Copy source trees
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Compile shared library
RUN npm run build --prefix packages/shared

# Generate Prisma Client & Compile API into dist
WORKDIR /app/apps/api
RUN npx prisma generate
RUN npm run build

# Stage 2: Production-only dependency tree (no dev deps, no install scripts)
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS prod-deps

WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json ./apps/api/

# --ignore-scripts: the @prisma/client postinstall would try to run the (dev-only)
# prisma CLI; the generated client is copied from the builder stage instead.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Stage 3: Production Hardened Minimal Image (Non-root, read-only FS ready)
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV STORAGE_LOCAL_DIR=/app/apps/api/uploads

RUN apk add --no-cache openssl libc6-compat curl

# Create persistent uploads volume with correct node ownership
RUN mkdir -p /app/apps/api/uploads && \
    mkdir -p /app/apps/api/storage && \
    mkdir -p /app/apps/api/dist && \
    chown -R node:node /app

# Non-root user for security compliance
USER node

# Copy production-only dependencies, generated Prisma client and built application
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/packages/shared/package*.json ./packages/shared/
COPY --chown=node:node --from=builder /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --chown=node:node --from=builder /app/apps/api/package*.json ./apps/api/

WORKDIR /app/apps/api

VOLUME ["/app/apps/api/uploads", "/app/apps/api/storage"]

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/api/health || exit 1

# Migrations are NOT run here; the `migrate` service applies them before start.
CMD ["node", "dist/main.js"]
