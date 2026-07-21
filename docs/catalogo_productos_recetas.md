# Catálogo de Productos y Recetas — Guía de Enriquecimiento

> **Proyecto:** Market-Simulator (Simulación de Mercado)
>
> **Versión:** 1.0
>
> **Estado:** Referencia canónica para enriquecer el catálogo
>
> **Audiencia:** Un agente de IA que ampliará el catálogo del simulador
> (`infra/seed-config.json` → tablas `product`, `recipe`, `recipe_input`).
>
> **Origen:** Adaptación de tres documentos de otro proyecto ("Logistics World"):
> recursos globales, recursos industriales y productos finales. Este documento es
> **autocontenido**: no requiere los documentos de origen para trabajar.

---

## 1. Objetivo y cómo usar este documento

Este documento define **qué productos y qué cadenas de transformación** deben
existir en el catálogo del simulador, ya traducidos al modelo de datos real de
este proyecto.

Un agente de IA debe usarlo para:

1. Generar entradas nuevas en `infra/seed-config.json` (productos y recetas) que
   respeten el esquema y las reglas de la Sección 2.
2. Mantener la coherencia del grafo económico (todo se rastrea hasta un recurso
   natural; nada se fabrica "de la nada").
3. Asignar parámetros numéricos (cantidades, duraciones, salarios) siguiendo la
   guía de la Sección 7, anclada al catálogo agrícola ya existente.

**Regla de oro:** el catálogo agrícola actual (`infra/seed-config.json`:
trigo→harina→pan, maíz→masa→tortilla, leche→queso, tomate→salsa) es el patrón de
referencia de estilo, unidades y magnitudes. Todo lo que se añada debe encajar
con él sin romper el `bun run seed`.

---

## 2. Modelo de datos objetivo (contrato del catálogo)

El esquema real vive en `specs/schema.sql` (espejo en
`backend/src/db/schema.ts`). El seed se valida con Zod en `backend/src/seed/seed-config.ts`.
Estas son las **tres tablas** del catálogo y sus reglas.

### 2.1 `product` — un ítem del catálogo

| Campo      | Tipo   | Reglas                                                        |
| ---------- | ------ | ------------------------------------------------------------ |
| `name`     | texto  | **Único**. Nombre humano en español (p. ej. "Harina de trigo"). |
| `unit`     | texto  | Unidad libre de medida: `kg`, `litro`, `unidad`, `m3`, …      |
| `category` | enum   | Exactamente uno de: `raw_primary`, `intermediate`, `final_consumption`. |

En el `seed-config.json` cada producto lleva además una `key` (slug único,
snake_case, minúsculas, sin acentos) que **solo** sirve para referenciarlo desde
las recetas; no se persiste en la base de datos.

**Enum de categorías — significado en este proyecto:**

- **`raw_primary`** — Recurso primario. Se **obtiene**, no se fabrica a partir de
  otros productos. En el juego se produce con una receta **sin insumos** (ver
  §2.2). Equivale al "Nivel 1 · Recursos Naturales" del material de origen.
- **`intermediate`** — Bien intermedio. Se fabrica a partir de otros productos y
  se consume para fabricar otros. **Colapsa tres niveles del origen**: materiales
  básicos, materiales industriales y componentes.
- **`final_consumption`** — Producto final. Es el sumidero de la cadena: se
  compra/consume pero no alimenta otras recetas. Equivale al "Nivel 5 ·
  Productos Finales".

### 2.2 `recipe` — una transformación (y sus insumos)

| Campo (JSON seed)        | Tipo   | Reglas                                                                 |
| ------------------------ | ------ | ---------------------------------------------------------------------- |
| `key`                    | texto  | Slug único de la receta (referencia interna del seed).                 |
| `name`                   | texto  | **Único**. Nombre humano del proceso (p. ej. "Molienda de trigo").     |
| `output`                 | texto  | `key` del **único** producto que produce.                              |
| `output_qty_cent`        | entero | Cantidad producida por ejecución, en **centésimas** (>0).              |
| `duration_sim_seconds`   | entero | Duración de **una** ejecución en **segundos simulados** (>0).          |
| `wage_rate_cents_per_sec`| entero | Salario en centavos por segundo simulado (≥0, típicamente 0–3).        |
| `inputs`                 | lista  | Cero o más `{ "product": <key>, "qty_cent": <entero > 0> }`.           |

**Restricciones duras del modelo (no negociables):**

1. **Una receta produce EXACTAMENTE un producto.** No existe salida múltiple ni
   subproductos simultáneos en el esquema. Un proceso real con varias salidas se
   modela como **varias recetas independientes** (ver §4.1).
2. **Los insumos no se repiten** dentro de una receta (`product` único por receta).
3. **`qty_cent` está en centésimas de la unidad del producto.** `10000` = 100
   unidades (100 kg, 100 L, etc.); `100` = 1 unidad. Para bienes **discretos**
   (un camión, un motor), usa `unit: "unidad"` y expresa 1 pieza como `100`.
4. **Un recurso primario (`raw_primary`) se produce con una receta SIN insumos.**
   Representa extracción/cultivo/cría (minería, pozo, bosque, campo, ordeña). Ver
   los ejemplos `cultivo_trigo` / `ordena` del seed actual.
5. `duration` se guarda como INTERVAL en **tiempo simulado**, no real. El salario
   total de una ejecución = `wage_rate_cents_per_sec × duration_sim_seconds` y lo
   calcula la aplicación; tú solo defines la tasa y la duración.

### 2.3 Capacidades por rol (contexto, opcional al enriquecer)

El seed también asigna, por rol de agente
(`primary_producer`, `transformer`, `consumer`, `trader`), qué recetas puede
ejecutar y con cuántas instalaciones (`roles.*.capacities`). Al enriquecer el
catálogo conviene, coherentemente:

- Asignar las recetas **sin insumos** (extracción/cultivo) al `primary_producer`.
- Asignar las recetas **con insumos** al `transformer`.
- `consumer` y `trader` normalmente no tienen capacidades de producción.

No es obligatorio ampliar las capacidades al añadir productos, pero si el objetivo
es que la cadena "corra", cada receta nueva debería estar en las capacidades de
algún rol.

---

## 3. Reglas de mapeo: 5 niveles de origen → 3 categorías

El material de origen usa cinco niveles; este proyecto usa tres categorías. El
mapeo es:

| Nivel de origen                    | Categoría destino    |
| ---------------------------------- | -------------------- |
| Nivel 1 · Recursos Naturales       | `raw_primary`        |
| Nivel 2 · Materiales Básicos       | `intermediate`       |
| Nivel 3 · Materiales Industriales  | `intermediate`       |
| Nivel 4 · Componentes              | `intermediate`       |
| Nivel 5 · Productos Finales        | `final_consumption`  |

Consecuencias:

- La "profundidad" de la cadena (materia básica → industrial → componente) **se
  conserva como recetas encadenadas** entre productos `intermediate`, aunque
  todos compartan categoría. La categoría no limita el encadenamiento.
- Un producto es `final_consumption` **solo si ninguna receta lo consume**. Si en
  el futuro algo lo consumiera, pasa a `intermediate`.

---

## 4. Diferencias respecto al material de origen (leer antes de traducir)

### 4.1 Salida única: cómo modelar subproductos

El origen define procesos con **varias salidas simultáneas** (refinería, molino,
aserradero, planta láctea, procesadora de carne, trituradora). El esquema **no lo
permite**. Cada salida se modela como una **receta independiente** que consume la
misma materia prima:

- **Refinería** (petróleo → gasolina + diésel + queroseno + lubricantes + asfalto)
  → 5 recetas: `refino_gasolina`, `refino_diesel`, `refino_queroseno`,
  `refino_lubricantes`, `refino_asfalto`, cada una con `inputs: [petroleo]`.
- **Planta láctea** (leche → queso + mantequilla + yogur) → 3 recetas.
- **Procesadora de carne** (ganado → carne + cuero) → 2 recetas.
- **Molino** (trigo → harina + salvado) → `harina` (ya existe) + opcional `salvado`.
- **Aserradero** (troncos → tablas + serrín) → `tablas` + opcional `serrin`.
- **Trituradora** (piedra → grava + arena industrial) → 2 recetas.

Los **subproductos son opcionales**: inclúyelos solo si vas a darles un uso
económico (otra receta que los consuma o demanda de consumo). Un subproducto sin
consumidor y sin demanda es ruido; prefiérelo omitir en v1.

### 4.2 Familias logísticas y vehículos de transporte: FUERA de v1

El origen clasifica cada recurso en una familia logística (granel sólido/líquido,
carga general, contenedores, refrigerados, sobredimensionados) y define vehículos
de transporte. **El esquema v1 no tiene columnas para esto** y el mercado no
simula transporte físico. Por tanto:

- **No** inventes columnas ni campos para familia logística o transporte.
- La familia logística se incluye en las tablas de la §5 **solo como metadato
  informativo** (útil si en el futuro se añade logística). Ignórala al generar
  `seed-config.json`.
- Los "vehículos de transporte" del origen (camión, tren, barco, avión) **sí**
  existen aquí, pero como **productos finales fabricables y comerciables**
  (`final_consumption`), no como mecánica de transporte.

### 4.3 Insumos genéricos: normalización obligatoria

El material de origen (sobre todo los productos finales) cita insumos vagos:
"componentes eléctricos", "componentes mecánicos", "sistemas de navegación",
"electrónica avanzada", "maquinaria pesada", "sistemas hidráulicos". El esquema
exige referencias a productos concretos. **Resuelve cada término genérico a
productos concretos del catálogo** usando esta tabla:

| Término genérico del origen              | Productos concretos a usar como insumos            |
| ---------------------------------------- | -------------------------------------------------- |
| "componentes eléctricos"                 | `cableado`, `motor_electrico`                      |
| "componentes mecánicos"                  | `rodamientos`, `perfil_metalico`                   |
| "componentes electrónicos" / "electrónica" | `circuito_impreso`, `microchip`                  |
| "electrónica avanzada"                   | `microchip`, `sensor`, `pantalla`                  |
| "sistemas de navegación/control/señalización" | `sistema_control`                             |
| "sistemas eléctricos"                    | `cableado`, `transformador`                        |
| "sistemas hidráulicos"                   | `sistema_hidraulico`                               |
| "maquinaria pesada" / "grúas industriales" | `grua` (producto final reutilizado como insumo)  |
| "motores industriales" / "motor de combustión industrial" | `motor_combustion`               |
| "cristales" / "cristales técnicos"       | `cristal_plano` / `cristal_tecnico`                |
| "acero estructural" / "estructuras de acero" | `viga_acero` (+ `lamina_acero` si aplica)      |
| "tanque especializado"                   | `tanque_especializado`                             |
| "sistema de refrigeración" / "aislamiento térmico" | `sistema_refrigeracion` / `aislamiento_termico` |

Los productos "nuevos" que esta normalización necesita y que no estaban
explícitos en el origen (`silicio`, `sistema_control`, `sistema_hidraulico`,
`motor_aeronautico`, `turbina`, `tanque_especializado`, `sistema_refrigeracion`,
`aislamiento_termico`) están listados en la §5 y **deben crearse** como productos
`intermediate`.

### 4.4 Nota sobre duplicados de nombre

- **Cobre:** el origen usa "Cobre" (mineral) y "Cobre refinado". Aquí:
  `mineral_cobre` (`raw_primary`) y `cobre_refinado` (`intermediate`). Todo
  consumo aguas abajo usa `cobre_refinado`.
- **Transformador / Generador:** aparecen como *componente* (Nivel 4) y como
  *producto final* (Nivel 5). Aquí: `transformador` y `generador` son componentes
  `intermediate`; `transformador_electrico` y `generador_industrial` son los
  productos finales comerciables. Reutiliza los componentes como insumos de los
  finales.
- **Refinería / Planta química, etc.:** el proceso de refinado es una **receta**
  (`refino_*`); "Refinería de Petróleo" es además un **producto final** (edificio
  fabricable). Son entidades distintas y ambas existen.

---

## 5. Catálogo de productos

Leyenda de columnas: **key** (slug del seed) · **Nombre** (name en DB) · **Unidad**
sugerida · **Familia logística** (solo informativo, §4.2) · **Notas / usos**.

### 5.1 `raw_primary` — Recursos primarios (receta sin insumos)

#### Minería (granel sólido)

| key            | Nombre         | Unidad | Familia log. | Usos principales                          |
| -------------- | -------------- | ------ | ------------ | ----------------------------------------- |
| `hierro`       | Hierro         | kg     | Granel sólido | Acero, acero inoxidable                    |
| `carbon`       | Carbón         | kg     | Granel sólido | Acero, energía, química                     |
| `mineral_cobre`| Mineral de cobre | kg   | Granel sólido | Cobre refinado                             |
| `bauxita`      | Bauxita        | kg     | Granel sólido | Aluminio                                   |
| `litio`        | Litio          | kg     | Granel sólido | Baterías                                   |
| `niquel`       | Níquel         | kg     | Granel sólido | Acero inoxidable, aleaciones               |
| `oro`          | Oro            | kg     | Granel sólido | Circuitos impresos, electrónica            |
| `plata`        | Plata          | kg     | Granel sólido | Electrónica, conductores                   |
| `uranio`       | Uranio         | kg     | Granel sólido | Combustible nuclear (central nuclear)      |
| `arena`        | Arena          | kg     | Granel sólido | Vidrio, hormigón, silicio                  |
| `piedra`       | Piedra         | kg     | Granel sólido | Construcción, asfalto, grava               |
| `caliza`       | Caliza         | kg     | Granel sólido | Cemento, química                           |
| `arcilla`      | Arcilla        | kg     | Granel sólido | Ladrillos, cerámica                        |
| `fosfato`      | Fosfato        | kg     | Granel sólido | Fertilizantes                              |
| `sal`          | Sal            | kg     | Granel sólido | Química, alimentación                      |

#### Energía

| key           | Nombre       | Unidad | Familia log.   | Usos principales                                   |
| ------------- | ------------ | ------ | -------------- | -------------------------------------------------- |
| `petroleo`    | Petróleo     | litro  | Granel líquido | Combustibles, plásticos, química, lubricantes, asfalto |
| `gas_natural` | Gas Natural  | m3     | Granel líquido | Fertilizantes, química, energía                     |
| `agua`        | Agua         | litro  | Granel líquido | Hormigón, bebidas, agricultura, industria           |

#### Forestal

| key       | Nombre  | Unidad | Familia log.   | Usos principales             |
| --------- | ------- | ------ | -------------- | ---------------------------- |
| `troncos` | Troncos | kg     | Carga general  | Tablas, celulosa, papel      |

#### Agricultura

| key          | Nombre         | Unidad | Familia log.  | Usos principales          |
| ------------ | -------------- | ------ | ------------- | ------------------------- |
| `trigo`      | Trigo          | kg     | Granel sólido | Harina                    |
| `maiz`       | Maíz           | kg     | Granel sólido | Masa, piensos             |
| `soya`       | Soya           | kg     | Granel sólido | Aceite vegetal, piensos   |
| `algodon`    | Algodón        | kg     | Carga general | Textiles                  |
| `cana_azucar`| Caña de azúcar | kg     | Granel sólido | Azúcar                    |
| `cafe`       | Café           | kg     | Carga general | Bebidas                   |
| `cacao`      | Cacao          | kg     | Carga general | Chocolate / bebidas       |
| `frutas`     | Frutas         | kg     | Refrigerados  | Conservas, consumo        |
| `verduras`   | Verduras       | kg     | Refrigerados  | Conservas, consumo        |

#### Ganadería

| key            | Nombre        | Unidad | Familia log.  | Usos principales           |
| -------------- | ------------- | ------ | ------------- | -------------------------- |
| `ganado_bovino`| Ganado bovino | unidad | Refrigerados  | Carne procesada, cuero     |
| `cerdos`       | Cerdos        | unidad | Refrigerados  | Carne procesada            |
| `pollos`       | Pollos        | unidad | Refrigerados  | Carne procesada            |
| `leche`        | Leche         | litro  | Refrigerados  | Queso, mantequilla, yogur  |
| `lana`         | Lana          | kg     | Carga general | Textiles                   |

### 5.2 `intermediate` — Materiales básicos

| key               | Nombre              | Unidad | Familia log.   | Insumos de su receta (ver §6)         |
| ----------------- | ------------------- | ------ | -------------- | ------------------------------------- |
| `acero`           | Acero               | kg     | Carga general  | hierro, carbón                        |
| `acero_inoxidable`| Acero inoxidable    | kg     | Carga general  | acero, níquel                         |
| `aluminio`        | Aluminio            | kg     | Carga general  | bauxita                               |
| `cobre_refinado`  | Cobre refinado      | kg     | Carga general  | mineral_cobre                         |
| `cemento`         | Cemento             | kg     | Carga general  | caliza                                |
| `hormigon`        | Hormigón            | kg     | Carga general  | cemento, arena, agua                  |
| `vidrio`          | Vidrio              | kg     | Carga general  | arena                                 |
| `ladrillos`       | Ladrillos           | unidad | Carga general  | arcilla                               |
| `asfalto`         | Asfalto             | kg     | Granel líquido | petróleo, piedra                      |
| `plastico`        | Plástico            | kg     | Carga general  | petróleo                              |
| `caucho_sintetico`| Caucho sintético    | kg     | Carga general  | petróleo                              |
| `fertilizantes`   | Fertilizantes       | kg     | Carga general  | gas_natural, fosfato                  |
| `productos_quimicos`| Productos químicos| litro  | Granel líquido | petróleo, sal                         |
| `silicio`         | Silicio             | kg     | Carga general  | arena  *(nuevo, ver §4.3)*            |
| `tablas`          | Tablas              | kg     | Carga general  | troncos                               |
| `papel`           | Papel               | kg     | Carga general  | celulosa (o troncos)                  |
| `carton`          | Cartón              | kg     | Carga general  | papel                                 |
| `harina`          | Harina de trigo     | kg     | Carga general  | trigo *(ya en seed actual)*           |
| `azucar`          | Azúcar              | kg     | Carga general  | caña_azucar                           |
| `aceite_vegetal`  | Aceite vegetal      | litro  | Granel líquido | soya                                  |
| `carne_procesada` | Carne procesada     | kg     | Refrigerados   | ganado_bovino / cerdos / pollos       |
| `lacteos`         | Lácteos             | kg     | Refrigerados   | leche (ver quesería/láctea)           |
| `gasolina`        | Gasolina            | litro  | Granel líquido | petróleo                              |
| `diesel`          | Diésel              | litro  | Granel líquido | petróleo                              |
| `queroseno`       | Queroseno           | litro  | Granel líquido | petróleo                              |
| `lubricantes`     | Lubricantes         | litro  | Granel líquido | petróleo                              |

### 5.3 `intermediate` — Materiales industriales

| key                 | Nombre                | Unidad | Familia log.   | Insumo(s) base       |
| ------------------- | --------------------- | ------ | -------------- | -------------------- |
| `viga_acero`        | Vigas de acero        | kg     | Carga general  | acero                |
| `lamina_acero`      | Láminas de acero      | kg     | Carga general  | acero                |
| `tubo_acero`        | Tubos de acero        | kg     | Carga general  | acero                |
| `perfil_metalico`   | Perfiles metálicos    | kg     | Carga general  | acero                |
| `lamina_aluminio`   | Láminas de aluminio   | kg     | Carga general  | aluminio             |
| `perfil_aluminio`   | Perfiles de aluminio  | kg     | Carga general  | aluminio             |
| `cable_cobre`       | Cable de cobre        | kg     | Carga general  | cobre_refinado       |
| `bobina_cobre`      | Bobinas de cobre      | kg     | Carga general  | cobre_refinado       |
| `cristal_plano`     | Cristal plano         | kg     | Carga general  | vidrio               |
| `cristal_tecnico`   | Cristal técnico       | kg     | Carga general  | vidrio               |
| `polimeros`         | Polímeros             | kg     | Carga general  | plástico             |
| `resinas`           | Resinas               | kg     | Carga general  | productos_quimicos   |
| `fibra_sintetica`   | Fibra sintética       | kg     | Carga general  | plástico             |
| `lubricante_industrial` | Lubricante industrial | litro | Granel líquido | lubricantes       |
| `madera_tratada`    | Madera tratada        | kg     | Carga general  | tablas               |
| `contrachapado`     | Contrachapado         | kg     | Carga general  | tablas               |
| `celulosa`          | Celulosa              | kg     | Carga general  | troncos              |
| `conservas`         | Conservas             | kg     | Carga general  | frutas, verduras     |
| `piensos`           | Piensos               | kg     | Carga general  | maíz, soya           |
| `bebidas`           | Bebidas               | litro  | Carga general  | agua, azúcar         |

#### Subproductos (opcionales, §4.1)

| key             | Nombre           | Unidad | Proceso de origen        | Uso sugerido            |
| --------------- | ---------------- | ------ | ------------------------ | ----------------------- |
| `serrin`        | Serrín           | kg     | Aserradero (troncos)     | Biomasa / piensos       |
| `cuero`         | Cuero            | kg     | Procesadora (ganado)     | Textiles / asientos     |
| `queso`         | Queso fresco     | kg     | Planta láctea (leche)    | `final_consumption`     |
| `mantequilla`   | Mantequilla      | kg     | Planta láctea (leche)    | `final_consumption`     |
| `yogur`         | Yogur            | litro  | Planta láctea (leche)    | `final_consumption`     |
| `salvado`       | Salvado          | kg     | Molino (trigo)           | Piensos                 |
| `grava`         | Grava            | kg     | Trituradora (piedra)     | Hormigón / construcción |
| `arena_industrial` | Arena industrial | kg  | Trituradora (piedra)     | Vidrio / hormigón       |

> Nota: `queso`, `mantequilla` y `yogur` son de consumo final; si los incluyes,
> márcalos `final_consumption`, no `intermediate`. El seed actual ya usa
> `queso` como `final_consumption`.

### 5.4 `intermediate` — Componentes

| key                  | Nombre                | Unidad | Familia log.  | Insumos (ver §6)                    |
| -------------------- | --------------------- | ------ | ------------- | ----------------------------------- |
| `chasis`             | Chasis                | unidad | Contenedores  | viga_acero, lamina_acero            |
| `motor_combustion`   | Motor de combustión   | unidad | Contenedores  | acero, aluminio, cable_cobre        |
| `caja_cambios`       | Caja de cambios       | unidad | Contenedores  | acero                               |
| `suspension`         | Suspensión            | unidad | Contenedores  | acero, caucho_sintetico             |
| `frenos`             | Frenos                | unidad | Contenedores  | acero                               |
| `rodamientos`        | Rodamientos           | unidad | Contenedores  | acero                               |
| `bomba_industrial`   | Bombas industriales   | unidad | Contenedores  | acero, tubo_acero                   |
| `motor_electrico`    | Motores eléctricos    | unidad | Contenedores  | bobina_cobre, acero                 |
| `transformador`      | Transformadores       | unidad | Sobredimensionado | bobina_cobre, acero             |
| `generador`          | Generadores           | unidad | Sobredimensionado | motor_combustion, acero         |
| `bateria`            | Baterías              | unidad | Contenedores  | litio, plástico                     |
| `cableado`           | Cableado              | kg     | Contenedores  | cable_cobre, plástico               |
| `circuito_impreso`   | Circuitos impresos    | unidad | Contenedores  | oro, cobre_refinado, plástico       |
| `microchip`          | Microchips            | unidad | Contenedores  | circuito_impreso, productos_quimicos, silicio |
| `sensor`             | Sensores              | unidad | Contenedores  | circuito_impreso                    |
| `pantalla`           | Pantallas             | unidad | Contenedores  | cristal_tecnico, circuito_impreso   |
| `ventana`            | Ventanas              | unidad | Carga general | cristal_plano, perfil_aluminio      |
| `puerta_industrial`  | Puertas industriales  | unidad | Carga general | acero, plástico                     |
| `panel_prefabricado` | Panel prefabricado    | unidad | Carga general | hormigón, viga_acero                |
| `tuberia`            | Tuberías              | kg     | Carga general | tubo_acero, plástico                |
| `asiento`            | Asientos              | unidad | Contenedores  | fibra_sintetica, acero              |
| `panel_interior`     | Paneles interiores    | unidad | Contenedores  | polímeros                           |
| `neumatico`          | Neumáticos            | unidad | Contenedores  | caucho_sintetico                    |
| `turbina`            | Turbina               | unidad | Sobredimensionado | acero, perfil_metalico  *(nuevo)* |
| `sistema_hidraulico` | Sistema hidráulico    | unidad | Contenedores  | acero, tubo_acero, bomba_industrial *(nuevo)* |
| `motor_aeronautico`  | Motor aeronáutico     | unidad | Sobredimensionado | aluminio, acero, microchip *(nuevo)* |
| `sistema_control`    | Sistema de control    | unidad | Contenedores  | microchip, sensor, cableado *(nuevo)* |
| `tanque_especializado` | Tanque especializado | unidad | Sobredimensionado | lamina_acero, tubo_acero *(nuevo)* |
| `sistema_refrigeracion`| Sistema de refrigeración | unidad | Contenedores | motor_electrico, tuberia, productos_quimicos *(nuevo)* |
| `aislamiento_termico`| Aislamiento térmico   | kg     | Carga general | polímeros, fibra_sintetica *(nuevo)* |

### 5.5 `final_consumption` — Productos finales

Un `final_consumption` no es insumo de ninguna receta. Aquí los "edificios" e
"infraestructura" se modelan como productos finales **fabricables y
comerciables** (el simulador no coloca edificios en un mapa).

#### Vehículos de transporte

| key                | Nombre             | Unidad | Insumos (resueltos, ver §4.3)                                        |
| ------------------ | ------------------ | ------ | ------------------------------------------------------------------- |
| `camion_carga`     | Camión de carga    | unidad | chasis, motor_combustion, caja_cambios, suspension, frenos, neumatico, cableado, sistema_control, cristal_plano |
| `camion_cisterna`  | Camión cisterna    | unidad | camion_carga, tanque_especializado, bomba_industrial, tubo_acero    |
| `camion_refrigerado`| Camión refrigerado| unidad | camion_carga, sistema_refrigeracion, aislamiento_termico            |
| `locomotora_diesel`| Locomotora diésel  | unidad | motor_combustion, chasis, sistema_control, generador                |
| `vagon_carga`      | Vagón de carga     | unidad | viga_acero, rodamientos, perfil_metalico                            |
| `barco_carga`      | Barco de carga     | unidad | viga_acero, motor_combustion, sistema_control, cableado             |
| `barco_petrolero`  | Barco petrolero    | unidad | barco_carga, tanque_especializado, bomba_industrial                 |
| `avion_carga`      | Avión de carga     | unidad | lamina_aluminio, motor_aeronautico, sistema_control, cristal_tecnico |

#### Infraestructura industrial (edificios fabricables)

| key                | Nombre                        | Unidad | Insumos                                            |
| ------------------ | ----------------------------- | ------ | -------------------------------------------------- |
| `planta_industrial`| Planta industrial genérica    | unidad | acero, hormigón, vidrio, rodamientos               |
| `refineria`        | Refinería de petróleo         | unidad | acero, tubo_acero, sistema_control, bomba_industrial |
| `central_electrica`| Central eléctrica             | unidad | turbina, generador, acero, cableado                |
| `planta_ensamblaje`| Planta de ensamblaje automotriz | unidad | acero, sistema_control, rodamientos, hormigón    |
| `astillero`        | Astillero                     | unidad | acero, grua, sistema_control                       |
| `fabrica_aeronaves`| Fábrica de aeronaves          | unidad | aluminio, microchip, motor_aeronautico, rodamientos |
| `planta_quimica`   | Planta química                | unidad | acero, tubo_acero, bomba_industrial, sistema_control |

#### Infraestructura de transporte

| key                 | Nombre               | Unidad | Insumos                                  |
| ------------------- | -------------------- | ------ | ---------------------------------------- |
| `estacion_carga`    | Estación de carga    | unidad | acero, hormigón, cableado                |
| `terminal_ferroviaria` | Terminal ferroviaria | unidad | acero, sistema_control, cableado      |
| `puerto_comercial`  | Puerto comercial     | unidad | hormigón, acero, grua, cableado          |
| `aeropuerto_carga`  | Aeropuerto de carga  | unidad | hormigón, acero, sistema_control, cableado |

#### Consumo, maquinaria y energía

| key                   | Nombre               | Unidad | Insumos                                       |
| --------------------- | -------------------- | ------ | --------------------------------------------- |
| `automovil`           | Automóvil            | unidad | chasis, motor_combustion, sistema_control, cristal_plano, neumatico, asiento, panel_interior |
| `refrigerador`        | Refrigerador         | unidad | acero, sistema_refrigeracion, panel_interior  |
| `lavadora`            | Lavadora             | unidad | acero, motor_electrico, sistema_control       |
| `televisor`          | Televisor            | unidad | pantalla, circuito_impreso, plástico          |
| `computadora`         | Computadora          | unidad | microchip, pantalla, plástico, cobre_refinado |
| `telefono`            | Teléfono             | unidad | microchip, pantalla, bateria, circuito_impreso |
| `excavadora`          | Excavadora           | unidad | acero, motor_combustion, sistema_hidraulico, sistema_control |
| `grua`                | Grúa                 | unidad | acero, motor_combustion, sistema_hidraulico   |
| `generador_industrial`| Generador industrial | unidad | acero, bobina_cobre, generador                |
| `panel_solar`         | Panel solar          | unidad | cristal_tecnico, silicio, circuito_impreso    |
| `turbina_eolica`      | Turbina eólica       | unidad | turbina, acero, sistema_control               |
| `transformador_electrico`| Transformador eléctrico | unidad | cobre_refinado, acero, transformador     |

#### Infraestructura urbana

| key                   | Nombre                 | Unidad | Insumos                              |
| --------------------- | ---------------------- | ------ | ------------------------------------ |
| `edificio_residencial`| Edificio residencial   | unidad | hormigón, acero, ventana, cableado   |
| `edificio_comercial`  | Edificio comercial     | unidad | hormigón, acero, ventana             |
| `fabrica_urbana_ligera`| Fábrica urbana ligera | unidad | acero, hormigón, sistema_control     |
| `almacen_logistico`   | Almacén logístico      | unidad | hormigón, acero, cableado            |

#### Alimentos de consumo final (además del seed agrícola actual)

| key           | Nombre        | Unidad | Insumos                     |
| ------------- | ------------- | ------ | --------------------------- |
| `queso`       | Queso fresco  | kg     | leche  *(ya en seed)*       |
| `mantequilla` | Mantequilla   | kg     | leche                       |
| `yogur`       | Yogur         | litro  | leche                       |
| `chocolate`   | Chocolate     | kg     | cacao, azúcar               |
| `textiles`    | Textiles      | kg     | algodón (o lana)            |

---

## 6. Grafo de recetas (cadenas de producción)

Cada fila es **una receta** = una salida. Los insumos listan solo *qué* productos
se consumen; las **cantidades, duración y salario** se asignan según la §7. Las
recetas de extracción (`raw_primary`) no llevan insumos.

### 6.1 Extracción primaria (sin insumos → `raw_primary`)

Una receta por cada recurso de la §5.1. Ejemplos de nombres de receta:
`mineria_hierro` → `hierro`, `mineria_carbon` → `carbon`, `pozo_petroleo` →
`petroleo`, `pozo_gas` → `gas_natural`, `captacion_agua` → `agua`, `tala` →
`troncos`, `cultivo_soya` → `soya`, `cria_bovino` → `ganado_bovino`, `ordena` →
`leche` (ya existe), etc. Todas con `inputs: []`.

### 6.2 Materiales básicos

| Receta (key)        | Salida              | Insumos                       |
| ------------------- | ------------------- | ----------------------------- |
| `fundicion_acero`   | acero               | hierro, carbón                |
| `acero_inox`        | acero_inoxidable    | acero, níquel                 |
| `refino_aluminio`   | aluminio            | bauxita                       |
| `refino_cobre`      | cobre_refinado      | mineral_cobre                 |
| `produccion_cemento`| cemento             | caliza                        |
| `mezcla_hormigon`   | hormigón            | cemento, arena, agua          |
| `fundicion_vidrio`  | vidrio              | arena                         |
| `coccion_ladrillos` | ladrillos           | arcilla                       |
| `produccion_asfalto`| asfalto             | petróleo, piedra              |
| `sintesis_plastico` | plastico            | petróleo                      |
| `sintesis_caucho`   | caucho_sintetico    | petróleo                      |
| `produccion_fertilizantes` | fertilizantes | gas_natural, fosfato        |
| `sintesis_quimicos` | productos_quimicos  | petróleo, sal                 |
| `produccion_silicio`| silicio             | arena                         |
| `aserrado`          | tablas              | troncos                       |
| `produccion_celulosa`| celulosa           | troncos                       |
| `produccion_papel`  | papel               | celulosa                      |
| `produccion_carton` | carton              | papel                         |
| `refino_azucar`     | azucar              | caña_azucar                   |
| `prensado_aceite`   | aceite_vegetal      | soya                          |
| `refino_gasolina`   | gasolina            | petróleo                      |
| `refino_diesel`     | diesel              | petróleo                      |
| `refino_queroseno`  | queroseno           | petróleo                      |
| `refino_lubricantes`| lubricantes         | petróleo                      |

### 6.3 Materiales industriales

| Receta (key)         | Salida              | Insumos             |
| -------------------- | ------------------- | ------------------- |
| `laminado_viga`      | viga_acero          | acero               |
| `laminado_lamina`    | lamina_acero        | acero               |
| `extrusion_tubo`     | tubo_acero          | acero               |
| `perfilado_metal`    | perfil_metalico     | acero               |
| `laminado_aluminio`  | lamina_aluminio     | aluminio            |
| `perfilado_aluminio` | perfil_aluminio     | aluminio            |
| `trefilado_cable`    | cable_cobre         | cobre_refinado      |
| `bobinado_cobre`     | bobina_cobre        | cobre_refinado      |
| `templado_cristal`   | cristal_plano       | vidrio              |
| `cristal_tecnico`    | cristal_tecnico     | vidrio              |
| `polimerizacion`     | polimeros           | plástico            |
| `produccion_resinas` | resinas             | productos_quimicos  |
| `hilado_fibra`       | fibra_sintetica     | plástico            |
| `madera_tratada`     | madera_tratada      | tablas              |
| `contrachapado`      | contrachapado       | tablas              |
| `enlatado_conservas` | conservas           | frutas, verduras    |
| `produccion_piensos` | piensos             | maíz, soya          |
| `embotellado_bebidas`| bebidas             | agua, azúcar        |

### 6.4 Componentes

| Receta (key)          | Salida               | Insumos                                  |
| --------------------- | -------------------- | ---------------------------------------- |
| `ensamble_chasis`     | chasis               | viga_acero, lamina_acero                 |
| `ensamble_motor`      | motor_combustion     | acero, aluminio, cable_cobre             |
| `ensamble_caja`       | caja_cambios         | acero                                    |
| `ensamble_suspension` | suspension           | acero, caucho_sintetico                  |
| `ensamble_frenos`     | frenos               | acero                                    |
| `ensamble_rodamientos`| rodamientos          | acero                                    |
| `ensamble_bomba`      | bomba_industrial     | acero, tubo_acero                        |
| `ensamble_motor_elec` | motor_electrico      | bobina_cobre, acero                      |
| `ensamble_transformador` | transformador     | bobina_cobre, acero                      |
| `ensamble_generador`  | generador            | motor_combustion, acero                  |
| `ensamble_bateria`    | bateria              | litio, plástico                          |
| `ensamble_cableado`   | cableado             | cable_cobre, plástico                    |
| `ensamble_circuito`   | circuito_impreso     | oro, cobre_refinado, plástico            |
| `ensamble_microchip`  | microchip            | circuito_impreso, productos_quimicos, silicio |
| `ensamble_sensor`     | sensor               | circuito_impreso                         |
| `ensamble_pantalla`   | pantalla             | cristal_tecnico, circuito_impreso        |
| `ensamble_ventana`    | ventana              | cristal_plano, perfil_aluminio           |
| `ensamble_puerta`     | puerta_industrial    | acero, plástico                          |
| `ensamble_panel_pref` | panel_prefabricado   | hormigón, viga_acero                     |
| `ensamble_tuberia`    | tuberia              | tubo_acero, plástico                     |
| `ensamble_asiento`    | asiento              | fibra_sintetica, acero                   |
| `ensamble_panel_int`  | panel_interior       | polímeros                                |
| `ensamble_neumatico`  | neumatico            | caucho_sintetico                         |
| `ensamble_turbina`    | turbina              | acero, perfil_metalico                   |
| `ensamble_hidraulico` | sistema_hidraulico   | acero, tubo_acero, bomba_industrial      |
| `ensamble_motor_aero` | motor_aeronautico    | aluminio, acero, microchip               |
| `ensamble_control`    | sistema_control      | microchip, sensor, cableado              |
| `ensamble_tanque`     | tanque_especializado | lamina_acero, tubo_acero                 |
| `ensamble_refrig`     | sistema_refrigeracion| motor_electrico, tuberia, productos_quimicos |
| `ensamble_aislamiento`| aislamiento_termico  | polímeros, fibra_sintetica               |

### 6.5 Productos finales

Ver §5.5: cada fila de esas tablas es una receta cuyo `output` es el producto
final y cuyos `inputs` son los componentes listados. Nombres de receta sugeridos:
`fab_camion_carga`, `fab_automovil`, `fab_computadora`, `constr_edificio_residencial`, etc.

### 6.6 Procesos multi-salida (subproductos, opcional)

Si decides materializar subproductos (§4.1), añade recetas paralelas que consuman
la misma materia prima:

| Receta (key)        | Salida        | Insumos  | Nota                         |
| ------------------- | ------------- | -------- | ---------------------------- |
| `molienda_salvado`  | salvado       | trigo    | Subproducto del molino       |
| `aserrado_serrin`   | serrin        | troncos  | Subproducto del aserradero   |
| `procesado_carne`   | carne_procesada | ganado_bovino | Salida principal        |
| `curtido_cuero`     | cuero         | ganado_bovino | Subproducto de la res    |
| `elab_queso`        | queso         | leche    | (ya existe como `queseria`)  |
| `elab_mantequilla`  | mantequilla   | leche    | Salida paralela              |
| `elab_yogur`        | yogur         | leche    | Salida paralela              |
| `trituracion_grava` | grava         | piedra   | Salida principal trituradora |
| `trituracion_arena` | arena_industrial | piedra | Salida paralela             |

---

## 7. Guía de parámetros numéricos

El grafo (§5–§6) fija **relaciones**; esta sección fija cómo elegir los **números**.
Ancla de referencia: el catálogo agrícola existente (`infra/seed-config.json`).

### 7.1 Unidades y `qty_cent`

- Todo en **centésimas**: `qty_cent = unidades × 100`. `10000` = 100 kg/L.
- **Bienes discretos** (`unit: "unidad"`: motores, vehículos, edificios): 1 pieza
  = `100`. Una receta que produce 1 camión → `output_qty_cent: 100`.
- Mantén las unidades coherentes con la §5 (kg / litro / m3 / unidad).

### 7.2 Rendimiento (relación insumo/salida)

Referencia del seed actual: molienda consume 100 kg trigo (`10000`) y produce 80
kg harina (`8000`); panadería consume 80 kg harina y produce 100 kg pan. Reglas:

- Para transformaciones de materia continua (kg→kg, L→L), usa una **merma o
  concentración realista** (rendimiento 0.5–1.2×). Ejemplo: fundición de acero
  con algo de merma; refino con rendimiento < 1.
- Para **ensamblajes discretos** (varios insumos → 1 pieza), define insumos en la
  escala del producto (p. ej. 1 motor = `100`, 200 kg de acero = `20000`) y
  `output_qty_cent: 100` (una pieza por ejecución) o un lote pequeño.
- Todo `qty_cent` debe ser **entero positivo**.

### 7.3 Duración (`duration_sim_seconds`)

Referencia del seed: extracción/cultivo 3600–7200 s; transformación 1800–5400 s;
proceso trivial (germinado) 60 s. Guía:

- **Extracción primaria:** 3600–7200 s (más para minería pesada/petróleo).
- **Materiales básicos e industriales:** 1800–5400 s.
- **Componentes:** 2400–7200 s (más a mayor complejidad).
- **Productos finales complejos** (vehículos, edificios, aeronaves): 7200–21600 s.

Escala la duración con la profundidad/complejidad de la cadena: un avión tarda
más que un tornillo.

### 7.4 Salario (`wage_rate_cents_per_sec`)

Referencia del seed: 1 (cultivo), 2 (molino/nixtamal), 3 (panadería/quesería).
Mantén el rango **0–3**:

- `1` — extracción/procesos simples.
- `2` — transformación intermedia.
- `3` — procesos intensivos / componentes / ensamblaje final.

Puedes usar `0` solo para procesos sin mano de obra (raro; evítalo salvo diseño
explícito).

### 7.5 Coherencia económica (importante)

Aunque el seed no valida precios, procura que el **coste acumulado** (insumos +
salario) crezca a lo largo de la cadena, de modo que exista margen para que un
producto final valga más que la suma de sus recursos. Un producto final debería
depender (directa o indirectamente) de **≥3 cadenas distintas** (regla heredada,
§9).

---

## 8. Ejemplos completos en formato `seed-config.json`

Fragmentos listos para pegar (respetan `backend/src/seed/seed-config.ts`).

**Cadena del acero (recurso → básico → industrial → componente):**

```json
{
  "key": "mineria_hierro",
  "name": "Minería de hierro",
  "output": "hierro",
  "output_qty_cent": 50000,
  "duration_sim_seconds": 7200,
  "wage_rate_cents_per_sec": 1,
  "inputs": []
}
```

```json
{
  "key": "fundicion_acero",
  "name": "Fundición de acero",
  "output": "acero",
  "output_qty_cent": 40000,
  "duration_sim_seconds": 5400,
  "wage_rate_cents_per_sec": 2,
  "inputs": [
    { "product": "hierro", "qty_cent": 40000 },
    { "product": "carbon", "qty_cent": 10000 }
  ]
}
```

```json
{
  "key": "laminado_viga",
  "name": "Laminado de vigas de acero",
  "output": "viga_acero",
  "output_qty_cent": 18000,
  "duration_sim_seconds": 3600,
  "wage_rate_cents_per_sec": 2,
  "inputs": [{ "product": "acero", "qty_cent": 20000 }]
}
```

**Ensamblaje discreto (producto en `unidad`):**

```json
{
  "key": "ensamble_motor",
  "name": "Ensamblaje de motor de combustión",
  "output": "motor_combustion",
  "output_qty_cent": 100,
  "duration_sim_seconds": 7200,
  "wage_rate_cents_per_sec": 3,
  "inputs": [
    { "product": "acero", "qty_cent": 15000 },
    { "product": "aluminio", "qty_cent": 5000 },
    { "product": "cable_cobre", "qty_cent": 2000 }
  ]
}
```

**Producto final (≥3 cadenas):**

```json
{
  "key": "fab_camion_carga",
  "name": "Fabricación de camión de carga",
  "output": "camion_carga",
  "output_qty_cent": 100,
  "duration_sim_seconds": 18000,
  "wage_rate_cents_per_sec": 3,
  "inputs": [
    { "product": "chasis", "qty_cent": 100 },
    { "product": "motor_combustion", "qty_cent": 100 },
    { "product": "caja_cambios", "qty_cent": 100 },
    { "product": "suspension", "qty_cent": 100 },
    { "product": "frenos", "qty_cent": 200 },
    { "product": "neumatico", "qty_cent": 600 },
    { "product": "cableado", "qty_cent": 3000 },
    { "product": "sistema_control", "qty_cent": 100 },
    { "product": "cristal_plano", "qty_cent": 2000 }
  ]
}
```

Y su producto correspondiente en `products`:

```json
{ "key": "camion_carga", "name": "Camión de carga", "unit": "unidad", "category": "final_consumption" }
```

---

## 9. Reglas de balance heredadas y checklist de validación

**Reglas de diseño (del material de origen, aplicables aquí):**

- Ningún recurso natural debe tener un único uso; todo material básico debería
  alimentar ≥2 industrias distintas cuando sea posible.
- Ningún producto final se fabrica directamente desde recursos naturales: debe
  pasar por intermedios y depender de ≥3 cadenas industriales distintas.
- Todo producto se rastrea hasta uno o varios `raw_primary`.
- Reutiliza componentes en varios productos finales (cadenas largas e
  interdependientes).

**Checklist antes de commitear al `seed-config.json`:**

1. Cada `key` de producto y de receta es **único**; cada `name` es **único**.
2. Cada `output` de receta apunta a un `key` de producto existente.
3. Cada `input.product` apunta a un `key` de producto existente; sin insumos
   repetidos dentro de una receta.
4. Toda receta tiene **exactamente un** `output`.
5. `output_qty_cent > 0`, `duration_sim_seconds > 0`,
   `wage_rate_cents_per_sec ≥ 0`, cada `input.qty_cent > 0` (todos enteros).
6. Todo `raw_primary` tiene una receta de extracción con `inputs: []`.
7. Ningún producto marcado `final_consumption` aparece como `input` de otra
   receta (si aparece, debe ser `intermediate`).
8. Categorías válidas: solo `raw_primary`, `intermediate`, `final_consumption`.
9. `unit` coherente con `qty_cent` (discretos en `unidad` con piezas ×100).
10. Idealmente, cada receta nueva se referencia en `roles.*.capacities` del rol
    adecuado (extracción → `primary_producer`; con insumos → `transformer`).
11. Tras editar, `cd backend && bun run seed` sobre una DB vacía debe pasar la
    validación Zod e integridad referencial de `backend/src/seed/seed-config.ts`.

---

## 10. Resumen de productos nuevos a crear

Productos que la normalización de insumos (§4.3) exige y que conviene crear
explícitamente como `intermediate`, aunque el material de origen no los detallara:

`silicio`, `turbina`, `sistema_hidraulico`, `motor_aeronautico`,
`sistema_control`, `tanque_especializado`, `sistema_refrigeracion`,
`aislamiento_termico`.

Y los `final_consumption` de alimentación derivados de subprocesos:
`mantequilla`, `yogur`, `chocolate`, `textiles` (además de `queso`, ya en seed).

---

*Fin del documento. Este catálogo es la referencia canónica para ampliar
`infra/seed-config.json`. Ante conflicto con el esquema, mandan `specs/schema.sql`
y la validación de `backend/src/seed/seed-config.ts`.*
