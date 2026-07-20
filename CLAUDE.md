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

# Ciudades (demanda urbana): conjunto FIJO de ~50 capitales, INSTANCIA ÚNICA (flock).
make build-bots-ciudad
make run-bots-ciudad
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
- Roles de agente: los 4 de mercado (`primary_producer`, `transformer`, `consumer`, `trader`) más `admin` (panel, solo-monitoreo) y `bank` (banco central, sin credenciales); estos dos no son registrables ni cuentan en agregados de mercado (`NON_MARKET_ROLES` en `types/contracts.ts`). Y `city` (ciudad-consumidor): **sembrada con credenciales y NO registrable** por humanos, pero **sí** cuenta como demanda de mercado — por eso está en `SEEDABLE_MARKET_ROLES` y no en `MARKET_ROLES` (que es la lista *registrable*) ni en `NON_MARKET_ROLES`.

### Flujo circular de ingreso (ADR-020)

Las ciudades (`city`) son la demanda final urbana y **reciben ingreso recurrente**, sin lo cual la economía se apaga (antes los consumidores solo gastaban su capital semilla hasta agotarlo). Dos fuentes, ambas reciclando dinero que ya existía:

- **Salario**: `transformation-service.ts` lo debita como siempre pero lo anota **íntegro** en `income_ledger` en vez de destruirlo. Cubre primarios y transformadores (mismo `startTransformation`). **Los salarios ya NO son un sumidero.**
- **Tasa de consumo**: `order-service.ts` divide el fee que los agentes ya pagan entre `fee_ledger` (banco) e `income_ledger` (ciudades) según `CITY_FEE_SHARE_BPS`. Sin cobro extra.

El `city-income-sweeper` del Worker reparte lo pendiente entre las ciudades activas **ponderado por `agent.population_weight`**, con reparto exacto al céntimo (`splitIncomeByWeight`: floor + residuo a la ciudad de mayor peso) y notificación WS `city_income` post-commit. Al tocar dinero, recordar la **nueva** invariante de conservación (sin término de salarios):

```
Σ capital(todos) + fees pendientes + ingreso pendiente − initial_money − money_issued + money_burned == 0
```

Las ciudades están **exentas de quiebra** (cumplirían la condición §8 entre repartos y el login rechaza a los quebrados). La lista canónica de capitales vive en `infra/cities.json`, **fuente única** compartida por el seed del backend y el binario `bots-ciudad`.
- La producción de oro se clampea contra un yacimiento finito (`resource_deposit`).

## Bots (`bots-v1/` + `go-sdk/`)

Ver `docs/funcionamiento_bots.md`. Un binario Go lanza N bots como goroutines; cada bot usa el `engine.Engine` del SDK (`go-sdk/sdk/`): auth con re-login automático (los refresh tokens son de un solo uso), snapshot, WS con reconexión, tick periódico. Las estrategias (`primary_producer.go`, `transformer.go`, `trader.go`) devuelven acciones declarativas; nunca llaman a la API directamente. `bots-v1/config.yaml` contiene los precios base de los 155 productos y `sim_time_factor`, que **debe coincidir** con el `SIM_TIME_FACTOR` del backend o todos los cálculos de margen quedan sesgados. El directorio `bot-engine/` fue eliminado; no referenciarlo.

La estrategia consumidor y los helpers puros (humanización, dinero, market view, precios base) viven en **`go-sdk/sdk/botkit`**, compartidos por `bots-v1` y `bots-ciudad`; `bots-v1/botkit_aliases.go` es solo un shim que los re-exporta con los nombres locales. **Al tocar un helper, editarlo en `botkit`.**

`bots-ciudad/` es el binario de las ciudades: **instancia única** (flock sobre `.bots-ciudad.lock`) y **login-only** (`auto_register: false`) contra las cuentas sembradas. Es instancia única porque sus usernames son literales fijos (las capitales), no derivados de `--runner-id` como en `bots-v1`: dos procesos loguearían las mismas cuentas y se rotarían mutuamente el refresh token de un solo uso. Su `city_password` **debe coincidir** con `CITY_SEED_PASSWORD` del backend.

## Configuración y seed

- Config por `.env` validada con Zod al boot (`backend/src/config/index.ts`); estática durante la corrida. `backend/.env.example` (dev local) e `infra/.env.docker` (red Docker).
- El catálogo (productos, recetas, capacidades por rol) vive en `infra/seed-config.json`; el seed es determinístico a partir de `MASTER_SEED` (capital por rol, yacimiento de oro, paridad).
- El registro dinámico ignora las capacidades solicitadas: asigna todas las del rol según el seed-config.

## Documentación

`docs/` es extensa y se mantiene al día: `diseno_mercado_agricola.md` (reglas de dominio), `arquitectura_mercado_agricola.md` (C4 + ADRs; ADR-017 patrón oro, ADR-018 sin migraciones, ADR-019 matching multiproceso, ADR-020 flujo circular de ingreso), `documentacion_base_datos.md` (las 23 tablas), `funcionamiento_bots.md`, `patron_oro_sistema_bancario.md`, `catalogo_productos_recetas.md`. Al cambiar dominio, esquema o API, actualizar el doc correspondiente en el mismo PR.
