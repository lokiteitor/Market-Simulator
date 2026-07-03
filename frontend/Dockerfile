# =============================================================================
# Frontend — Mercado Agrícola. Build multi-stage:
#   1) oven/bun:1     → bun install + bun run build (tsc --noEmit && vite build)
#   2) nginx:alpine   → sirve dist/ con SPA fallback, gzip y cache de assets.
#
# La base URL de la API se fija en tiempo de build (Vite la inlinea):
#   docker build --build-arg VITE_API_BASE_URL=http://localhost:9080/v1 .
# =============================================================================

FROM oven/bun:1 AS build
WORKDIR /app

# Dependencias primero para aprovechar la cache de capas.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Código fuente (tsconfig incluye src/, tests/ y vite.config.ts).
COPY . .

ARG VITE_API_BASE_URL=http://localhost:9080/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN bun run build

FROM nginx:alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
