# API NestJS + Prisma. Contexto de build: raíz del repositorio.
FROM node:24-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.17.0
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@clipmaster/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @clipmaster/shared build && pnpm --filter @clipmaster/api build

# La imagen final conserva la CLI de Prisma (dependencia de desarrollo) porque
# `prisma migrate deploy` se ejecuta al arrancar para aplicar migraciones pendientes.
FROM base AS run
ENV NODE_ENV=production PORT=4000 UPLOAD_TMP_DIR=/data/uploads
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
