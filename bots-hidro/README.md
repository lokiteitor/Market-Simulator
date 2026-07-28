# ⚡ bots-hidro — Parque de centrales hidroeléctricas

Bots especializados en **generación eléctrica renovable**: compran agua, la
turbinan y venden electricidad. Nada más. Un binario Go que lanza N centrales
como goroutines sobre el `engine.Engine` del SDK (`go-sdk/sdk/`), igual que
`bots-v1` y `bots-ciudad`.

## Por qué un binario aparte

La fase de energía (ADR-024) metió la `electricidad` como insumo de las 113
recetas industriales y creó el tipo de instalación `generacion` con tres recetas:

| Receta | Insumos | Coste |
| ------ | ------- | ----- |
| `generacion_hidro` | solo `agua` | ~44 ¢/kWh |
| `central_termica_carbon` | `carbon` + `agua` | ~27 ¢/kWh |
| `central_termica_gas` | `gas_natural` + `agua` | ~31 ¢/kWh |

`bots-v1` ya tiene una especialidad `energetico` que se queda con el tipo
`generacion` **entero**. El problema es que las tres recetas comparten el nivel
de la instalación como presupuesto de concurrencia (ADR-021):
`prioridadRenovablePrimero` empuja la hidro delante mientras solo hay una línea,
pero en cuanto el bot escala a nivel 2-3 las líneas nuevas se van a las térmicas
— que es lo racional para un generalista, porque son 1,6× más baratas por kWh.
**La capacidad renovable acaba siendo un residuo del arranque, no una decisión.**

Eso importa por ADR-023: el carbón y el gas natural salen de yacimientos finitos
y su rendimiento cae al vaciarse. El día que se agoten, la hidro es la única
generación que queda en pie; si para entonces nadie construyó centrales
hidráulicas, la industria entera se para de golpe. Este binario existe para que
el parque renovable se dimensione **a propósito**: el 100% de su nivel es hidro.

## Las tres diferencias frente al productor genérico

1. **Solo recetas renovables.** De las recetas de `generacion` se queda con las
   que consumen exclusivamente insumos de la lista blanca (`insumos_renovables`,
   por defecto `agua`) y ninguno de yacimiento finito. No filtra por nombre: la
   API no expone la key de la receta. La lista blanca manda sobre el criterio del
   yacimiento porque `GET /catalog/deposits` puede fallar al arrancar y el engine
   sigue asumiendo recursos infinitos — con solo ese criterio, un fallo de red
   convertiría a este bot en un generalista que quema carbón.

2. **Margen mínimo bajo y apagado tardío.** La hidro es la generadora
   **marginal** por construcción, así que el criterio del productor genérico
   —parar si alguien vende por debajo de coste+margen— la apagaría casi siempre.
   Aquí solo se para cuando el precio ajeno deja de cubrir el **coste variable**,
   que es cuando generar destruye capital de verdad. Su propio ask nunca cuenta
   como competencia.

3. **Se apaga por almacén, no por precio.** Como el gate de precio casi nunca la
   detiene, lo que la detiene es el stock: si la electricidad se acumula sin
   venderse (`inventario_max_execs` ejecuciones por línea), deja de turbinar en
   vez de seguir pagando salarios. Por lo mismo, el modo liquidación de
   `SellAtMarket` está desactivado de hecho (`liqCapEfectivo`): el suelo de venta
   nunca baja del coste de reponer el kWh. Acumular y parar es la respuesta a un
   mercado que no paga el kWh renovable; rematarlo, no.

## Estructura

| Fichero | Qué es |
| ------- | ------ |
| `hidro.go` | `HidroStrategy`: selección de receta, capex, compra de agua, generación y venta. |
| `main.go` | Runner: autorregistro, UUID v5 deterministas por `--runner-id`, jitter, apagado limpio y retirada por quiebra (ADR-026). |
| `config.yaml` | Servidor, parámetros de la estrategia y el bloque `prices:` **generado**. |
| `hidro_test.go` | Tests sobre un `StateManager` real con el catálogo de generación completo. |

Los helpers compartidos (vista de mercado, humanización, dinero, venta a
mercado, economía de instalaciones, rendimiento de yacimientos) viven en
`go-sdk/sdk/botkit` y los comparte con `bots-v1`. **Al tocar uno, editarlo
ahí.**

## Uso

```bash
make build-bots-hidro
make run-bots-hidro            # el `scale` del config.yaml, con jitter de 60 s
```

O directamente:

```bash
cd bots-hidro
./bots-hidro-runner -config config.yaml -scale 80 -jitter 120 -runner-id maquina-1
```

| Flag | Qué hace |
| ---- | -------- |
| `-scale N` | Cuántas centrales lanza este proceso (pisa el `scale` del config). |
| `-runner-id ID` | Identificador de la máquina; deriva los usernames (UUID v5). Por defecto el `hostname`. |
| `-jitter S` | Retardo aleatorio de arranque (0-S s) para repartir la carga de conexión y registro. |
| `-no-persist` | Sesiones solo en RAM, sin escrituras a disco. |
| `-quiet` | Silencia el ciclo de vida individual e imprime un resumen cada 10 s. |

**No hay rotación** (a diferencia de `bots-v1`): la industria consume
electricidad de forma continua y una central que se apaga cada pocos minutos no
es una central. Tampoco es de instancia única (a diferencia de `bots-ciudad`):
los usernames se derivan de `--runner-id`, así que el parque se puede repartir
entre varias máquinas sin que dos procesos peleen por la misma cuenta.

## Configuración propia de la estrategia

Todo en `config.yaml`, todo opcional (los defaults están en `hidro.go`):

| Clave | Default | Qué es |
| ----- | ------- | ------ |
| `tipo_instalacion` | `generacion` | Tipo de instalación que compran las centrales. |
| `insumos_renovables` | `[agua]` | Lista blanca de insumos que hace que una receta cuente como renovable. |
| `max_desired_level` | `6` | Tope de líneas de producción por central. |
| `inventario_max_execs` | `6` | Ejecuciones de electricidad sin vender toleradas por línea antes de parar. |

`sim_time_factor` **debe coincidir** con el `SIM_TIME_FACTOR` del backend o el
coste de generar queda sesgado (el salario corre en segundos reales, la duración
de la receta está en tiempo simulado).

El bloque `prices:` **no se edita a mano**: se propaga por coste desde
`infra/seed-config.json` con
`cd backend && bun src/scripts/generate-catalog-artifacts.ts`, que lo escribe
idéntico en `bots-v1`, `bots-ciudad` y aquí.
