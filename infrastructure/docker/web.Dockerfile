# Frontend Next.js (salida standalone). Contexto de build: raíz del repositorio.
FROM node:24-bookworm-slim AS build
RUN npm install -g pnpm@11.17.0
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@clipmaster/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
# Las reescrituras de Next se fijan en build. En Dokploy Traefik enruta /api directamente a la API,
# así que esta URL sólo se usa como respaldo cuando no hay enrutado por ruta.
ARG API_INTERNAL_URL=http://api:4000
ENV NEXT_TELEMETRY_DISABLED=1 API_INTERNAL_URL=${API_INTERNAL_URL}
RUN pnpm --filter @clipmaster/shared build && pnpm --filter @clipmaster/web build

FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
