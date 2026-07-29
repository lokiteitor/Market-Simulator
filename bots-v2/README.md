# bots-v2 — enjambre especializado por oficio (ADR-027)

Segunda generación del enjambre heurístico. Mismo SDK (`go-sdk/`), misma API, misma
economía por ejecución que `bots-v1`; lo que cambia es **quién produce qué**.

## Qué problema resuelve

En `bots-v1` la especialización es el **tipo de instalación** (`specialties.go`) y el
reparto de la flota es round-robin entre 6 estrategias. Con 10.000 bots:

| Especialidad v1 | Recetas | Bots | Bots por receta |
| --------------- | ------- | ---- | --------------- |
| `aguador`       | 2       | 1667 | 833             |
| `energetico`    | 3       | 1667 | 556             |
| `farmer`        | 17      | 1667 | 98              |
| `miner`         | 17      | 1667 | 98              |
| `transformer`   | **113** | 1667 | **14,7**        |

Un factor ~57 de desequilibrio, y justo al revés de donde está la complejidad. Y dentro
de un tipo, el nivel de la instalación es un presupuesto de concurrencia **compartido**
(ADR-021): un bot con nivel 3 en `componentes` no cubre sus 20 recetas, cubre 3 — y
cuáles, lo decide el `rnd.Perm` de cada tick. Los eslabones que se quedan sin productor
real paran todo lo que cuelga de ellos.

`bots-hidro` es la prueba: una especialización **dentro** de `generacion` que no cabía en
el modelo y acabó siendo un binario duplicado.

## Qué es un oficio

Un conjunto de **recetas concretas**, declarado a mano en [`oficios.yaml`](oficios.yaml)
y nombrado por `recipe.key` (la clave estable del catálogo, espejo de `product.key`). Son
66 oficios que cubren las 152 recetas: `aguador`, `siderurgico`, `panadero`,
`hidroelectrico`, `controlista`…

```yaml
- key: hidroelectrico
  rol: transformer
  tipos: [generacion]
  recetas: [generacion_hidro]
  capa: 1
  peso: 45
  max_nivel: 4
  insumos_permitidos: [agua]
  exigir_sin_yacimiento: true
  apagado: coste_variable # no coste+margen: es la generadora marginal
  freno: almacen # no por precio: acumular y parar, no rematar
  inventario_max_execs: 6
```

Esos cinco campos son **todo** `bots-hidro`. El binario deja de hacer falta.

## Las cuatro diferencias de comportamiento

1. **Composición de flota por cobertura + peso** (`flota.go`). Primero `cobertura_minima`
   bots a **cada** oficio —ningún eslabón nace huérfano—, y el resto proporcional al
   `peso`, que refleja cuántas recetas dependen de sus outputs (el acero lo consumen 34;
   el asfalto, ninguna). Determinista: dos corridas con los mismos parámetros dan la
   misma flota, que es lo que hace comparables dos experimentos.
2. **Arranque por capas del grafo**. El retardo es `capa × segundos_por_capa` más jitter
   _dentro_ de la capa, en vez del jitter uniforme de v1: el agua entra primero y la
   industria pesada al final, que es el orden en que la cadena puede producir de verdad
   desde inventario cero (ADR-022).
3. **Adaptación lenta** (`adaptacion.go`). El margen y el undercut se mueven según se
   venda o se acumule el stock. En v1 los parámetros se sortean en `Initialize` y no
   cambian jamás: un bot al que le tocó `minMargin` 0,19 donde el resto vende al 0,06 no
   vende nada en toda la corrida y no se entera nunca.
4. **Pivote de oficio**. Si el nicho lleva ~10 min sin dar margen, el bot cambia a otro
   oficio **de una instalación que ya tiene pagada** (coste hundido, cambio gratis). Es
   lo que drena los oficios sin demanda: el refinador de combustibles acaba en
   petroquímica o fertilizantes, que comparten el tipo `refineria`.

Además, el orden de atención de recetas es **por margen esperado** (con desempate
aleatorio) en vez del `rnd.Perm` de v1: con líneas escasas se produce lo que más renta,
y desaparece la necesidad de funciones de prioridad ad hoc como
`prioridadRenovablePrimero`.

## Uso

```bash
make build-bots-v2
make plan-swarm-v2          # composición de la flota, sin conectar con el servidor
make run-bots-v2            # los 6 bots de ejemplo de config.yaml
make run-swarm-v2           # 10.000 bots

# reparto entre máquinas: la unión de los shards es EXACTAMENTE la flota
./bots-v2-runner -config config.yaml -scale 10000 -shard 0/3 -runner-id maq-1
./bots-v2-runner -config config.yaml -scale 10000 -shard 1/3 -runner-id maq-1
```

Flags propios de v2 (los demás son los de `bots-v1`):

- `-oficios` — ruta del catálogo de oficios (default `oficios.yaml`).
- `-shard i/N` — porción de la flota que lanza este runner. En v1 cada instancia genera
  la flota **entera** con otro namespace: dos runners no reparten trabajo, duplican la
  economía.
- `-dry-run` — imprime la composición y sale.
- `-jitter` — ahora es el jitter **dentro** de cada capa; el escalonado entre capas lo
  fija `segundos_por_capa` en `oficios.yaml`.

`bots-v2` usa un **namespace UUID propio**, así que puede correr a la vez que `bots-v1`
contra la misma economía sin robarle las cuentas: es la forma de comparar las dos flotas
sobre el mismo mercado.

## Requisito: `recipe.key`

Los oficios nombran recetas por su clave de catálogo, que el backend expone desde el
mismo commit que este directorio. Si el servidor es anterior:

```bash
cd backend && bun src/scripts/backfill-recipe-keys.ts   # o make clean-docker + make seed
```

Sin ella el runner **arranca igual**, pero cada oficio degrada a "todas las recetas de mis
tipos" (o sea, el comportamiento de v1) y lo avisa por log en cada bot.

## Hallazgo del catálogo

Los tests (`oficios_test.go`) comprobaron algo que no es de los bots sino del catálogo:
había **30 de las 152 recetas que no llegaban a ningún consumo final** siguiendo el grafo
hacia adelante. Como las ciudades son la única demanda final y solo compran
`final_consumption` (ADR-025), esas recetas no se pueden vender.

El test es **transitivo** a propósito: preguntar solo "¿lo compra alguien?" da falsos
vivos (al ganado bovino lo compra `procesado_carne`, cuya carne procesada no compra nadie).

**Poda aplicada** (v3.2 del catálogo). Se eliminaron las ramas de lubricantes y de
celulosa→papel→cartón, y los tres genéricos sin salida (`frutas`, `verduras`, `lacteos`)
se desglosaron en productos concretos de consumo final: manzana, naranja, plátano,
lechuga, zanahoria, cebolla, leche pasteurizada, crema y helado. `conservas` pasó a
consumo final y su receta ahora enlata tomate y sal. Quedan **20 recetas muertas** y
**6 oficios** marcados `sin_demanda: true` con peso 0 —reciben solo la cobertura mínima,
porque su único destino garantizado es la quiebra—:

| Oficio                   | Recetas                                                |
| ------------------------ | ------------------------------------------------------ |
| `refinador_combustibles` | `refino_diesel`, `refino_gasolina`, `refino_queroseno` |
| `ceramista`              | `coccion_ladrillos`, `produccion_asfalto`              |
| `ganadero_carne`         | `cria_bovino`, `cria_cerdos`, `cria_pollos`            |
| `carnico`                | `procesado_carne`                                      |
| `bebidas`                | `embotellado_bebidas`                                  |
| `ganadero_lana`          | `esquila`                                              |

El resto son recetas muertas dentro de oficios vivos (`fundicion_inox`, `mineria_uranio`,
`mineria_plata`, `mineria_niquel`, `cultivo_cafe`, `produccion_resinas`, `prensado_aceite`,
`cantera_piedra`, `extraccion_arcilla`): el oficio se sostiene con sus otras recetas y el
orden por margen las deja al final. Los combustibles son deliberados — ADR-022 pospone el
combustible en las extractivas para no cerrar ciclos en el grafo.

## Archivos

| Archivo           | Responsabilidad                                                              |
| ----------------- | ---------------------------------------------------------------------------- |
| `oficios.yaml`    | El catálogo de oficios. Escrito a mano; `oficios_test.go` vigila la cobertura |
| `oficio.go`       | Modelo, validación y resolución del oficio contra el catálogo del servidor    |
| `flota.go`        | Composición (cobertura + peso), sharding y retardo por capa                   |
| `producer.go`     | Motor productor: filtro por receta, apagado/freno declarativos, cierre de turno |
| `adaptacion.go`   | Adaptación de margen/undercut y pivote de oficio                              |
| `trader.go`       | Creador de mercado (igual que v1)                                            |
| `bank.go`         | Ventanilla del banco y arbitraje de oro (igual que v1)                       |
| `main.go`         | CLI, construcción de la flota y rotación consciente del oficio                |

Los helpers compartidos (humanización, dinero, market view, venta a mercado, economía de
instalaciones, rendimiento de yacimientos) siguen viviendo en `go-sdk/sdk/botkit`;
`botkit_aliases.go` los re-exporta. **Al tocar un helper, editarlo en `botkit`.**
