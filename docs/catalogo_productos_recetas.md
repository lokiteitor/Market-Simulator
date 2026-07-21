# Catálogo de Productos y Recetas

> **Proyecto:** Market-Simulator (Simulación de Mercado)
>
> **Versión:** 3.0 — cadena conexa con raíz única (155 productos / 156 recetas)
>
> **Estado:** Referencia canónica del catálogo **actual** de
> `infra/seed-config.json` + reglas para ampliarlo.
>
> **Nota histórica:** la v1.0 era la guía con la que se enrique­ció el catálogo
> agrícola original (trigo→harina→pan) hasta el catálogo industrial de la v2.0.
> La v3.0 (ADR-022) acabó con las 35 recetas sin insumos: el sector extractivo
> dejó de crear bienes de la nada y ahora consume agua, semillas, fertilizante y
> piensos como todo el mundo. Las tablas §3-§5 se generan del `seed-config.json`
> real con `backend/src/scripts/generate-catalog-artifacts.ts`.

---

## 1. Resumen del catálogo actual

- **155 productos**: 34 `raw_primary`, 78 `intermediate`, 43 `final_consumption`.
- **156 recetas**; todo producto tiene al menos una receta que lo produce y solo
  el `agua` tiene dos (pozo profundo y pozo somero).
- **16 tipos de instalación** (ADR-021), todos del rol `transformer`, el único
  rol productivo (ADR-022).

La cadena es un **grafo conexo y acíclico con una sola raíz**: lo único que nace
de la nada es el `agua`, que se extrae de pozos. A partir de ahí todo consume
algo — la minería y las canteras consumen agua, los cultivos agua + semillas +
fertilizante, la ganadería agua + piensos — y sigue hasta materiales básicos,
componentes y productos finales (vehículos, edificios, electrónica, alimentos).

Consecuencias de tener una sola raíz, que conviene tener presentes al tocar el
catálogo:

- **El arranque es en cascada**: agua → petróleo/gas/fosfato → fertilizantes →
  cultivos → piensos → ganadería. Son ~4 saltos; hasta que el agua no circula no
  produce nadie.
- **Los pozos de petróleo y gas no pueden consumir derivados del petróleo**: se
  cerraría un ciclo y el mundo no podría producir su primera unidad desde
  inventario cero. Por eso el combustible en las extractivas queda pospuesto a
  la fase de energía.
- El `oro` es además el producto-respaldo del patrón oro (`GOLD_PRODUCT_KEY`),
  con yacimiento finito (`resource_deposit`), y su coste de producción está
  acotado por la ventanilla del banco (ver §6).

---

## 2. Modelo de datos (contrato del catálogo)

El esquema real vive en `specs/schema.sql` (espejo en
`backend/src/db/schema.ts`). El seed se valida con Zod en
`backend/src/seed/seed-config.ts` (schema + integridad referencial completa).

### 2.1 `product`

| Campo (JSON seed) | Tipo  | Reglas                                                                  |
| ----------------- | ----- | ----------------------------------------------------------------------- |
| `key`             | texto | **Único**. Slug snake_case sin acentos; referencia interna de las recetas. |
| `name`            | texto | **Único**. Nombre humano en español.                                    |
| `unit`            | texto | Unidad libre: `kg`, `litro`, `unidad`, `m3`, …                          |
| `category`        | enum  | `raw_primary` \| `intermediate` \| `final_consumption`.                 |

- **`raw_primary`** — recurso natural extraído del entorno: minería, cantera,
  pozo, cultivo, cría, tala. Desde ADR-022 **también consume insumos** (agua y,
  en el agro, semillas/fertilizante/piensos); lo que lo define es que su receta
  saca materia del mundo, no que salga de la nada.
- **`intermediate`** — se fabrica a partir de otros productos y alimenta otras recetas.
- **`final_consumption`** — sumidero de la cadena: ninguna receta lo consume.

### 2.2 `recipe`

| Campo (JSON seed)         | Tipo   | Reglas                                                             |
| ------------------------- | ------ | ------------------------------------------------------------------ |
| `key`                     | texto  | Slug único de la receta.                                           |
| `name`                    | texto  | **Único**. Nombre humano del proceso.                              |
| `output`                  | texto  | `key` del **único** producto que produce (varias recetas pueden producir el mismo). |
| `installation_type`       | texto  | `key` del tipo de instalación que la habilita (ADR-021, **obligatorio**). |
| `output_qty_cent`         | entero | Cantidad producida por ejecución, en **centésimas** (>0).          |
| `duration_sim_seconds`    | entero | Duración de **una** ejecución en **segundos simulados** (>0).      |
| `wage_rate_cents_per_sec` | entero | Salario en centavos por segundo (≥0; en el catálogo actual 1–3).   |
| `inputs`                  | lista  | Cero o más `{ "product": <key>, "qty_cent": <entero > 0> }`.       |

**Restricciones duras (validadas por el seed):**

1. Una receta produce **exactamente un** producto; los subproductos se modelan
   como recetas paralelas que consumen la misma materia prima (p. ej.
   `planta_lactea`, `elab_mantequilla` y `elab_yogur` consumen `leche`).
2. Los insumos no se repiten dentro de una receta.
3. `qty_cent` está en centésimas de la unidad (`10000` = 100 kg/L; bienes
   discretos en `unidad` con 1 pieza = `100`).
4. El grafo receta→insumo es **acíclico** y tiene **una sola raíz**: las únicas
   recetas sin insumos son las dos del `agua`. Ambas invariantes las verifica
   `backend/tests/unit/seed/catalog-graph.test.ts`, no el validador del seed.
5. Cada receta declara un `installation_type` existente y debe estar listada en
   el array `recipes` de **ese mismo** tipo (cobertura exacta, sin huérfanas).
6. `duration` se persiste como INTERVAL en **tiempo simulado**; el salario
   corre en centavos por segundo **real** (sutileza `SIM_TIME_FACTOR`, ver
   CLAUDE.md).

### 2.3 `installation_types` (ADR-021)

Cada tipo agrupa recetas afines y es lo que el agente **compra/mejora** vía
`POST /agents/me/installations`. El `level` (hectáreas / líneas) es el
presupuesto de **concurrencia compartido** por las recetas del tipo. Precio del
nivel n: `floor(base_price × (growth_bps/10000)^n)` (`lib/installations.ts`),
acreditado al banco central vía `fee_ledger`.

| Campo JSON        | Reglas                                                    |
| ----------------- | --------------------------------------------------------- |
| `key`, `name`     | Únicos.                                                   |
| `role`            | Rol que puede comprarlo. Hoy siempre `transformer` (ADR-022); la columna sigue existiendo para que un `consumer` o un `trader` no puedan comprar instalaciones. |
| `unit_label`      | Etiqueta del nivel ("hectáreas", "líneas", …).            |
| `base_price_cents`| Precio del nivel 1 (centavos).                            |
| `growth_bps`      | Factor de crecimiento por nivel (17000 = ×1.7).           |
| `max_level`       | Nivel máximo comprable.                                   |
| `recipes`         | Keys de las recetas que habilita (cada receta en exactamente un tipo). |

> Los roles del seed (`roles.*`) hoy solo declaran `initial_agents`; las
> antiguas `capacities` por rol ya no existen — la capacidad productiva se
> compra como instalación (los agentes **nacen sin instalaciones**).

---

## 3. Tipos de instalación actuales

Los 16 tipos pertenecen al rol `transformer`, el único rol productivo (ADR-022).

| key | Nombre | Recetas | Precio base (¢) | Growth (bps) | Nivel máx |
| --- | ------ | ------- | --------------- | ------------ | --------- |
| `campo` | Campo agrícola | 11 | 15000 | 17000 | 10 |
| `granja` | Granja ganadera | 5 | 18000 | 17000 | 10 |
| `mina` | Mina | 10 | 30000 | 17000 | 10 |
| `cantera` | Cantera | 5 | 15000 | 17000 | 10 |
| `pozo` | Pozo de extracción | 2 | 30000 | 17000 | 10 |
| `bosque` | Bosque maderero | 1 | 15000 | 17000 | 10 |
| `pozo_agua` | Pozo de agua | 2 | 12000 | 17000 | 10 |
| `agroindustria` | Agroindustria alimentaria | 18 | 40000 | 17000 | 10 |
| `metalurgia` | Industria metalúrgica | 12 | 45000 | 17000 | 10 |
| `materiales` | Fábrica de materiales de construcción | 7 | 40000 | 17000 | 10 |
| `refineria` | Refinería petroquímica | 12 | 50000 | 17000 | 10 |
| `aserradero` | Aserradero y papelera | 6 | 38000 | 17000 | 10 |
| `electronica` | Planta de electrónica | 9 | 80000 | 17000 | 10 |
| `componentes` | Fábrica de componentes mecánicos | 21 | 70000 | 17000 | 10 |
| `ensamblaje` | Planta de ensamblaje final | 20 | 90000 | 17000 | 10 |
| `construccion` | Constructora de infraestructura | 15 | 90000 | 17000 | 10 |

## 4. Productos actuales

Formato: **key** · Nombre · Unidad · **precio base** (¢/unidad, derivado del coste; §6) · **Yacimiento** (ADR-023: ✔ = recurso no renovable con stock finito, cuyo rendimiento decae al vaciarse). (155 productos, 15 con yacimiento más el oro, que lo recibe del patrón oro.)

### 4.1 `raw_primary` — Recursos naturales extraídos

| key | Nombre | Unidad | Precio (¢) | Yacimiento |
| --- | ------ | ------ | ---------- | ---------- |
| `trigo` | Trigo | kg | 20 | — |
| `maiz` | Maíz | kg | 17 | — |
| `leche` | Leche | litro | 50 | — |
| `tomate` | Tomate | kg | 25 | — |
| `hierro` | Hierro | kg | 20 | ✔ |
| `carbon` | Carbón | kg | 20 | ✔ |
| `mineral_cobre` | Mineral de cobre | kg | 20 | ✔ |
| `bauxita` | Bauxita | kg | 20 | ✔ |
| `litio` | Litio | kg | 204 | ✔ |
| `niquel` | Níquel | kg | 34 | ✔ |
| `oro` | Oro | kg | 820 | — |
| `plata` | Plata | kg | 680 | ✔ |
| `uranio` | Uranio | kg | 1020 | ✔ |
| `arena` | Arena | kg | 10 | — |
| `piedra` | Piedra | kg | 10 | ✔ |
| `caliza` | Caliza | kg | 10 | ✔ |
| `arcilla` | Arcilla | kg | 10 | ✔ |
| `fosfato` | Fosfato | kg | 26 | ✔ |
| `sal` | Sal | kg | 13 | ✔ |
| `petroleo` | Petróleo | litro | 41 | ✔ |
| `gas_natural` | Gas natural | m3 | 51 | ✔ |
| `agua` | Agua | litro | 10 | — |
| `troncos` | Troncos | kg | 25 | — |
| `soya` | Soya | kg | 20 | — |
| `algodon` | Algodón | kg | 25 | — |
| `cana_azucar` | Caña de azúcar | kg | 17 | — |
| `cafe` | Café | kg | 51 | — |
| `cacao` | Cacao | kg | 51 | — |
| `frutas` | Frutas | kg | 19 | — |
| `verduras` | Verduras | kg | 19 | — |
| `ganado_bovino` | Ganado bovino | unidad | 2016 | — |
| `cerdos` | Cerdos | unidad | 1008 | — |
| `pollos` | Pollos | unidad | 101 | — |
| `lana` | Lana | kg | 50 | — |

### 4.2 `intermediate` — Bienes intermedios

| key | Nombre | Unidad | Precio (¢) | Yacimiento |
| --- | ------ | ------ | ---------- | ---------- |
| `semillas` | Semillas | kg | 26 | — |
| `harina` | Harina de trigo | kg | 70 | — |
| `masa` | Masa nixtamalizada | kg | 39 | — |
| `acero` | Acero | kg | 52 | — |
| `acero_inoxidable` | Acero inoxidable | kg | 102 | — |
| `aluminio` | Aluminio | kg | 83 | — |
| `cobre_refinado` | Cobre refinado | kg | 104 | — |
| `cemento` | Cemento | kg | 32 | — |
| `hormigon` | Hormigón | kg | 26 | — |
| `vidrio` | Vidrio | kg | 37 | — |
| `ladrillos` | Ladrillos | unidad | 20 | — |
| `asfalto` | Asfalto | kg | 46 | — |
| `plastico` | Plástico | kg | 78 | — |
| `caucho_sintetico` | Caucho sintético | kg | 78 | — |
| `fertilizantes` | Fertilizantes | kg | 65 | — |
| `productos_quimicos` | Productos químicos | litro | 63 | — |
| `silicio` | Silicio | kg | 135 | — |
| `tablas` | Tablas | kg | 57 | — |
| `celulosa` | Celulosa | kg | 57 | — |
| `papel` | Papel | kg | 87 | — |
| `carton` | Cartón | kg | 119 | — |
| `azucar` | Azúcar | kg | 79 | — |
| `aceite_vegetal` | Aceite vegetal | litro | 101 | — |
| `carne_procesada` | Carne procesada | kg | 84 | — |
| `lacteos` | Lácteos | kg | 91 | — |
| `gasolina` | Gasolina | litro | 94 | — |
| `diesel` | Diésel | litro | 94 | — |
| `queroseno` | Queroseno | litro | 118 | — |
| `lubricantes` | Lubricantes | litro | 157 | — |
| `viga_acero` | Vigas de acero | kg | 98 | — |
| `lamina_acero` | Láminas de acero | kg | 98 | — |
| `tubo_acero` | Tubos de acero | kg | 104 | — |
| `perfil_metalico` | Perfiles metálicos | kg | 98 | — |
| `lamina_aluminio` | Láminas de aluminio | kg | 151 | — |
| `perfil_aluminio` | Perfiles de aluminio | kg | 151 | — |
| `cable_cobre` | Cable de cobre | kg | 163 | — |
| `bobina_cobre` | Bobinas de cobre | kg | 175 | — |
| `cristal_plano` | Cristal plano | kg | 81 | — |
| `cristal_tecnico` | Cristal técnico | kg | 121 | — |
| `polimeros` | Polímeros | kg | 127 | — |
| `resinas` | Resinas | kg | 116 | — |
| `fibra_sintetica` | Fibra sintética | kg | 143 | — |
| `lubricante_industrial` | Lubricante industrial | litro | 214 | — |
| `madera_tratada` | Madera tratada | kg | 103 | — |
| `contrachapado` | Contrachapado | kg | 109 | — |
| `conservas` | Conservas | kg | 42 | — |
| `piensos` | Piensos | kg | 42 | — |
| `bebidas` | Bebidas | litro | 44 | — |
| `chasis` | Chasis | unidad | 29920 | — |
| `motor_combustion` | Motor de combustión | unidad | 36810 | — |
| `caja_cambios` | Caja de cambios | unidad | 20360 | — |
| `suspension` | Suspensión | unidad | 21660 | — |
| `frenos` | Frenos | unidad | 18280 | — |
| `rodamientos` | Rodamientos | unidad | 8880 | — |
| `bomba_industrial` | Bomba industrial | unidad | 21920 | — |
| `motor_electrico` | Motor eléctrico | unidad | 25800 | — |
| `transformador` | Transformador | unidad | 30860 | — |
| `generador` | Generador | unidad | 58210 | — |
| `bateria` | Batería | unidad | 23880 | — |
| `cableado` | Cableado | kg | 221 | — |
| `circuito_impreso` | Circuitos impresos | unidad | 18450 | — |
| `microchip` | Microchips | unidad | 41715 | — |
| `sensor` | Sensores | unidad | 34650 | — |
| `pantalla` | Pantallas | unidad | 38280 | — |
| `ventana` | Ventanas | unidad | 13460 | — |
| `puerta_industrial` | Puertas industriales | unidad | 11880 | — |
| `panel_prefabricado` | Panel prefabricado | unidad | 15020 | — |
| `tuberia` | Tuberías | kg | 188 | — |
| `asiento` | Asientos | unidad | 21530 | — |
| `panel_interior` | Paneles interiores | unidad | 15880 | — |
| `neumatico` | Neumáticos | unidad | 20100 | — |
| `turbina` | Turbina | unidad | 39840 | — |
| `sistema_hidraulico` | Sistema hidráulico | unidad | 46440 | — |
| `motor_aeronautico` | Motor aeronáutico | unidad | 80965 | — |
| `sistema_control` | Sistema de control | unidad | 173350 | — |
| `tanque_especializado` | Tanque especializado | unidad | 33160 | — |
| `sistema_refrigeracion` | Sistema de refrigeración | unidad | 48900 | — |
| `aislamiento_termico` | Aislamiento térmico | kg | 207 | — |

### 4.3 `final_consumption` — Productos finales

| key | Nombre | Unidad | Precio (¢) | Yacimiento |
| --- | ------ | ------ | ---------- | ---------- |
| `pan` | Pan | kg | 164 | — |
| `tortilla` | Tortilla | kg | 79 | — |
| `queso` | Queso fresco | kg | 2120 | — |
| `salsa` | Salsa de tomate | litro | 99 | — |
| `camion_carga` | Camión de carga | unidad | 501510 | — |
| `camion_cisterna` | Camión cisterna | unidad | 469760 | — |
| `camion_refrigerado` | Camión refrigerado | unidad | 469790 | — |
| `locomotora_diesel` | Locomotora diésel | unidad | 399900 | — |
| `vagon_carga` | Vagón de carga | unidad | 125980 | — |
| `barco_carga` | Barco de carga | unidad | 556220 | — |
| `barco_petrolero` | Barco petrolero | unidad | 677440 | — |
| `avion_carga` | Avión de carga | unidad | 624780 | — |
| `planta_industrial` | Planta industrial genérica | unidad | 119220 | — |
| `refineria` | Refinería de petróleo | unidad | 529980 | — |
| `central_electrica` | Central eléctrica | unidad | 287800 | — |
| `planta_ensamblaje` | Planta de ensamblaje automotriz | unidad | 459620 | — |
| `astillero` | Astillero | unidad | 341030 | — |
| `fabrica_aeronaves` | Fábrica de aeronaves | unidad | 403960 | — |
| `planta_quimica` | Planta química | unidad | 497660 | — |
| `estacion_carga` | Estación de carga | unidad | 72450 | — |
| `terminal_ferroviaria` | Terminal ferroviaria | unidad | 413950 | — |
| `puerto_comercial` | Puerto comercial | unidad | 182360 | — |
| `aeropuerto_carga` | Aeropuerto de carga | unidad | 609530 | — |
| `automovil` | Automóvil | unidad | 423835 | — |
| `refrigerador` | Refrigerador | unidad | 88980 | — |
| `lavadora` | Lavadora | unidad | 223350 | — |
| `televisor` | Televisor | unidad | 79890 | — |
| `computadora` | Computadora | unidad | 145390 | — |
| `telefono` | Teléfono | unidad | 138525 | — |
| `excavadora` | Excavadora | unidad | 370040 | — |
| `grua` | Grúa | unidad | 196690 | — |
| `generador_industrial` | Generador industrial | unidad | 104560 | — |
| `panel_solar` | Panel solar | unidad | 46380 | — |
| `turbina_eolica` | Turbina eólica | unidad | 277590 | — |
| `transformador_electrico` | Transformador eléctrico | unidad | 76780 | — |
| `edificio_residencial` | Edificio residencial | unidad | 152700 | — |
| `edificio_comercial` | Edificio comercial | unidad | 215120 | — |
| `fabrica_urbana_ligera` | Fábrica urbana ligera | unidad | 238020 | — |
| `almacen_logistico` | Almacén logístico | unidad | 101410 | — |
| `mantequilla` | Mantequilla | kg | 340 | — |
| `yogur` | Yogur | litro | 89 | — |
| `chocolate` | Chocolate | kg | 159 | — |
| `textiles` | Textiles | kg | 105 | — |

## 5. Recetas actuales (agrupadas por tipo de instalación)

Formato: **key** · Nombre · Salida (`output` × `output_qty_cent`) · Duración
(segundos simulados) · Salario (¢/s) · **Coste** de una ejecución (¢, insumos +
salario) y **qué fracción de ese coste son insumos** · Insumos (`key×qty_cent`).
Las dos únicas recetas sin insumos (—, cuota 0%) son las del agua, la raíz del
catálogo.

### 5.1 `campo` — Campo agrícola

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `cultivo_trigo` | Cultivo de trigo | `trigo` | 50000 | 7200 | 1 | 10195 | 29% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_maiz` | Cultivo de maíz | `maiz` | 60000 | 7200 | 1 | 10195 | 29% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_tomate` | Cultivo de tomate | `tomate` | 30000 | 5400 | 1 | 7605 | 29% | `agua`×11000, `semillas`×1500, `fertilizantes`×1100 |
| `cultivo_soya` | Cultivo de soya | `soya` | 50000 | 7200 | 1 | 10195 | 29% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_algodon` | Cultivo de algodón | `algodon` | 40000 | 7200 | 1 | 10195 | 29% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_cana` | Cultivo de caña de azúcar | `cana_azucar` | 60000 | 7200 | 1 | 10195 | 29% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_cafe` | Cultivo de café | `cafe` | 20000 | 7200 | 1 | 10195 | 29% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_cacao` | Cultivo de cacao | `cacao` | 20000 | 7200 | 1 | 10195 | 29% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cosecha_frutas` | Cosecha de frutas | `frutas` | 40000 | 5400 | 1 | 7605 | 29% | `agua`×11000, `semillas`×1500, `fertilizantes`×1100 |
| `cosecha_verduras` | Cosecha de verduras | `verduras` | 40000 | 5400 | 1 | 7605 | 29% | `agua`×11000, `semillas`×1500, `fertilizantes`×1100 |
| `vivero_semillas` | Vivero de semillas | `semillas` | 5000 | 900 | 1 | 1300 | 31% | `agua`×4000 |

### 5.2 `granja` — Granja ganadera

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `ordena` | Ordeña de vacas | `leche` | 20000 | 3600 | 2 | 10080 | 29% | `agua`×12000, `piensos`×4000 |
| `esquila` | Esquila de lana | `lana` | 10000 | 3600 | 1 | 5040 | 29% | `agua`×6000, `piensos`×2000 |
| `cria_bovino` | Cría de ganado bovino | `ganado_bovino` | 1000 | 7200 | 2 | 20160 | 29% | `agua`×24000, `piensos`×8000 |
| `cria_cerdos` | Cría de cerdos | `cerdos` | 2000 | 7200 | 2 | 20160 | 29% | `agua`×24000, `piensos`×8000 |
| `cria_pollos` | Cría de pollos | `pollos` | 5000 | 3600 | 1 | 5040 | 29% | `agua`×6000, `piensos`×2000 |

### 5.3 `mina` — Mina

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `mineria_hierro` | Minería de hierro | `hierro` | 50000 | 7200 | 1 | 10200 | 29% | `agua`×30000 |
| `mineria_carbon` | Minería de carbón | `carbon` | 50000 | 7200 | 1 | 10200 | 29% | `agua`×30000 |
| `mineria_cobre` | Minería de cobre | `mineral_cobre` | 50000 | 7200 | 1 | 10200 | 29% | `agua`×30000 |
| `mineria_bauxita` | Minería de bauxita | `bauxita` | 50000 | 7200 | 1 | 10200 | 29% | `agua`×30000 |
| `mineria_litio` | Minería de litio | `litio` | 10000 | 7200 | 2 | 20400 | 29% | `agua`×60000 |
| `mineria_niquel` | Minería de níquel | `niquel` | 30000 | 7200 | 1 | 10200 | 29% | `agua`×30000 |
| `mineria_oro` | Minería de oro | `oro` | 2000 | 7200 | 2 | 16400 | 12% | `agua`×20000 |
| `mineria_plata` | Minería de plata | `plata` | 3000 | 7200 | 2 | 20400 | 29% | `agua`×60000 |
| `mineria_uranio` | Minería de uranio | `uranio` | 2000 | 7200 | 2 | 20400 | 29% | `agua`×60000 |
| `mineria_fosfato` | Minería de fosfato | `fosfato` | 40000 | 7200 | 1 | 10200 | 29% | `agua`×30000 |

### 5.4 `cantera` — Cantera

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `cantera_caliza` | Cantera de caliza | `caliza` | 50000 | 3600 | 1 | 5100 | 29% | `agua`×15000 |
| `cantera_piedra` | Cantera de piedra | `piedra` | 50000 | 3600 | 1 | 5100 | 29% | `agua`×15000 |
| `extraccion_arcilla` | Extracción de arcilla | `arcilla` | 50000 | 3600 | 1 | 5100 | 29% | `agua`×15000 |
| `extraccion_arena` | Extracción de arena | `arena` | 50000 | 3600 | 1 | 5100 | 29% | `agua`×15000 |
| `extraccion_sal` | Extracción de sal | `sal` | 40000 | 3600 | 1 | 5100 | 29% | `agua`×15000 |

### 5.5 `pozo` — Pozo de extracción

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `pozo_petroleo` | Pozo petrolero | `petroleo` | 50000 | 7200 | 2 | 20400 | 29% | `agua`×60000 |
| `pozo_gas` | Pozo de gas | `gas_natural` | 40000 | 7200 | 2 | 20400 | 29% | `agua`×60000 |

### 5.6 `bosque` — Bosque maderero

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `tala` | Tala de árboles | `troncos` | 40000 | 7200 | 1 | 10090 | 29% | `agua`×25000, `semillas`×1500 |

### 5.7 `pozo_agua` — Pozo de agua

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `pozo_agua_profundo` | Pozo de agua profundo | `agua` | 36000 | 1800 | 2 | 3600 | 0% | — |
| `pozo_somero` | Pozo somero | `agua` | 1200 | 60 | 2 | 120 | 0% | — |

### 5.8 `agroindustria` — Agroindustria alimentaria

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `molienda` | Molienda de trigo | `harina` | 8000 | 1800 | 2 | 5600 | 36% | `trigo`×10000 |
| `panaderia` | Panadería | `pan` | 10000 | 3600 | 3 | 16400 | 34% | `harina`×8000 |
| `nixtamalizado` | Nixtamalizado de maíz | `masa` | 18000 | 2700 | 2 | 7100 | 24% | `maiz`×10000 |
| `tortilleria` | Tortillería | `tortilla` | 9500 | 1800 | 2 | 7500 | 52% | `masa`×10000 |
| `queseria` | Quesería | `queso` | 1000 | 5400 | 3 | 21200 | 24% | `leche`×10000 |
| `salseria` | Salsería | `salsa` | 8000 | 2700 | 2 | 7900 | 32% | `tomate`×10000 |
| `planta_lactea` | Planta láctea | `lacteos` | 30000 | 3600 | 2 | 27200 | 74% | `leche`×40000 |
| `elab_mantequilla` | Elaboración de mantequilla | `mantequilla` | 8000 | 3600 | 2 | 27200 | 74% | `leche`×40000 |
| `elab_yogur` | Elaboración de yogur | `yogur` | 25000 | 3600 | 2 | 22200 | 68% | `leche`×30000 |
| `elab_chocolate` | Elaboración de chocolate | `chocolate` | 20000 | 5400 | 3 | 31750 | 49% | `cacao`×15000, `azucar`×10000 |
| `refino_azucar` | Refino de azúcar | `azucar` | 20000 | 3600 | 2 | 15700 | 54% | `cana_azucar`×50000 |
| `prensado_aceite` | Prensado de aceite vegetal | `aceite_vegetal` | 15000 | 3600 | 2 | 15200 | 53% | `soya`×40000 |
| `procesado_carne` | Procesado de carne | `carne_procesada` | 25000 | 3600 | 3 | 20880 | 48% | `ganado_bovino`×500 |
| `produccion_piensos` | Producción de piensos | `piensos` | 35000 | 3600 | 2 | 14600 | 51% | `maiz`×20000, `soya`×20000 |
| `embotellado_bebidas` | Embotellado de bebidas | `bebidas` | 35000 | 3600 | 2 | 15400 | 53% | `agua`×3000, `azucar`×10000 |
| `enlatado_conservas` | Enlatado de conservas | `conservas` | 35000 | 3600 | 2 | 14800 | 51% | `frutas`×20000, `verduras`×20000 |
| `hilado_fibra` | Hilado de fibra sintética | `fibra_sintetica` | 16000 | 3600 | 2 | 22800 | 68% | `plastico`×20000 |
| `elab_textiles` | Elaboración de textiles | `textiles` | 15000 | 5400 | 2 | 15800 | 32% | `algodon`×20000 |

### 5.9 `metalurgia` — Industria metalúrgica

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `fundicion_acero` | Fundición de acero | `acero` | 40000 | 5400 | 2 | 20800 | 48% | `hierro`×40000, `carbon`×10000 |
| `fundicion_inox` | Fundición de acero inoxidable | `acero_inoxidable` | 38000 | 5400 | 3 | 38700 | 58% | `acero`×40000, `niquel`×5000 |
| `refino_aluminio` | Refino de aluminio | `aluminio` | 25000 | 5400 | 2 | 20800 | 48% | `bauxita`×50000 |
| `refino_cobre` | Refino de cobre | `cobre_refinado` | 20000 | 5400 | 2 | 20800 | 48% | `mineral_cobre`×50000 |
| `laminado_aluminio` | Laminado de aluminio | `lamina_aluminio` | 13000 | 3600 | 2 | 19650 | 63% | `aluminio`×15000 |
| `laminado_lamina` | Laminado de láminas de acero | `lamina_acero` | 18000 | 3600 | 2 | 17600 | 59% | `acero`×20000 |
| `laminado_viga` | Laminado de vigas | `viga_acero` | 18000 | 3600 | 2 | 17600 | 59% | `acero`×20000 |
| `perfilado_aluminio` | Perfilado de aluminio | `perfil_aluminio` | 13000 | 3600 | 2 | 19650 | 63% | `aluminio`×15000 |
| `perfilado_metal` | Perfilado metálico | `perfil_metalico` | 18000 | 3600 | 2 | 17600 | 59% | `acero`×20000 |
| `extrusion_tubo` | Extrusión de tubos | `tubo_acero` | 17000 | 3600 | 2 | 17600 | 59% | `acero`×20000 |
| `trefilado_cable` | Trefilado de cable de cobre | `cable_cobre` | 14000 | 3600 | 2 | 22800 | 68% | `cobre_refinado`×15000 |
| `bobinado_cobre` | Bobinado de cobre | `bobina_cobre` | 13000 | 3600 | 2 | 22800 | 68% | `cobre_refinado`×15000 |

### 5.10 `materiales` — Fábrica de materiales de construcción

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `fundicion_vidrio` | Fundición de vidrio | `vidrio` | 30000 | 3600 | 2 | 11200 | 36% | `arena`×40000 |
| `templado_cristal` | Templado de cristal plano | `cristal_plano` | 18000 | 3600 | 2 | 14600 | 51% | `vidrio`×20000 |
| `produccion_cristal_tecnico` | Producción de cristal técnico | `cristal_tecnico` | 15000 | 3600 | 3 | 18200 | 41% | `vidrio`×20000 |
| `coccion_ladrillos` | Cocción de ladrillos | `ladrillos` | 50000 | 3600 | 2 | 10200 | 29% | `arcilla`×30000 |
| `produccion_cemento` | Producción de cemento | `cemento` | 35000 | 3600 | 2 | 11200 | 36% | `caliza`×40000 |
| `mezcla_hormigon` | Mezcla de hormigón | `hormigon` | 40000 | 1800 | 2 | 10500 | 66% | `cemento`×15000, `arena`×20000, `agua`×1000 |
| `produccion_asfalto` | Producción de asfalto | `asfalto` | 40000 | 3600 | 2 | 18400 | 61% | `petroleo`×20000, `piedra`×30000 |

### 5.11 `refineria` — Refinería petroquímica

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `refino_diesel` | Refino de diésel | `diesel` | 25000 | 3600 | 2 | 23600 | 69% | `petroleo`×40000 |
| `refino_gasolina` | Refino de gasolina | `gasolina` | 25000 | 3600 | 2 | 23600 | 69% | `petroleo`×40000 |
| `refino_queroseno` | Refino de queroseno | `queroseno` | 20000 | 3600 | 2 | 23600 | 69% | `petroleo`×40000 |
| `refino_lubricantes` | Refino de lubricantes | `lubricantes` | 15000 | 3600 | 2 | 23600 | 69% | `petroleo`×40000 |
| `produccion_lubricante_ind` | Producción de lubricante industrial | `lubricante_industrial` | 18000 | 3600 | 2 | 38600 | 81% | `lubricantes`×20000 |
| `sintesis_caucho` | Síntesis de caucho | `caucho_sintetico` | 25000 | 3600 | 2 | 19500 | 63% | `petroleo`×30000 |
| `sintesis_plastico` | Síntesis de plástico | `plastico` | 25000 | 3600 | 2 | 19500 | 63% | `petroleo`×30000 |
| `sintesis_quimicos` | Síntesis de productos químicos | `productos_quimicos` | 30000 | 3600 | 2 | 18750 | 62% | `petroleo`×25000, `sal`×10000 |
| `polimerizacion` | Polimerización | `polimeros` | 18000 | 3600 | 2 | 22800 | 68% | `plastico`×20000 |
| `produccion_resinas` | Producción de resinas | `resinas` | 17000 | 3600 | 2 | 19800 | 64% | `productos_quimicos`×20000 |
| `produccion_fertilizantes` | Producción de fertilizantes | `fertilizantes` | 35000 | 3600 | 2 | 22600 | 68% | `gas_natural`×20000, `fosfato`×20000 |
| `produccion_silicio` | Producción de silicio | `silicio` | 15000 | 5400 | 3 | 20200 | 20% | `arena`×40000 |

### 5.12 `aserradero` — Aserradero y papelera

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `aserrado` | Aserradero | `tablas` | 30000 | 3600 | 2 | 17200 | 58% | `troncos`×40000 |
| `tratado_madera` | Tratado de madera | `madera_tratada` | 18000 | 3600 | 2 | 18600 | 61% | `tablas`×20000 |
| `produccion_contrachapado` | Producción de contrachapado | `contrachapado` | 17000 | 3600 | 2 | 18600 | 61% | `tablas`×20000 |
| `produccion_celulosa` | Producción de celulosa | `celulosa` | 30000 | 3600 | 2 | 17200 | 58% | `troncos`×40000 |
| `produccion_papel` | Producción de papel | `papel` | 28000 | 3600 | 2 | 24300 | 70% | `celulosa`×30000 |
| `produccion_carton` | Producción de cartón | `carton` | 28000 | 3600 | 2 | 33300 | 78% | `papel`×30000 |

### 5.13 `electronica` — Planta de electrónica

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `ensamble_circuito` | Ensamblaje de circuitos impresos | `circuito_impreso` | 100 | 5400 | 3 | 18450 | 12% | `oro`×100, `cobre_refinado`×1000, `plastico`×500 |
| `ensamble_microchip` | Fabricación de microchips | `microchip` | 100 | 7200 | 3 | 41715 | 48% | `circuito_impreso`×100, `productos_quimicos`×500, `silicio`×1000 |
| `ensamble_sensor` | Fabricación de sensores | `sensor` | 100 | 5400 | 3 | 34650 | 53% | `circuito_impreso`×100 |
| `ensamble_pantalla` | Fabricación de pantallas | `pantalla` | 100 | 5400 | 3 | 38280 | 58% | `cristal_tecnico`×3000, `circuito_impreso`×100 |
| `ensamble_cableado` | Ensamblaje de cableado | `cableado` | 8000 | 3600 | 2 | 17690 | 59% | `cable_cobre`×5000, `plastico`×3000 |
| `ensamble_bateria` | Ensamblaje de batería | `bateria` | 100 | 5400 | 3 | 23880 | 32% | `litio`×3000, `plastico`×2000 |
| `ensamble_transformador` | Ensamblaje de transformador | `transformador` | 100 | 5400 | 3 | 30860 | 48% | `bobina_cobre`×6000, `acero`×8000 |
| `ensamble_motor_elec` | Ensamblaje de motor eléctrico | `motor_electrico` | 100 | 5400 | 3 | 25800 | 37% | `bobina_cobre`×4000, `acero`×5000 |
| `ensamble_control` | Ensamblaje de sistema de control | `sistema_control` | 100 | 5400 | 3 | 173350 | 91% | `microchip`×200, `sensor`×200, `cableado`×2000 |

### 5.14 `componentes` — Fábrica de componentes mecánicos

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `ensamble_motor` | Ensamblaje de motor de combustión | `motor_combustion` | 100 | 7200 | 3 | 36810 | 41% | `acero`×15000, `aluminio`×5000, `cable_cobre`×2000 |
| `ensamble_motor_aero` | Ensamblaje de motor aeronáutico | `motor_aeronautico` | 100 | 7200 | 3 | 80965 | 73% | `aluminio`×15000, `acero`×10000, `microchip`×100 |
| `ensamble_chasis` | Ensamblaje de chasis | `chasis` | 100 | 5400 | 3 | 29920 | 46% | `viga_acero`×8000, `lamina_acero`×6000 |
| `ensamble_caja` | Ensamblaje de caja de cambios | `caja_cambios` | 100 | 5400 | 3 | 20360 | 20% | `acero`×8000 |
| `ensamble_frenos` | Ensamblaje de frenos | `frenos` | 100 | 5400 | 3 | 18280 | 11% | `acero`×4000 |
| `ensamble_suspension` | Ensamblaje de suspensión | `suspension` | 100 | 5400 | 3 | 21660 | 25% | `acero`×6000, `caucho_sintetico`×3000 |
| `ensamble_rodamientos` | Ensamblaje de rodamientos | `rodamientos` | 200 | 5400 | 3 | 17760 | 9% | `acero`×3000 |
| `ensamble_bomba` | Ensamblaje de bomba industrial | `bomba_industrial` | 100 | 5400 | 3 | 21920 | 26% | `acero`×5000, `tubo_acero`×3000 |
| `ensamble_hidraulico` | Ensamblaje de sistema hidráulico | `sistema_hidraulico` | 100 | 5400 | 3 | 46440 | 65% | `acero`×8000, `tubo_acero`×4000, `bomba_industrial`×100 |
| `ensamble_neumatico` | Fabricación de neumáticos | `neumatico` | 100 | 5400 | 3 | 20100 | 19% | `caucho_sintetico`×5000 |
| `ensamble_turbina` | Ensamblaje de turbina | `turbina` | 100 | 7200 | 3 | 39840 | 46% | `acero`×20000, `perfil_metalico`×8000 |
| `ensamble_generador` | Ensamblaje de generador | `generador` | 100 | 5400 | 3 | 58210 | 72% | `motor_combustion`×100, `acero`×10000 |
| `ensamble_tanque` | Fabricación de tanque especializado | `tanque_especializado` | 100 | 5400 | 3 | 33160 | 51% | `lamina_acero`×12000, `tubo_acero`×5000 |
| `ensamble_tuberia` | Fabricación de tuberías | `tuberia` | 8000 | 3600 | 2 | 15000 | 52% | `tubo_acero`×6000, `plastico`×2000 |
| `ensamble_asiento` | Fabricación de asientos | `asiento` | 100 | 5400 | 3 | 21530 | 25% | `fibra_sintetica`×3000, `acero`×2000 |
| `ensamble_panel_int` | Fabricación de paneles interiores | `panel_interior` | 100 | 5400 | 2 | 15880 | 32% | `polimeros`×4000 |
| `ensamble_panel_pref` | Fabricación de panel prefabricado | `panel_prefabricado` | 100 | 3600 | 2 | 15020 | 52% | `hormigon`×15000, `viga_acero`×4000 |
| `ensamble_puerta` | Fabricación de puertas industriales | `puerta_industrial` | 100 | 3600 | 2 | 11880 | 39% | `acero`×6000, `plastico`×2000 |
| `ensamble_ventana` | Fabricación de ventanas | `ventana` | 100 | 3600 | 2 | 13460 | 47% | `cristal_plano`×4000, `perfil_aluminio`×2000 |
| `ensamble_aislamiento` | Producción de aislamiento térmico | `aislamiento_termico` | 10000 | 3600 | 2 | 20700 | 65% | `polimeros`×5000, `fibra_sintetica`×5000 |
| `ensamble_refrig` | Ensamblaje de sistema de refrigeración | `sistema_refrigeracion` | 100 | 5400 | 3 | 48900 | 67% | `motor_electrico`×100, `tuberia`×3000, `productos_quimicos`×2000 |

### 5.15 `ensamblaje` — Planta de ensamblaje final

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `fab_automovil` | Fabricación de automóvil | `automovil` | 100 | 14400 | 3 | 423835 | 90% | `chasis`×100, `motor_combustion`×100, `sistema_control`×100, `cristal_plano`×1500, `neumatico`×400, `asiento`×200, `panel_interior`×100 |
| `fab_avion` | Fabricación de avión de carga | `avion_carga` | 100 | 21600 | 3 | 624780 | 90% | `lamina_aluminio`×30000, `motor_aeronautico`×200, `sistema_control`×200, `cristal_tecnico`×5000 |
| `fab_barco_carga` | Fabricación de barco de carga | `barco_carga` | 100 | 21600 | 3 | 556220 | 88% | `viga_acero`×50000, `motor_combustion`×200, `sistema_control`×200, `cableado`×10000 |
| `fab_barco_petrolero` | Fabricación de barco petrolero | `barco_petrolero` | 100 | 21600 | 3 | 677440 | 90% | `viga_acero`×50000, `motor_combustion`×200, `tanque_especializado`×300, `bomba_industrial`×200, `sistema_control`×200 |
| `fab_camion_carga` | Fabricación de camión de carga | `camion_carga` | 100 | 18000 | 3 | 501510 | 89% | `chasis`×100, `motor_combustion`×100, `caja_cambios`×100, `suspension`×100, `frenos`×200, `neumatico`×600, `cableado`×3000, `sistema_control`×100, `cristal_plano`×2000 |
| `fab_camion_cisterna` | Fabricación de camión cisterna | `camion_cisterna` | 100 | 18000 | 3 | 469760 | 89% | `chasis`×100, `motor_combustion`×100, `tanque_especializado`×100, `bomba_industrial`×100, `neumatico`×600, `sistema_control`×100 |
| `fab_camion_refrigerado` | Fabricación de camión refrigerado | `camion_refrigerado` | 100 | 18000 | 3 | 469790 | 89% | `chasis`×100, `motor_combustion`×100, `sistema_refrigeracion`×100, `aislamiento_termico`×3000, `neumatico`×600, `sistema_control`×100 |
| `fab_computadora` | Fabricación de computadora | `computadora` | 100 | 7200 | 3 | 145390 | 85% | `microchip`×200, `pantalla`×100, `plastico`×2000, `cobre_refinado`×500 |
| `fab_excavadora` | Fabricación de excavadora | `excavadora` | 100 | 18000 | 3 | 370040 | 85% | `acero`×25000, `motor_combustion`×100, `sistema_hidraulico`×200, `sistema_control`×100 |
| `fab_generador_ind` | Fabricación de generador industrial | `generador_industrial` | 100 | 10800 | 3 | 104560 | 69% | `acero`×10000, `bobina_cobre`×5000, `generador`×100 |
| `fab_grua` | Fabricación de grúa | `grua` | 100 | 18000 | 3 | 196690 | 73% | `acero`×25000, `motor_combustion`×100, `sistema_hidraulico`×200 |
| `fab_lavadora` | Fabricación de lavadora | `lavadora` | 100 | 7200 | 3 | 223350 | 90% | `acero`×5000, `motor_electrico`×100, `sistema_control`×100 |
| `fab_locomotora` | Fabricación de locomotora diésel | `locomotora_diesel` | 100 | 21600 | 3 | 399900 | 84% | `motor_combustion`×200, `chasis`×100, `sistema_control`×100, `generador`×100 |
| `fab_panel_solar` | Fabricación de panel solar | `panel_solar` | 100 | 7200 | 3 | 46380 | 53% | `cristal_tecnico`×3000, `silicio`×2000, `circuito_impreso`×100 |
| `fab_refrigerador` | Fabricación de refrigerador | `refrigerador` | 100 | 7200 | 3 | 88980 | 76% | `acero`×5000, `sistema_refrigeracion`×100, `panel_interior`×100 |
| `fab_telefono` | Fabricación de teléfono | `telefono` | 100 | 5400 | 3 | 138525 | 88% | `microchip`×100, `pantalla`×100, `bateria`×100, `circuito_impreso`×100 |
| `fab_televisor` | Fabricación de televisor | `televisor` | 100 | 7200 | 3 | 79890 | 73% | `pantalla`×100, `circuito_impreso`×100, `plastico`×2000 |
| `fab_transformador_elec` | Fabricación de transformador eléctrico | `transformador_electrico` | 100 | 10800 | 3 | 76780 | 58% | `cobre_refinado`×8000, `acero`×10000, `transformador`×100 |
| `fab_turbina_eolica` | Fabricación de turbina eólica | `turbina_eolica` | 100 | 18000 | 3 | 277590 | 81% | `turbina`×100, `acero`×20000, `sistema_control`×100 |
| `fab_vagon` | Fabricación de vagón de carga | `vagon_carga` | 100 | 10800 | 3 | 125980 | 74% | `viga_acero`×15000, `rodamientos`×800, `perfil_metalico`×8000 |

### 5.16 `construccion` — Constructora de infraestructura

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `constr_aeropuerto` | Construcción de aeropuerto de carga | `aeropuerto_carga` | 100 | 14400 | 3 | 609530 | 93% | `hormigon`×50000, `acero`×30000, `sistema_control`×300, `cableado`×8000 |
| `constr_almacen` | Construcción de almacén logístico | `almacen_logistico` | 100 | 14400 | 3 | 101410 | 57% | `hormigon`×40000, `acero`×25000, `cableado`×5000, `puerta_industrial`×200 |
| `constr_astillero` | Construcción de astillero | `astillero` | 100 | 18000 | 3 | 341030 | 84% | `acero`×40000, `sistema_hidraulico`×200, `sistema_control`×100 |
| `constr_central_electrica` | Construcción de central eléctrica | `central_electrica` | 100 | 18000 | 3 | 287800 | 81% | `turbina`×200, `generador`×200, `acero`×30000, `cableado`×10000 |
| `constr_edificio_com` | Construcción de edificio comercial | `edificio_comercial` | 100 | 14400 | 3 | 215120 | 80% | `hormigon`×60000, `acero`×25000, `ventana`×800, `puerta_industrial`×300 |
| `constr_edificio_res` | Construcción de edificio residencial | `edificio_residencial` | 100 | 14400 | 3 | 152700 | 72% | `hormigon`×60000, `acero`×20000, `ventana`×500, `cableado`×5000, `madera_tratada`×5000 |
| `constr_estacion` | Construcción de estación de carga | `estacion_carga` | 100 | 14400 | 3 | 72450 | 40% | `acero`×20000, `hormigon`×30000, `cableado`×5000 |
| `constr_fabrica_aeronaves` | Construcción de fábrica de aeronaves | `fabrica_aeronaves` | 100 | 18000 | 3 | 403960 | 87% | `aluminio`×30000, `microchip`×500, `motor_aeronautico`×100, `rodamientos`×400 |
| `constr_fabrica_ligera` | Construcción de fábrica urbana ligera | `fabrica_urbana_ligera` | 100 | 14400 | 3 | 238020 | 82% | `acero`×20000, `hormigon`×30000, `sistema_control`×100, `contrachapado`×3000 |
| `constr_planta_ensamblaje` | Construcción de planta de ensamblaje | `planta_ensamblaje` | 100 | 18000 | 3 | 459620 | 88% | `acero`×30000, `sistema_control`×200, `rodamientos`×400, `hormigon`×30000 |
| `constr_planta_industrial` | Construcción de planta industrial | `planta_industrial` | 100 | 18000 | 3 | 119220 | 55% | `acero`×30000, `hormigon`×40000, `vidrio`×10000, `rodamientos`×400 |
| `constr_planta_quimica` | Construcción de planta química | `planta_quimica` | 100 | 18000 | 3 | 497660 | 89% | `acero`×30000, `tubo_acero`×15000, `bomba_industrial`×300, `sistema_control`×200 |
| `constr_puerto` | Construcción de puerto comercial | `puerto_comercial` | 100 | 14400 | 3 | 182360 | 76% | `hormigon`×50000, `acero`×30000, `sistema_hidraulico`×200, `cableado`×8000 |
| `constr_refineria` | Construcción de refinería | `refineria` | 100 | 18000 | 3 | 529980 | 90% | `acero`×40000, `tubo_acero`×20000, `sistema_control`×200, `bomba_industrial`×400 |
| `constr_terminal` | Construcción de terminal ferroviaria | `terminal_ferroviaria` | 100 | 14400 | 3 | 413950 | 90% | `acero`×25000, `sistema_control`×200, `cableado`×5000 |

---

## 6. Guía de parámetros numéricos (para ampliar el catálogo)

Rangos observados en el catálogo actual; mantenerlos al añadir recetas.

- **`qty_cent`**: todo en centésimas (`10000` = 100 kg/L). Bienes discretos en
  `unidad` con 1 pieza = `100`.
- **Rendimiento**: transformaciones continuas con merma realista (p. ej.
  `fundicion_acero`: 500 kg de insumos → 400 kg de acero). Ensamblajes
  discretos: varios insumos → `output_qty_cent: 100` (1 pieza).
- **Duración** (`duration_sim_seconds`): extracción 1800–7200; básicos e
  industriales 1800–5400; componentes 3600–7200; finales 5400–21600 (locomotora,
  barcos y avión en el tope). Excepción: `pozo_somero` (60 s) es la receta rápida
  de los tests E2E, que exigen un proceso sin insumos que termine en segundos.
- **Salario** (`wage_rate_cents_per_sec`): 1 extracción simple, 2 transformación
  intermedia, 3 componentes/ensamblaje/procesos intensivos.
- **Cuota de insumos de las extractivas**: entre el **25% y el 35%** del coste de
  ejecución (insumos + salario). Son proporciones de juego, no realistas: con
  ratios reales (1.500 L de agua por kg de trigo) el agua sería el 90% de la
  economía. La banda la verifica `catalog-graph.test.ts`.
- **Excepción del oro**: `mineria_oro` va deliberadamente al ~12% (820 ¢/kg en
  vez de los ~1.030 que saldrían con la cuota normal). Su coste unitario tiene
  que quedar por debajo del `window_bid` del banco central o minar deja de ser
  rentable, **se para la acuñación** y los registros dinámicos empiezan a fallar
  con `insufficient_gold_backing`. Con el `.env` actual hay margen de sobra
  (window_bid ~190.000-353.000 ¢/kg, dominado por
  `GOLD_BANK_INITIAL_CAPITAL_CENTS`), pero es la restricción a revisar si se
  toca cualquiera de los dos lados. Ver `infra/.env.docker`.
- **`finite` (yacimientos, ADR-023)**: marca un recurso como **no renovable**;
  el seed le da un `resource_deposit` y su rendimiento decae al vaciarse. Solo
  para recursos geológicos (`mina`, `cantera`, `pozo`) y con **una sola receta**
  que los produzca — con dos, la conversión de `DEPOSIT_MIN/MAX_EXECUTIONS` a
  centésimas sería ambigua y `parseSeedConfig` lo rechaza. **Nunca** marcar el
  `agua` (raíz del grafo: la consumen 36 recetas, agotarla apaga la economía) ni
  el `oro` (su yacimiento sale de `GOLD_DEPOSIT_*`). El conjunto exacto lo fija
  `catalog-graph.test.ts`, para que ampliarlo sea una decisión y no un descuido.
- **Coherencia económica**: el coste acumulado (insumos + salario) debe crecer a
  lo largo de la cadena; un producto final depende (directa o indirectamente) de
  ≥3 cadenas distintas.
- **Granularidad del precio**: el precio es un **entero de céntimos**, así que un
  producto cuyo coste unitario cae en 1-2 ¢ no puede tener mercado — el vendedor
  solo puede cotizar su propio coste o el doble, y el bid del comprador
  (`fair × 0.97`) redondea a 0 y se descarta. Elegir `output_qty_cent` para que
  el precio derivado quede **por encima de ~10 ¢**: el agua se ajustó a 10 ¢/L
  justo por esto (a 1 ¢/L su libro se quedaba con las dos puntas sin cruzarse).
- **`precio base = coste`**: la propagación no añade margen en ningún eslabón, así
  que a precios base **ninguna receta es rentable** (`revenue == coste` por
  construcción). El margen entra en el sistema por el lado del consumidor, que
  paga sobre el precio base (`tolerance` 1.05-1.4), y se propaga hacia abajo a
  medida que el tape mueve los *fair values*. Es una propiedad deliberada —
  mantiene el equilibrio del flujo circular de ADR-020, donde los salarios son
  aproximadamente el valor de la producción y por eso las ciudades pueden
  comprarla— pero obliga a que los bots crucen el spread para arrancar (ver
  `bootstrapCap` en `bots-v1/producer.go`). Meter markup aquí rompería ese
  equilibrio: pensarlo dos veces.
- Los **artefactos derivados** de este catálogo (los precios base de los bots y
  las tablas §3-§5 de este documento) ya no se escriben a mano: los genera
  `cd backend && bun src/scripts/generate-catalog-artifacts.ts`, que propaga el
  coste por la cadena, reescribe el bloque `prices:` de `bots-v1/config.yaml` y
  `bots-ciudad/config.yaml` (el mismo en los dos) y las tablas de aquí, y avisa
  de las dos calibraciones de arriba. `--check` no escribe y falla si algo se
  quedó atrás; `catalog-artifacts.test.ts` vigila lo mismo en la suite.

---

## 7. Checklist para ampliar el catálogo

1. Cada `key` y cada `name` de producto/receta es **único**.
2. Cada `output` e `input.product` apunta a un producto existente; sin insumos
   repetidos por receta.
3. Toda receta tiene exactamente un `output` y **declara `installation_type`**;
   además está listada en `recipes` de ese mismo tipo (y solo de ese).
4. `output_qty_cent > 0`, `duration_sim_seconds > 0`,
   `wage_rate_cents_per_sec ≥ 0`, cada `input.qty_cent > 0` (enteros).
5. **No añadir recetas sin insumos**: la única raíz del catálogo es el agua. Un
   `raw_primary` nuevo consume al menos agua, con la cuota de §6.
6. **No cerrar ciclos**: el grafo debe seguir siendo acíclico, o el mundo no
   podrá producir la primera unidad desde inventario cero. Cuidado con los
   insumos que derivan del propio producto (el caso de libro: un pozo de
   petróleo que consumiera diésel).
7. Ningún `final_consumption` aparece como insumo (si lo hace, pasa a
   `intermediate`).
8. Producto o receta nuevos ⇒ **regenerar los artefactos derivados** (§6):
   `cd backend && bun src/scripts/generate-catalog-artifacts.ts`. Si no, los bots
   valoran con costes viejos —producen a pérdida o dejan de producir— y las
   tablas de este documento mienten.
9. Tras editar: `cd backend && bun run typecheck && bun test tests/unit/seed`
   (grafo, banda de insumos y no-deriva de precios y tablas) y un seed sobre DB
   vacía (`make clean-docker && make build && make run && make seed`) deben pasar
   la validación de `backend/src/seed/seed-config.ts`. Ojo: el `seed-config.json`
   va **dentro de la imagen**, así que un cambio de catálogo necesita
   `make build` antes del `make seed`.

**Ejemplo mínimo de receta (formato actual, con `installation_type`):**

```json
{
  "key": "fundicion_acero",
  "name": "Fundición de acero",
  "output": "acero",
  "installation_type": "metalurgia",
  "output_qty_cent": 40000,
  "duration_sim_seconds": 5400,
  "wage_rate_cents_per_sec": 2,
  "inputs": [
    { "product": "hierro", "qty_cent": 40000 },
    { "product": "carbon", "qty_cent": 10000 }
  ]
}
```

---

*Las tablas §3-§5 se generan desde `infra/seed-config.json` (fuente de verdad)
con `backend/src/scripts/generate-catalog-artifacts.ts`; no editarlas a mano.
Ante conflicto con el esquema, mandan `specs/schema.sql` y la validación de
`backend/src/seed/seed-config.ts`.*
