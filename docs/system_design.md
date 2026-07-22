# Diseño de Sistema UI/UX – Interfaz Web del Mercado Agrícola Simulado

> **Propósito:** Este documento proporciona la base estructural, funcional y visual necesaria para que un diseñador UI/UX cree un prototipo Hi-Fi interactivo. Contiene arquitectura de información, flujos clave, mapeo de componentes, restricciones técnicas que impactan la experiencia y lineamientos de diseño.

---

## 1. Visión y Alcance del Producto
- **Qué es:** Interfaz web cliente para operar dentro de una simulación autoritativa de mercado agrícola.
- **Usuario final:** Humanos que actúan como agentes económicos (Productores Primarios, Transformadores, Consumidores, Traders).
- **Principio rector:** El servidor es la única fuente de verdad. La UI es un reflejo reactivo del estado del servidor, envía comandos vía REST y recibe actualizaciones push vía WebSocket.
- **Alcance v1:** Operaciones de agente y visibilidad de mercado. **Actualización 2026-07:** el frontend incluye además un **panel de administración** para el operador (`frontend/src/pages/admin`, usuario creado por `seed-admin`), fuera del alcance original de este documento, la pantalla de **instalaciones** (`/installations`, ADR-021) y la del **banco central** (`/bank`, §4.6): la ventanilla de convertibilidad (`GET /bank`, `POST /bank/convert`) ya tiene UI de agente. Las **ciudades** (rol `city`, ADR-020) y el propio agente banco no tienen UI propia — los operan bots/sweepers — pero la UI las etiqueta correctamente (badge "Ciudad", toast de ingreso urbano) por si un humano entra con sus credenciales. La **energía** (ADR-024) no requiere pantalla: la electricidad, el tipo de instalación `generacion` y sus recetas emergen del catálogo en las pantallas existentes.

---

## 2. Arquitectura de Información (Sitemap)
```
├─ /auth/login
├─ /auth/register
├─ /dashboard (estado completo del agente)
├─ /market/{product_id} (top of book + trades recientes)
├─ /catalog (productos, yacimientos y recetas)
├─ /orders (lista, detalle, colocar)
├─ /transformations (lista, detalle, iniciar)
├─ /installations (comprar/mejorar instalaciones, ADR-021)
├─ /bank (banco central: política monetaria + ventanilla de convertibilidad)
├─ /history (trades, órdenes, procesos, eventos)
└─ /profile (logout, credenciales, estado público)
```
**Navegación recomendada:** Barra lateral izquierda con iconos + texto. Header superior con selector de perfil, estado del agente y centro de notificaciones.

---

## 3. Flujos de Usuario Críticos
| Flujo | Descripción | Pantallas Involucradas |
|-------|-------------|------------------------|
| **Registro/Login** | Crear agente o autenticar. Asignación de rol y capacidades iniciales. | `/auth/register`, `/auth/login` |
| **Reconexión Silenciosa** | Si hay caída de red/WS, UI revalida token, llama `GET /agents/me` y restaura estado sin interrumpir. | Todas |
| **Colocar Orden** | Seleccionar producto → lado → cantidad → precio límite → TTL → validar → enviar → recibir confirmación + trades generados. | `/orders`, Modal/Formulario |
| **Iniciar Transformación** | Seleccionar receta → definir ejecuciones → validar capacidad/inventario/capital → confirmar → ver progreso. | `/transformations`, Modal/Formulario |
| **Notificación en Tiempo Real** | WS push → Toast → click lleva a contexto relevante (ej. orden ejecutada → detalle orden). | Global |
| **Consulta de Mercado** | Elegir producto → ver mejor bid/ask con identidades → revisar trades recientes → filtrar por tiempo. | `/market/{id}` |

---

## 4. Estructura de Pantallas y Componentes Clave

### 4.1 Dashboard (`/agents/me`)
**Propósito:** Vista central de operación. Equivalente a `get_self_state`.
**Layout:**
- **Header:** Nombre de agente, rol (badge de color), estado (`active`/`bankrupt`), capital disponible y reservado.
- **Grid de KPIs:** 4 cards → Capital, Inventario total (agregado), Órdenes activas, Procesos en curso.
- **Paneles inferiores (tabs o acordeón):**
  - Inventario por producto (tabla: producto, disponible, reservado)
  - Órdenes activas/parciales (tabla: producto, lado, precio, pendiente, TTL, acciones)
  - Procesos en curso (tabla: receta, ejecución X/Y, tiempo restante, salario pagado)
**Componentes clave:** `StatCard`, `DataTable` (ordenable, filtrable), `Badge`, `ProgressBar` (para procesos), `ActionButton`.

### 4.2 Formulario de Órdenes (`POST /orders`)
**Campos:**
- Producto (dropdown con búsqueda)
- Lado (toggle `Compra` / `Venta`)
- Cantidad (input numérico con formato decimal; internamente se envía en centésimas)
- Precio Límite (input monetario con formato decimal; internamente centavos)
- TTL (selector: `1 min`, `1 h`, `6 h`, `1 día`, `1 semana` simulados)
- `client_order_id` (opcional, campo texto para idempotencia)
**Validación UI:** 
- Capital mínimo requerido = `qty × limit_price` (solo compras)
- Inventario suficiente (solo ventas)
- TTL dentro de `[60, 604800]` segundos simulados
**Estado post-envío:** Spinner → Toast éxito/error → Actualización de tabla de órdenes.

### 4.3 Formulario de Transformación (`POST /transformations`)
**Campos:**
- Receta (dropdown; muestra producto resultante, duración, salario)
- Ejecuciones planificadas (`1` a `N`)
**Validación UI:**
- Capacidad instalada disponible (`installations - running > 0`)
- Insumos suficientes × ejecuciones
- Capital ≥ salario total upfront
- Yacimiento no agotado (ADR-023): si el producto de salida es finito y su `yield_bps` es 0, se bloquea el envío (preempción del 422 `resource_depleted`)
**Feedback:** Mostrar desglose de insumos a consumir y salario a pagar antes de confirmar. Si el producto de salida tiene yacimiento (`GET /catalog/deposits`), el preview muestra la **salida efectiva** (nominal × `yield_bps`, cota superior), el rendimiento y el remanente, con un aviso de recurso no renovable: valorar con la salida nominal sobreestima la producción.

### 4.4 Pantalla de Mercado (`/market/{product_id}`)
**Zonas:**
- **Top of Book:** Dos cards lado a lado → Mejor Bid (compra) y Mejor Ask (venta). Muestra: `order_id` (truncado), `agent_id`, `price`, `qty_pending`.
- **Historial de Trades:** Tabla con columnas: Timestamp, Comprador, Vendedor, Cantidad, Precio, Fees.
- **Filtros:** Ventana de tiempo (`since`), Límite de registros.
**Nota UX:** Las identidades de contrapartes son públicas. Mostrarlas como avatares/nombres truncados con tooltip completo.

### 4.5 Historial (`/history/*`)
**Tabs:** `Trades` | `Órdenes` | `Procesos` | `Eventos`
**Componente:** `InfiniteScroll` o paginación por cursor (`next_cursor`). Filtros avanzados por producto, estado, rango de fechas.
**Event Log:** Tabla técnica pero legible: `Tipo`, `Timestamp`, `Payload` (expandible como JSON formateado). Cubre también los tipos `gold_converted`, `money_issued`, `deposit_depleted`, `city_income_distributed` e `installation_purchased`.

### 4.6 Banco central (`/bank`)
**Propósito:** Transparencia de la política monetaria (patrón oro) y operación de la ventanilla de convertibilidad.
**Zonas:**
- **Política monetaria:** Grid de `StatCard` con paridad, precios de ventanilla (bid = el banco compra oro/acuña; ask = el banco vende oro/destruye), cobertura (`coverage_ratio_bps`), dinero emitido/destruido, capacidad de emisión, oro y capital del banco y yacimiento de oro restante. Refetch cada 5 s (las conversiones ajenas no se difunden por WS).
- **Ventanilla:** posición propia (oro en inventario + capital) y formulario de conversión: dirección (radio `sell_gold`/`buy_gold` con el precio de cada una), cantidad y preview del total (`floor(qty × precio / 100)`, sin fees). Validación client-side espejo de los 422 (`insufficient_capital`, `insufficient_inventory`, `bank_insufficient_gold`, `conversion_below_minimum`); deshabilitado para agentes quebrados y roles `admin`/`bank` (403).
**Estado degradado:** `GET /bank` con 409 `no_gold_standard` → EmptyState "Sin patrón oro" (la entrada del menú es fija).

### 4.7 Catálogo: yacimientos (`/catalog`, ADR-023)
Sección dinámica entre productos y recetas (`GET /catalog/deposits`, refetch 5 s — la excepción al catálogo estático): tabla con remanente/inicial (`ProgressBar`), rendimiento (`yield_bps` como %) y estado (Activo/Agotado). La tabla de productos añade el chip `Finito`/`Agotado`, y la pantalla de mercado muestra el mismo contexto en el detalle del producto.

---

## 5. Lineamientos de Diseño y Sistema Visual

| Aspecto | Recomendación |
|---------|---------------|
| **Tipografía** | Sans-serif para UI (Inter, Roboto, o similar). Monoespaciada para datos numéricos, IDs y timestamps (JetBrains Mono, SF Mono). |
| **Paleta** | Fondo claro/oscuro según preferencia. Colores semánticos: `active` (verde), `partial` (amarillo), `completed` (azul), `cancelled`/`expired` (gris), `bankrupt` (rojo). Roles: Productor (verde tierra), Transformador (naranja), Consumidor (azul), Trader (púrpura). |
| **Formato Numérico** | **NUNCA mostrar enteros crudos.** La API usa `BIGINT` en centésimas y centavos. UI debe formatear: `valor / 100` con 2 decimales. Ej: `1500` → `15.00 kg`, `25000` → `$250.00`. |
| **Tiempo** | Mostrar timestamps en hora local del usuario. Indicar claramente cuando un valor proviene de tiempo simulado (ej. tooltip: `TTL: 2h simuladas (5× tiempo real)`). |
| **Componentes** | `DataTable` con sticky header, sorting, y row actions. `Toast` para WS notifications. `Modal` para formularios críticos. `Skeleton` para carga inicial. `Tooltip` para UUIDs y payloads JSON. |
| **Accesibilidad** | WCAG 2.1 AA. Contraste mínimo 4.5:1. Navegación por teclado. Labels explícitos en formularios. Estados de foco visibles. |

---

## 6. Comportamiento en Tiempo Real y Estados

| Evento | Origen | Comportamiento UI |
|--------|--------|-------------------|
| `order_executed` | WS | Toast + actualización de fila en tabla de órdenes. Si es total, mover a pestaña "Completadas". |
| `order_expired` / `order_cancelled` | WS | Toast + cambio de estado visual (badge gris/rojo). Liberar visualmente reservas si aplica. |
| `transformation_completed` | WS | Toast + actualización de inventario. Marcar proceso como `completed` y mostrar lote producido. |
| `agent_joined` / `agent_bankrupt` | WS | Toast global (no intrusivo). Actualizar listados públicos si están visibles. |
| `gold_converted` | WS | Toast de conversión propia + invalidar `self`, `history` y `bank`. |
| `installation_purchased` | WS | Sin toast (la pestaña compradora ya emite el suyo); invalida `self` para sincronizar otras pestañas. |
| `deposit_depleted` | WS (broadcast) | Toast de aviso "Yacimiento agotado" (con nombre del producto si el catálogo está en caché) + invalidar `["catalog","deposits"]` e historial. |
| `city_income` | WS (solo rol `city`) | Toast "Ingreso urbano" con el importe + invalidar `self` e historial. |
| Pérdida de conexión WS | Cliente | Indicador visual "Conexión en modo offline". Reintentar backoff exponencial. Al reconectar, llamar `GET /agents/me` y resincronizar estado sin recargar página. |
| Error 422 (dominio) | REST | Mostrar `errors[].message` en línea con el campo correspondiente. Destacar campos inválidos. |
| Error 401/403 | REST | Redirigir a login o mostrar modal de sesión expirada/agente quebrado. Bloquear acciones de escritura si `bankrupt`. |

---

## 7. Mapeo API ↔ UI (Para el Diseñador)

| Pantalla / Componente | Endpoint Principal | Método | Datos Clave a Mostrar |
|-----------------------|-------------------|--------|------------------------|
| Login/Registro | `/auth/login`, `/auth/register` | POST | Token pair, estado inicial del agente |
| Dashboard | `GET /agents/me` | GET | Capital, inventario, órdenes activas, procesos, capacidades |
| Catálogo | `GET /catalog/products`, `GET /catalog/recipes` | GET | Lista de productos/recetas, insumos, duración, salario |
| Catálogo (yacimientos) | `GET /catalog/deposits` | GET | Remanente/inicial, `yield_bps`; dinámico (refetch 5 s), también usado por transformaciones, mercado y admin |
| Instalaciones | `GET /catalog/installation-types`, `GET/POST /agents/me/installations` | GET/POST | Tipos comprables, nivel/huecos, precio de la siguiente mejora |
| Banco | `GET /bank`, `POST /bank/convert` | GET/POST | Paridad, ventanilla bid/ask, cobertura, emisión, conversión dinero↔oro |
| Mercado | `GET /market/{id}/top`, `GET /market/{id}/trades` | GET | Mejor bid/ask, trades recientes con contrapartes |
| Órdenes | `GET /orders`, `POST /orders`, `DELETE /orders/{id}` | GET/POST/DELETE | Lista filtrada, creación con validación, cancelación idempotente |
| Transformaciones | `GET /transformations`, `POST /transformations`, `DELETE /transformations/{id}` | GET/POST/DELETE | Progreso, insumos consumidos, salario, estado |
| Historial | `GET /history/trades`, `GET /history/events` | GET | Paginación por cursor, filtros por tipo/fecha |
| Notificaciones | WebSocket `/v1/ws` | Unidireccional | `type`, `occurred_at`, `payload` |

**Nota crítica para diseño:** Todos los IDs son `UUIDv7`. Mostrar solo los primeros 8-12 caracteres con opción de "copiar completo". Los timestamps son `TIMESTAMPTZ` reales; la simulación aplica el factor `5×` internamente, pero la UI solo muestra el tiempo real devuelto por la API.
