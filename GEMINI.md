# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

Simulador de mercado agrícola: un **servidor autoritativo único** (backend Bun/TypeScript) con libro de órdenes limit y matching continuo, procesos de transformación por recetas, inventario FIFO por lotes y un **patrón oro** (banco central con ventanilla acuñadora). Los clientes son un enjambre de hasta 10.000 bots heurísticos en Go y una SPA React; todos consumen la misma API REST + WebSocket a través de Caddy (`http://localhost:9080/v1`, WS en `/v1/ws`). El Core (puerto 8000) no se publica al host.

Todo el repo (código, comentarios, docs, commits) está en **español**; mantener ese idioma.

## Comandos

```bash
# Stack completo (postgres, redis, core, worker, caddy, frontend, grafana, prometheus)
make build && make run
make seed              # catálogo + agentes iniciales + banco central + usuario admin (idempotente)
make clean-docker      # destruye contenedores Y volúmenes (reset total de la corrida)

# Bots (corren en el host, no en Docker; requieren Go >= 1.22)
make build-bots
make run-bots          # los 4 bots de bots-v1/config.yaml
make run-swarm         # 10.000 bots con jitter de arranque de 900s
```

Backend (desde `backend/`, requiere Bun >= 1.3; para dev local levantar solo postgres+redis del compose y `cp .env.example .env`):

```bash
bun run dev            # API con reload
bun run worker         # worker BullMQ (otra terminal)
bun run typecheck      # tsc --noEmit estricto
bun run test           # tests unitarios puros, sin DB (bun test tests/unit)
bun test tests/unit/orders            # un directorio
bun test tests/unit/orders/foo.test.ts -t "nombre del test"   # un test
bun run e2e            # suite E2E contra el stack Docker vivo (E2E_BASE_URL, default Caddy)
```

Frontend (desde `frontend/`): `bun run dev`, `bun run typecheck`, `bun run test`, `bun run build`.

## Regla crítica: cambios de esquema y contrato

- **No hay migraciones.** `specs/schema.sql` es el DDL canónico y `backend/src/db/schema.ts` (Drizzle) su espejo: se modifican **juntos en el mismo commit** y el cambio se aplica con `make clean-docker` + re-seed. No generar migraciones de drizzle-kit.
- `specs/openapi.yaml` manda en la API y se mantiene **a mano**: cualquier cambio de endpoint toca schema Zod (`backend/src/schemas/`) + route/controller/service + el OpenAPI en el mismo PR. No hay Swagger UI ni generación desde código.

## Arquitectura del backend (`backend/src/`)

Capas estrictas: `routes` (Fastify + Zod) → `controllers` (mapeo a Problem+JSON RFC 7807) → `services` (toda la lógica de dominio) → `repositories` (Drizzle; reciben la tx como parámetro, nunca la abren). Core (`server.ts`) y Worker (`worker.ts`) son dos entrypoints del mismo código de dominio.

Invariantes que atraviesan todo:

- **Toda mutación** corre en una transacción de Postgres abierta en el Service que valida invariantes, persiste y hace append al `event_log` **antes** del commit. Las notificaciones WS (Redis pub/sub, db 0) se publican solo **post-commit**.
- **Dinero y cantidades son enteros** (`BIGINT`): centavos y centésimas de unidad. Toda aritmética de montos pasa por `lib/money.ts` / `lib/gold.ts` (BigInt con redondeo `floor`, sesgo conservador). La conversión a decimales ocurre solo en los bordes.
- **Matching serializado por producto** en dos capas (ADR-019): un mutex in-process (`lib/locks.ts`, embuda la contención intra-proceso) más un **advisory lock de Postgres transaction-scoped** (`acquireProductAdvisoryLock`, primer lock de la tx) que serializa cluster-wide entre las **N réplicas del Core**. El precio efectivo es el de la orden pasiva.
- **Tiempo simulado**: `SIM_TIME_FACTOR` (5×). Las duraciones de recetas y TTLs se declaran en tiempo simulado pero se persisten como `TIMESTAMPTZ` reales calculados a la creación. Sutileza recurrente: el salario corre en centavos por segundo **real** mientras la duración de la receta está en tiempo **simulado**.
- **Materialización lazy + sweeper**: los procesos vencidos se materializan al leer el estado del agente o por el sweeper del Worker; ambos usan `FOR UPDATE SKIP LOCKED` y son idempotentes.
- **Inventario FIFO por lotes** con trazabilidad de costo (`inventory_lot` + tablas `*_lot_consumption`).

### Patrón oro (sistema monetario)

Ver `docs/patron_oro_sistema_bancario.md`. Lo que hay que saber al tocar dinero:

- Los **fees del matching se acreditan al banco central** (rol `bank`), no se evaporan. Para no crear una fila caliente global bajo N réplicas (ADR-019), el hot path los **anota en `fee_ledger`** (append-only) y un sweeper del Worker (`fee-ledger-sweeper`) los pliega al capital del banco; los lectores del saldo (GET `/bank`, métricas, snapshots, conservación) suman los pendientes de `fee_ledger`.
- El capital semilla de cada registro dinámico se financia con capital del banco + **acuñación respaldada por oro** (`agent-service.ts`); puede fallar con `insufficient_gold_backing`. Materializa primero los fees pendientes para ver el saldo real del banco antes de debitar.
- **Orden global de locks**: `gold_standard FOR UPDATE` siempre antes que cualquier lock de agente. La fila del banco ya **no** la escribe el matching (que ahora solo INSERTA en `fee_ledger`); la escriben el sweeper de fees y la financiación de semilla, ambos bajo `gold_standard`.
- Roles de agente: los 3 de mercado (`transformer` —**único rol productivo**, ADR-022: extrae y transforma—, `consumer`, `trader`) más `admin` (panel, solo-monitoreo) y `bank` (banco central, sin credenciales); estos dos no son registrables ni cuentan en agregados de mercado (`NON_MARKET_ROLES` en `types/contracts.ts`).
- **Yacimientos finitos (ADR-023)**: los 15 recursos geológicos no renovables (`finite: true` en el catálogo) más el oro tienen `resource_deposit` y se agotan. La producción NO rinde el output nominal: rinde `min(floor(planificado × max(DEPOSIT_YIELD_FLOOR_BPS, restante/inicial)), restante)` (`lib/deposits.ts`), así que el coste unitario del lote sube solo al vaciarse el yacimiento y la escasez se traduce en precio sin lógica de precios. Quedan fuera a propósito el **agua** (raíz del grafo: agotarla apaga la economía), la **arena** y todo lo renovable. El tamaño se sortea en EJECUCIONES (`DEPOSIT_MIN/MAX_EXECUTIONS` × el output de su receta), de ahí que un producto finito deba tener **una sola** receta que lo produzca; el oro es la excepción (su tamaño sale de `GOLD_DEPOSIT_*` porque la paridad se deriva de él). Estado vivo en `GET /catalog/deposits` (único `/catalog/*` dinámico, con `yield_bps` calculado) + broadcast `deposit_depleted` al llegar a 0. **Los clientes que valoren recetas deben multiplicar por `yield_bps`** o producen a pérdida (ver `effectiveOutputQtyCent` en `bots-v1/producer.go`).

## Bots (`bots-v1/` + `go-sdk/`)

Ver `docs/funcionamiento_bots.md`. Un binario Go lanza N bots como goroutines; cada bot usa el `engine.Engine` del SDK (`go-sdk/sdk/`): auth con re-login automático (los refresh tokens son de un solo uso), snapshot, WS con reconexión, tick periódico. Las estrategias (`producer.go` + `specialties.go`, `consumer.go`, `trader.go`) devuelven acciones declarativas; nunca llaman a la API directamente. `bots-v1/config.yaml` contiene los precios base de los 155 productos —**generados** con `cd backend && bun src/scripts/generate-catalog-artifacts.ts`, no escritos a mano— y `sim_time_factor`, que **debe coincidir** con el `SIM_TIME_FACTOR` del backend o todos los cálculos de margen quedan sesgados. El directorio `bot-engine/` fue eliminado; no referenciarlo.

## Configuración y seed

- Config por `.env` validada con Zod al boot (`backend/src/config/index.ts`); estática durante la corrida. `backend/.env.example` (dev local) e `infra/.env.docker` (red Docker).
- El catálogo (productos, recetas, `installation_types`) vive en `infra/seed-config.json`; el seed es determinístico a partir de `MASTER_SEED` (capital por rol, yacimiento de oro, paridad).
- El registro dinámico ignora las capacidades solicitadas: asigna todas las del rol según el seed-config.

## Documentación

`docs/` es extensa y se mantiene al día: `diseno_mercado_agricola.md` (reglas de dominio), `arquitectura_mercado_agricola.md` (C4 + ADRs; ADR-017 patrón oro, ADR-018 sin migraciones), `documentacion_base_datos.md` (las 21 tablas), `funcionamiento_bots.md`, `patron_oro_sistema_bancario.md`, `catalogo_productos_recetas.md`. Al cambiar dominio, esquema o API, actualizar el doc correspondiente en el mismo PR.
