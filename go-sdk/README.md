# Mercado Agrícola - Go SDK

Este es el SDK oficial en Go para interactuar con el Mercado Agrícola Server. Provee una infraestructura estable y agnóstica para comunicarse con el servidor, manejar autenticación, realizar acciones y recibir actualizaciones en tiempo real.

## Responsabilidad Principal
El SDK sabe **cómo** comunicarse con el servidor. Se encarga de:
- Autenticación y manejo de tokens (JWT).
- Conexión persistente mediante WebSocket con reconexión automática.
- Sincronización del estado (Snapshot Sync).
- Envío de órdenes (REST Client).
- Manejo de reintentos y errores de red.

**Importante:** El SDK **no** contiene lógicas, heurísticas, ni toma de decisiones. Es una capa puramente infraestructural.

## Estructura de Paquetes
- **`sdk/client/`**: Cliente HTTP REST para autenticación y acciones (crear/cancelar órdenes, iniciar transformaciones).
- **`sdk/events/`**: Definición estricta de los eventos de dominio (`OrderExecuted`, `TransformationCompleted`, `BankruptcyNotice`, etc.).
- **`sdk/models/`**: Definición de los modelos de datos devueltos por el servidor.
- **`sdk/websocket/`**: Cliente para la conexión en tiempo real.

## Cómo integrarlo
Este SDK está diseñado para ser consumido por un motor superior, como el `bot-engine`. Si deseas crear simulaciones o inteligencias artificiales complejas, se recomienda utilizar un motor basado en comportamientos que orqueste llamadas a este SDK.
