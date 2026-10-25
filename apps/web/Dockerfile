# ==============================================================================
# Multi-stage Hardened Dockerfile for GCDIS Public Site (Next.js 14 Standalone)
# Base images pinned by SHA256 digest
# Build context: repository root (see /.dockerignore).
# ==============================================================================

# Stage 1: Dependencies & Build
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/web/package*.json ./apps/web/

# Install scripts are disabled: no dependency may run code at install time (the lockfile pins every
# package by integrity hash; Next.js needs no install script, sharp ships prebuilt optional binaries).
RUN npm ci --ignore-scripts

COPY packages/shared ./packages/shared
# apps/web/tsconfig.json extends the root base config
COPY tsconfig.base.json ./
COPY apps/web ./apps/web

RUN npm run build --prefix packages/shared

WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so they
# must be passed as build args (runtime env on the container has no effect).
ARG NEXT_PUBLIC_API_URL=https://api.gcdis.in/api
ARG NEXT_PUBLIC_WS_URL=wss://api.gcdis.in
ARG NEXT_PUBLIC_SITE_URL=https://www.gcdis.in
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL     NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL     NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build

# Stage 2: Production Minimal Runner (Standalone, non-root)
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN apk add --no-cache curl

# Create non-root node home
USER node

# Copy Next.js standalone server and static assets with correct ownership
COPY --chown=node:node --from=builder /app/apps/web/public ./apps/web/public
COPY --chown=node:node --from=builder /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=builder /app/apps/web/.next/static ./apps/web/.next/static

WORKDIR /app/apps/web

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
