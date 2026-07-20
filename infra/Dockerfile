# Imagen única para core / worker / seed. El comando lo fija docker-compose
# (bun src/server.ts | bun src/worker.ts | bun src/seed.ts); sin CMD fijo aquí.
# Contexto de build: la raíz del repo (ver infra/docker-compose.yml).

FROM oven/bun:1 AS runtime

WORKDIR /app

# Copiar dependencias pre-instaladas del host y archivos del backend
COPY backend/node_modules ./node_modules
COPY backend/package.json backend/tsconfig.json ./
COPY backend/src ./src
COPY infra/seed-config.json ./infra/seed-config.json
# Lista canónica de ciudades-consumidor (rol `city`) que siembra src/seed.ts.
# Sin esto el seed falla con ENOENT en CITY_CONFIG_PATH.
COPY infra/cities.json ./infra/cities.json

ENV NODE_ENV=production
