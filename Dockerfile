# syntax=docker/dockerfile:1.7

# ── Stage 1: build ──
FROM node:24.21.0-alpine AS build
WORKDIR /app

# Toolchain for any native deps pulled in by transitive packages (e.g. swc).
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Prune dev deps for the runtime layer.
RUN npm prune --omit=dev

# ── Stage 2: runtime ──
FROM node:24.21.0-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -S app -g 1001 \
 && adduser  -S app -G app -u 1001

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app

EXPOSE 5002 8082

# /health pings MongoDB via the Mongoose connection. busybox wget ships with
# alpine, so no extra package is needed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HTTP_PORT:-8082}/health" || exit 1

# exec form so Node is PID 1 and receives SIGTERM directly for graceful shutdown.
CMD ["node", "dist/main.js"]
