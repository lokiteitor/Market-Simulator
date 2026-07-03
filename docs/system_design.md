# Diseño de Sistema UI/UX – Interfaz Web del Mercado Agrícola Simulado

> **Propósito:** Este documento proporciona la base estructural, funcional y visual necesaria para que un diseñador UI/UX cree un prototipo Hi-Fi interactivo. Contiene arquitectura de información, flujos clave, mapeo de componentes, restricciones técnicas que impactan la experiencia y lineamientos de diseño.

---

## 1. Visión y Alcance del Producto
- **Qué es:** Interfaz web cliente para operar dentro de una simulación autoritativa de mercado agrícola.
- **Usuario final:** Humanos que actúan como agentes económicos (Productores Primarios, Transformadores, Consumidores, Traders).
- **Principio rector:** El servidor es la única fuente de verdad. La UI es un reflejo reactivo del estado del servidor, envía comandos vía REST y recibe actualizaciones push vía WebSocket.
- **Alcance v1:** No incluye dashboards administrativos, ni gestión de capital del sistema, ni configuración en tiempo real. Solo operaciones de agente y visibilidad de mercado.

---

## 2. Arquitectura de Información (Sitemap)
```
├─ /auth/login
├─ /auth/register
├─ /dashboard (estado completo del agente)
├─ /market/{product_id} (top of book + trades recientes)
├─ /catalog (productos y recetas)
├─ /orders (lista, detalle, colocar)
├─ /transformations (lista, detalle, iniciar)
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
**Feedback:** Mostrar desglose de insumos a consumir y salario a pagar antes de confirmar.

### 4.4 Pantalla de Mercado (`/market/{product_id}`)
**Zonas:**
- **Top of Book:** Dos cards lado a lado → Mejor Bid (compra) y Mejor Ask (venta). Muestra: `order_id` (truncado), `agent_id`, `price`, `qty_pending`.
- **Historial de Trades:** Tabla con columnas: Timestamp, Comprador, Vendedor, Cantidad, Precio, Fees.
- **Filtros:** Ventana de tiempo (`since`), Límite de registros.
**Nota UX:** Las identidades de contrapartes son públicas. Mostrarlas como avatares/nombres truncados con tooltip completo.

### 4.5 Historial (`/history/*`)
**Tabs:** `Trades` | `Órdenes` | `Procesos` | `Eventos`
**Componente:** `InfiniteScroll` o paginación por cursor (`next_cursor`). Filtros avanzados por producto, estado, rango de fechas.
**Event Log:** Tabla técnica pero legible: `Tipo`, `Timestamp`, `Payload` (expandible como JSON formateado).

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
| Mercado | `GET /market/{id}/top`, `GET /market/{id}/trades` | GET | Mejor bid/ask, trades recientes con contrapartes |
| Órdenes | `GET /orders`, `POST /orders`, `DELETE /orders/{id}` | GET/POST/DELETE | Lista filtrada, creación con validación, cancelación idempotente |
| Transformaciones | `GET /transformations`, `POST /transformations`, `DELETE /transformations/{id}` | GET/POST/DELETE | Progreso, insumos consumidos, salario, estado |
| Historial | `GET /history/trades`, `GET /history/events` | GET | Paginación por cursor, filtros por tipo/fecha |
| Notificaciones | WebSocket `/v1/ws` | Unidireccional | `type`, `occurred_at`, `payload` |

**Nota crítica para diseño:** Todos los IDs son `UUIDv7`. Mostrar solo los primeros 8-12 caracteres con opción de "copiar completo". Los timestamps son `TIMESTAMPTZ` reales; la simulación aplica el factor `5×` internamente, pero la UI solo muestra el tiempo real devuelto por la API.
