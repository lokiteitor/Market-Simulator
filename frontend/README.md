# Frontend — Mercado Agrícola

Interfaz web (SPA) para participantes humanos de la **Simulación de Mercado Agrícola**.
UX definida en [`docs/system_design.md`](../docs/system_design.md); consume la misma API que los
agentes automatizados (contrato en [`specs/openapi.yaml`](../specs/openapi.yaml)) a través de
Caddy: REST en `http://localhost:9080/v1` y WebSocket de notificaciones en
`ws://localhost:9080/v1/ws?token=<access>` (la URL del WS se deriva de la base REST).

**Stack:** Vite + React 19 + TypeScript strict, react-router v7 (declarativo),
@tanstack/react-query v5, CSS plano con custom properties + CSS Modules (sin Tailwind ni UI kits).

Pantallas: `/auth` (login/registro) · `/dashboard` · `/market[/:productId]` · `/catalog` ·
`/orders` · `/transformations` · `/installations` · `/history` · `/profile`.

## Desarrollo

Requisitos: [bun](https://bun.sh) ≥ 1.1 y el stack backend levantado
(`cd ../infra && docker compose up -d --build`, más el seed del catálogo la primera vez:
`docker compose --profile seed run --rm seed`).

```sh
bun install
cp .env.example .env        # opcional: ajustar VITE_API_BASE_URL
bun run dev                 # http://localhost:5173
```

Variables de entorno (Vite las inlinea en build/dev):

| Variable            | Default                    | Uso                                            |
|---------------------|----------------------------|------------------------------------------------|
| `VITE_API_BASE_URL` | `http://localhost:9080/v1` | Base REST; el WS deriva de ella (`…/v1/ws`).   |

Comandos útiles:

```sh
bun run typecheck   # tsc --noEmit (strict + noUncheckedIndexedAccess)
bun test tests/unit # tests de lógica pura (format, validaciones, simTime)
bun run build       # typecheck + vite build → dist/
bun run preview     # sirve dist/ localmente
```

## Build y despliegue en Docker Compose

`Dockerfile` multi-stage: `oven/bun:1` (install + build, con `ARG VITE_API_BASE_URL`, default
`http://localhost:9080/v1`) → `nginx:alpine` sirviendo `dist/` con `nginx.conf`
(SPA fallback a `index.html`, gzip y cache inmutable de `/assets/`).

El servicio `frontend` está declarado en [`infra/docker-compose.yml`](../infra/docker-compose.yml)
(context `../frontend`, puerto `${FRONTEND_PORT:-8090}:80`, `depends_on: caddy`, red `market`):

```sh
cd ../infra
docker compose up -d --build frontend
# ¿8090 ocupado? usa otro puerto de host:
FRONTEND_PORT=8091 docker compose up -d frontend
```

La app queda en **http://localhost:8090** (la API sigue siendo `http://localhost:9080/v1`
desde el navegador, vía Caddy). El puerto de host es configurable con `FRONTEND_PORT` (default 8090,
elegido para no chocar con el 8080, habitualmente ocupado). Si la API se expone en otra URL,
reconstruir con `docker compose build --build-arg VITE_API_BASE_URL=<url> frontend`.

## Credenciales de agentes seed (para probar login)

El seed (`docker compose --profile seed run --rm seed`) crea agentes con username `{role}_{i}`
(i desde 1) y contraseña común tomada de `SEED_AGENT_PASSWORD` en
[`infra/.env.docker`](../infra/.env.docker) (valor de desarrollo: `dev-password-123`):

| Rol                | Usernames                                                    |
|--------------------|--------------------------------------------------------------|
| `primary_producer` | `primary_producer_1`, `primary_producer_2`, `primary_producer_3` |
| `transformer`      | `transformer_1`, `transformer_2`, `transformer_3`            |
| `consumer`         | `consumer_1`, `consumer_2`                                   |
| `trader`           | `trader_1`, `trader_2`                                       |

También puede registrarse un agente nuevo desde la pestaña **Registro** de `/auth`.

## Reglas de presentación (vinculantes)

- **Nunca** mostrar enteros crudos de la API: `qty_cent` y `*_cents` se dividen entre 100 con
  2 decimales (helpers de `src/lib/format.ts`; dinero con `$`, cantidades con la `unit` del producto).
- IDs UUIDv7 truncados a 8 caracteres con botón de copiado (`CopyId`).
- Errores RFC 7807: en 422, `errors[]` se mapea junto al campo correspondiente; 401 dispara un
  refresh silencioso (y redirect a `/auth` si falla); 403 `agent_bankrupt` muestra banner
  permanente y deshabilita formularios de escritura.
- WS con backoff exponencial (1s→30s) y resincronización (invalidación de queries) al reconectar.
