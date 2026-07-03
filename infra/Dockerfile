# Imagen única para core / worker / seed. El comando lo fija docker-compose
# (bun src/server.ts | bun src/worker.ts | bun src/seed.ts); sin CMD fijo aquí.
# Contexto de build: la raíz del repo (ver infra/docker-compose.yml).

FROM oven/bun:1 AS runtime

WORKDIR /app

# bun.lock puede no existir todavía (fase de integración): el glob bun.lock*
# copia el lockfile si está, y el RUN condicional decide el modo de install.
COPY backend/package.json backend/bun.lock* ./
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY infra/seed-config.json ./infra/seed-config.json

ENV NODE_ENV=production
