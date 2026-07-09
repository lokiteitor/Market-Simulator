# Mercado Agrícola - Behavior Engine

El **Behavior Engine** es un simulador/orquestador avanzado para el proyecto Mercado Agrícola. Funciona sobre el `go-sdk` y está diseñado para separar la ejecución e infraestructura de los bots de sus estrategias de decisión.

## Arquitectura

El Behavior Engine divide el sistema en responsabilidades claras:
* **El SDK** sabe *cómo* comunicarse con el servidor.
* **El Runner** sabe *cuándo* y *cómo* instanciar los bots.
* **El Behavior** sabe *qué* decisiones tomar.

```text
                                   Simulation Runner
                                           │
      ┌────────────────────────────────────┼────────────────────────────────────┐
      │                                    │                                    │
      ▼                                    ▼                                    ▼
+--------------+                   +--------------+                   +--------------+
| Bot #1       |                   | Bot #2       |                   | Bot #10000   |
+--------------+                   +--------------+                   +--------------+
        │                                   │                                   │
        ▼                                   ▼                                   ▼
+--------------------------------------------------------------------------+
|                               Behavior Engine                            |
|--------------------------------------------------------------------------|
| Scheduler                                                        Events  |
| Tick Loop                                                   Dispatcher    |
| State Machine                                              Context        |
| Metrics                                                                  |
+--------------------------------------------------------------------------+
        │                                   │
        ▼                                   ▼
+--------------------------------------------------------------------------+
|                                  go-sdk                                  |
+--------------------------------------------------------------------------+
```

## Componentes Principales

- **Behavior (`Behavior` interface)**: La lógica pura de un agente. Implementa métodos como `Init()`, `Tick()`, `OnEvent()` y `Shutdown()`. Aquí es donde programas a un `Producer`, `Trader` o un modelo de IA.
- **Context (`Context`)**: Objeto inyectado a todos los behaviors. Contiene referencias seguras al `State` (aislado mediante mutexes), `Metrics`, `Logger`, el generador random, y el propio cliente del SDK.
- **Runner (`Runner`)**: Carga un archivo YAML que describe los agentes que componen la simulación y utiliza la factoría para lanzar cada bot de forma concurrente.
- **Scheduler**: Invoca el ciclo de decisión (`Tick()`) de cada agente basándose en una frecuencia pre-configurada (ej. 100ms para traders, 5s para consumidores).
- **Dispatcher**: Enruta y filtra los eventos recibidos del WebSocket directamente hacia el método `OnEvent()` del agente correspondiente.

## Escalabilidad
Al mantener una arquitectura basada en Behaviors, el sistema permite que agregar nuevas estrategias complejas en el futuro (Machine Learning, algoritmos genéticos, arbitraje) requiera únicamente agregar un nuevo archivo `.go` que implemente la interfaz `Behavior`, dejando completamente intactos el SDK y el orquestador principal.
