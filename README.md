# Simulación de Mercado Agrícola

Servidor autoritativo de estado que simula un mercado de productos agrícolas con ~100 agentes
concurrentes (productores primarios, transformadores, consumidores finales y traders). El servidor
es la única fuente de verdad sobre capital, inventarios, órdenes limit con matching continuo,
procesos de transformación (recetas) e historial. Los agentes son clientes externos (reglas simples,
modelos de ML o humanos) que consumen la misma API HTTP/WebSocket.

## Estructura del repositorio

Monorepo de carpetas planas (sin workspaces):

| Carpeta     | Contenido                                                                     |
| ----------- | ----------------------------------------------------------------------------- |
| `backend/`  | App Bun autocontenida: Core (Fastify), Worker (BullMQ), seed y tests           |
| `frontend/` | UI web para participantes humanos ([docs/system_design.md](docs/system_design.md)) |
| `docs/`     | Documentación: diseño conceptual, arquitectura (C4/ADRs), base de datos, UI    |
| `specs/`    | Contratos canónicos: [`openapi.yaml`](specs/openapi.yaml) (manda en la API) y [`schema.sql`](specs/schema.sql) (manda en la DB) |
| `infra/`    | Docker Compose, Dockerfile, APISIX, Prometheus, Grafana, seed-config           |

## Stack

| Capa          | Tecnología                                                        |
| ------------- | ----------------------------------------------------------------- |
| Runtime       | Bun (>= 1.3), TypeScript strict, ESM                              |
| HTTP/WS       | Fastify v5 + `@fastify/websocket` + `@fastify/jwt` (HS256)        |
| Validación    | Zod v4 + `fastify-type-provider-zod`                              |
| Base de datos | PostgreSQL 18 vía `postgres` (postgres.js) + Drizzle ORM          |
| Cache/PubSub  | Redis (ioredis) — pub/sub de notificaciones e idempotencia (db 0) |
| Jobs          | BullMQ (Redis db 1) — sweeps de expiración/materialización, snapshots |
| Gateway       | Apache APISIX (rate limiting, CORS, WebSocket passthrough)        |
| Observabilidad| pino (logs), prom-client (métricas), Prometheus + Grafana         |

## Levantar con Docker Compose

Todo el stack se orquesta desde [`infra/docker-compose.yml`](infra/docker-compose.yml):

```bash
# 1. Levantar infraestructura + core + worker + gateway + observabilidad
docker compose -f infra/docker-compose.yml up -d --build

# 2. Poblar catálogo y agentes iniciales (perfil "seed", one-shot e idempotente)
docker compose -f infra/docker-compose.yml --profile seed run --rm seed
```

Puertos publicados:

| Servicio   | URL                     | Notas                                              |
| ---------- | ----------------------- | -------------------------------------------------- |
| APISIX     | `http://localhost:9080` | Entrada única a la API (`/v1/...`, WS en `/v1/ws`) |
| Grafana    | `http://localhost:3000` | admin / admin                                      |
| Prometheus | `http://localhost:9090` | scrape de core (8001) y worker (8002)              |

El Core (puerto 8000) no se publica al host: todo el tráfico de agentes pasa por APISIX.

## Desarrollo local (sin contenedores para la app)

Requiere Bun >= 1.3 y tener Postgres y Redis accesibles (puedes levantar solo esos dos servicios
del compose). Todo se ejecuta desde `backend/`:

```bash
cd backend
bun install
cp .env.example .env        # ajusta si hace falta
bun run seed                # catálogo + agentes iniciales (idempotente)
bun run dev                 # API con reload (src/server.ts)
bun run worker              # worker BullMQ en otra terminal
```

## Scripts (`backend/`)

| Script                | Comando                               | Descripción                              |
| --------------------- | ------------------------------------- | ---------------------------------------- |
| `bun run dev`         | `bun --watch src/server.ts`           | API en modo desarrollo con reload        |
| `bun run start`       | `bun src/server.ts`                   | API                                      |
| `bun run worker`      | `bun src/worker.ts`                   | Worker de jobs (BullMQ)                  |
| `bun run seed`        | `bun src/seed.ts`                     | Seed idempotente (catálogo + agentes)    |
| `bun run snapshot`    | `bun src/scripts/enqueue-snapshot.ts` | Encola un snapshot de mercado on-demand  |
| `bun run typecheck`   | `tsc --noEmit`                        | Typecheck estricto                       |
| `bun run test`        | `bun test tests/unit`                 | Tests unitarios puros (sin DB)           |
| `bun run e2e`         | `bun tests/e2e/run.ts`                | Suite E2E contra APISIX (`E2E_BASE_URL`) |

Configuración por variables de entorno: ver [`backend/.env.example`](backend/.env.example)
(defaults de desarrollo) e [`infra/.env.docker`](infra/.env.docker) (hosts de la red docker).

## Estado

**Implementación en curso.** Fundación (tooling, capa de datos, libs compartidas, infra) completa;
los módulos de dominio del backend y el frontend se están implementando por fases.
