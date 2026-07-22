# Catálogo de Productos y Recetas

> **Proyecto:** Market-Simulator (Simulación de Mercado)
>
> **Versión:** 3.1 — fase de energía v1 (149 productos / 152 recetas)
>
> **Estado:** Referencia canónica del catálogo **actual** de
> `infra/seed-config.json` + reglas para ampliarlo.
>
> **Nota histórica:** la v1.0 era la guía con la que se enrique­ció el catálogo
> agrícola original (trigo→harina→pan) hasta el catálogo industrial de la v2.0.
> La v3.0 (ADR-022) acabó con las 35 recetas sin insumos: el sector extractivo
> dejó de crear bienes de la nada y ahora consume agua, semillas, fertilizante y
> piensos como todo el mundo. La v3.1 (ADR-024) introdujo la `electricidad` como
> insumo de toda la industria y podó la infraestructura eléctrica-como-producto.
> Las tablas §3-§5 se generan del `seed-config.json`
> real con `backend/src/scripts/generate-catalog-artifacts.ts`.

---

## 1. Resumen del catálogo actual

- **149 productos**: 34 `raw_primary`, 77 `intermediate`, 38 `final_consumption`.
- **152 recetas**; todo producto tiene al menos una receta que lo produce; solo
  el `agua` tiene dos (pozo profundo y pozo somero) y la `electricidad` tres
  (hidro y térmicas de carbón y gas, ADR-024).
- **17 tipos de instalación** (ADR-021), todos del rol `transformer`, el único
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
  produce nadie. Desde ADR-024 la industria añade un eslabón más: agua →
  electricidad → industria.
- **La electricidad (ADR-024) solo fluye hacia la industria**: la generan el
  tipo `generacion` (hidro desde agua; térmicas de carbón y gas, ambos finitos)
  y la consumen las 113 recetas industriales al 8-20% de su coste. **No** entra
  en las extractivas ni la generación quema derivados (diésel): cerraría ciclos.
  Las ciudades tampoco la compran (es `intermediate`, no `final_consumption`).
- **Los pozos de petróleo y gas no pueden consumir derivados del petróleo**: se
  cerraría un ciclo y el mundo no podría producir su primera unidad desde
  inventario cero. Por eso el combustible en las extractivas queda pospuesto a
  la fase de transporte/energía v2.
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

Los 17 tipos pertenecen al rol `transformer`, el único rol productivo (ADR-022).

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
| `generacion` | Generación eléctrica | 3 | 50000 | 17000 | 10 |
| `aserradero` | Aserradero y papelera | 6 | 38000 | 17000 | 10 |
| `electronica` | Planta de electrónica | 8 | 80000 | 17000 | 10 |
| `componentes` | Fábrica de componentes mecánicos | 20 | 70000 | 17000 | 10 |
| `ensamblaje` | Planta de ensamblaje final | 16 | 90000 | 17000 | 10 |
| `construccion` | Constructora de infraestructura | 14 | 90000 | 17000 | 10 |

## 4. Productos actuales

Formato: **key** · Nombre · Unidad · **precio base** (¢/unidad, derivado del coste; §6) · **Yacimiento** (ADR-023: ✔ = recurso no renovable con stock finito, cuyo rendimiento decae al vaciarse). (149 productos, 15 con yacimiento más el oro, que lo recibe del patrón oro.)

### 4.1 `raw_primary` — Recursos naturales extraídos

| key | Nombre | Unidad | Precio (¢) | Yacimiento |
| --- | ------ | ------ | ---------- | ---------- |
| `trigo` | Trigo | kg | 21 | — |
| `maiz` | Maíz | kg | 17 | — |
| `leche` | Leche | litro | 51 | — |
| `tomate` | Tomate | kg | 26 | — |
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
| `soya` | Soya | kg | 21 | — |
| `algodon` | Algodón | kg | 26 | — |
| `cana_azucar` | Caña de azúcar | kg | 17 | — |
| `cafe` | Café | kg | 52 | — |
| `cacao` | Cacao | kg | 52 | — |
| `frutas` | Frutas | kg | 19 | — |
| `verduras` | Verduras | kg | 19 | — |
| `ganado_bovino` | Ganado bovino | unidad | 2056 | — |
| `cerdos` | Cerdos | unidad | 1028 | — |
| `pollos` | Pollos | unidad | 103 | — |
| `lana` | Lana | kg | 51 | — |

### 4.2 `intermediate` — Bienes intermedios

| key | Nombre | Unidad | Precio (¢) | Yacimiento |
| --- | ------ | ------ | ---------- | ---------- |
| `semillas` | Semillas | kg | 26 | — |
| `harina` | Harina de trigo | kg | 79 | — |
| `masa` | Masa nixtamalizada | kg | 44 | — |
| `acero` | Acero | kg | 63 | — |
| `acero_inoxidable` | Acero inoxidable | kg | 137 | — |
| `aluminio` | Aluminio | kg | 100 | — |
| `cobre_refinado` | Cobre refinado | kg | 125 | — |
| `cemento` | Cemento | kg | 39 | — |
| `hormigon` | Hormigón | kg | 35 | — |
| `vidrio` | Vidrio | kg | 45 | — |
| `ladrillos` | Ladrillos | unidad | 25 | — |
| `asfalto` | Asfalto | kg | 55 | — |
| `plastico` | Plástico | kg | 94 | — |
| `caucho_sintetico` | Caucho sintético | kg | 94 | — |
| `fertilizantes` | Fertilizantes | kg | 78 | — |
| `productos_quimicos` | Productos químicos | litro | 75 | — |
| `silicio` | Silicio | kg | 162 | — |
| `tablas` | Tablas | kg | 64 | — |
| `celulosa` | Celulosa | kg | 64 | — |
| `papel` | Papel | kg | 105 | — |
| `carton` | Cartón | kg | 153 | — |
| `azucar` | Azúcar | kg | 87 | — |
| `aceite_vegetal` | Aceite vegetal | litro | 115 | — |
| `carne_procesada` | Carne procesada | kg | 94 | — |
| `lacteos` | Lácteos | kg | 102 | — |
| `gasolina` | Gasolina | litro | 114 | — |
| `diesel` | Diésel | litro | 114 | — |
| `electricidad` | Electricidad | kWh | 27 | — |
| `queroseno` | Queroseno | litro | 142 | — |
| `lubricantes` | Lubricantes | litro | 189 | — |
| `viga_acero` | Vigas de acero | kg | 132 | — |
| `lamina_acero` | Láminas de acero | kg | 132 | — |
| `tubo_acero` | Tubos de acero | kg | 140 | — |
| `perfil_metalico` | Perfiles metálicos | kg | 132 | — |
| `lamina_aluminio` | Láminas de aluminio | kg | 206 | — |
| `perfil_aluminio` | Perfiles de aluminio | kg | 206 | — |
| `cable_cobre` | Cable de cobre | kg | 223 | — |
| `bobina_cobre` | Bobinas de cobre | kg | 241 | — |
| `cristal_plano` | Cristal plano | kg | 108 | — |
| `cristal_tecnico` | Cristal técnico | kg | 159 | — |
| `polimeros` | Polímeros | kg | 174 | — |
| `resinas` | Resinas | kg | 157 | — |
| `fibra_sintetica` | Fibra sintética | kg | 180 | — |
| `lubricante_industrial` | Lubricante industrial | litro | 301 | — |
| `madera_tratada` | Madera tratada | kg | 123 | — |
| `contrachapado` | Contrachapado | kg | 131 | — |
| `conservas` | Conservas | kg | 47 | — |
| `piensos` | Piensos | kg | 47 | — |
| `bebidas` | Bebidas | litro | 51 | — |
| `chasis` | Chasis | unidad | 38514 | — |
| `motor_combustion` | Motor de combustión | unidad | 44992 | — |
| `caja_cambios` | Caja de cambios | unidad | 23589 | — |
| `suspension` | Suspensión | unidad | 25311 | — |
| `frenos` | Frenos | unidad | 20772 | — |
| `rodamientos` | Rodamientos | unidad | 10044 | — |
| `bomba_industrial` | Bomba industrial | unidad | 26142 | — |
| `motor_electrico` | Motor eléctrico | unidad | 32176 | — |
| `generador` | Generador | unidad | 74944 | — |
| `bateria` | Batería | unidad | 26873 | — |
| `cableado` | Cableado | kg | 294 | — |
| `circuito_impreso` | Circuitos impresos | unidad | 20792 | — |
| `microchip` | Microchips | unidad | 49274 | — |
| `sensor` | Sensores | unidad | 41069 | — |
| `pantalla` | Pantallas | unidad | 46352 | — |
| `ventana` | Ventanas | unidad | 17368 | — |
| `puerta_industrial` | Puertas industriales | unidad | 14264 | — |
| `panel_prefabricado` | Panel prefabricado | unidad | 19674 | — |
| `tuberia` | Tuberías | kg | 242 | — |
| `asiento` | Asientos | unidad | 25371 | — |
| `panel_interior` | Paneles interiores | unidad | 19704 | — |
| `neumatico` | Neumáticos | unidad | 23195 | — |
| `sistema_hidraulico` | Sistema hidráulico | unidad | 58814 | — |
| `motor_aeronautico` | Motor aeronáutico | unidad | 102353 | — |
| `sistema_control` | Sistema de control | unidad | 225122 | — |
| `tanque_especializado` | Tanque especializado | unidad | 43360 | — |
| `sistema_refrigeracion` | Sistema de refrigeración | unidad | 63427 | — |
| `aislamiento_termico` | Aislamiento térmico | kg | 276 | — |

### 4.3 `final_consumption` — Productos finales

| key | Nombre | Unidad | Precio (¢) | Yacimiento |
| --- | ------ | ------ | ---------- | ---------- |
| `pan` | Pan | kg | 190 | — |
| `tortilla` | Tortilla | kg | 94 | — |
| `queso` | Queso fresco | kg | 2365 | — |
| `salsa` | Salsa de tomate | litro | 111 | — |
| `camion_carga` | Camión de carga | unidad | 669723 | — |
| `camion_cisterna` | Camión cisterna | unidad | 634291 | — |
| `camion_refrigerado` | Camión refrigerado | unidad | 636739 | — |
| `locomotora_diesel` | Locomotora diésel | unidad | 547796 | — |
| `vagon_carga` | Vagón de carga | unidad | 158880 | — |
| `barco_carga` | Barco de carga | unidad | 777729 | — |
| `barco_petrolero` | Barco petrolero | unidad | 947568 | — |
| `avion_carga` | Avión de carga | unidad | 876629 | — |
| `planta_industrial` | Planta industrial genérica | unidad | 146075 | — |
| `refineria` | Refinería de petróleo | unidad | 735020 | — |
| `planta_ensamblaje` | Planta de ensamblaje automotriz | unidad | 637081 | — |
| `astillero` | Astillero | unidad | 468498 | — |
| `fabrica_aeronaves` | Fábrica de aeronaves | unidad | 525063 | — |
| `planta_quimica` | Planta química | unidad | 691231 | — |
| `estacion_carga` | Estación de carga | unidad | 89910 | — |
| `terminal_ferroviaria` | Terminal ferroviaria | unidad | 581674 | — |
| `puerto_comercial` | Puerto comercial | unidad | 245075 | — |
| `aeropuerto_carga` | Aeropuerto de carga | unidad | 864346 | — |
| `automovil` | Automóvil | unidad | 573644 | — |
| `refrigerador` | Refrigerador | unidad | 119788 | — |
| `lavadora` | Lavadora | unidad | 313152 | — |
| `televisor` | Televisor | unidad | 100614 | — |
| `computadora` | Computadora | unidad | 187635 | — |
| `telefono` | Teléfono | unidad | 177068 | — |
| `excavadora` | Excavadora | unidad | 507955 | — |
| `grua` | Grúa | unidad | 257993 | — |
| `edificio_residencial` | Edificio residencial | unidad | 204848 | — |
| `edificio_comercial` | Edificio comercial | unidad | 290549 | — |
| `fabrica_urbana_ligera` | Fábrica urbana ligera | unidad | 327914 | — |
| `almacen_logistico` | Almacén logístico | unidad | 128976 | — |
| `mantequilla` | Mantequilla | kg | 383 | — |
| `yogur` | Yogur | litro | 100 | — |
| `chocolate` | Chocolate | kg | 182 | — |
| `textiles` | Textiles | kg | 118 | — |

## 5. Recetas actuales (agrupadas por tipo de instalación)

Formato: **key** · Nombre · Salida (`output` × `output_qty_cent`) · Duración
(segundos simulados) · Salario (¢/s) · **Coste** de una ejecución (¢, insumos +
salario) y **qué fracción de ese coste son insumos** · Insumos (`key×qty_cent`).
Las dos únicas recetas sin insumos (—, cuota 0%) son las del agua, la raíz del
catálogo.

### 5.1 `campo` — Campo agrícola

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `cultivo_trigo` | Cultivo de trigo | `trigo` | 50000 | 7200 | 1 | 10390 | 31% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_maiz` | Cultivo de maíz | `maiz` | 60000 | 7200 | 1 | 10390 | 31% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_tomate` | Cultivo de tomate | `tomate` | 30000 | 5400 | 1 | 7748 | 30% | `agua`×11000, `semillas`×1500, `fertilizantes`×1100 |
| `cultivo_soya` | Cultivo de soya | `soya` | 50000 | 7200 | 1 | 10390 | 31% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_algodon` | Cultivo de algodón | `algodon` | 40000 | 7200 | 1 | 10390 | 31% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_cana` | Cultivo de caña de azúcar | `cana_azucar` | 60000 | 7200 | 1 | 10390 | 31% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_cafe` | Cultivo de café | `cafe` | 20000 | 7200 | 1 | 10390 | 31% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cultivo_cacao` | Cultivo de cacao | `cacao` | 20000 | 7200 | 1 | 10390 | 31% | `agua`×15000, `semillas`×2000, `fertilizantes`×1500 |
| `cosecha_frutas` | Cosecha de frutas | `frutas` | 40000 | 5400 | 1 | 7748 | 30% | `agua`×11000, `semillas`×1500, `fertilizantes`×1100 |
| `cosecha_verduras` | Cosecha de verduras | `verduras` | 40000 | 5400 | 1 | 7748 | 30% | `agua`×11000, `semillas`×1500, `fertilizantes`×1100 |
| `vivero_semillas` | Vivero de semillas | `semillas` | 5000 | 900 | 1 | 1300 | 31% | `agua`×4000 |

### 5.2 `granja` — Granja ganadera

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `ordena` | Ordeña de vacas | `leche` | 20000 | 3600 | 2 | 10280 | 30% | `agua`×12000, `piensos`×4000 |
| `esquila` | Esquila de lana | `lana` | 10000 | 3600 | 1 | 5140 | 30% | `agua`×6000, `piensos`×2000 |
| `cria_bovino` | Cría de ganado bovino | `ganado_bovino` | 1000 | 7200 | 2 | 20560 | 30% | `agua`×24000, `piensos`×8000 |
| `cria_cerdos` | Cría de cerdos | `cerdos` | 2000 | 7200 | 2 | 20560 | 30% | `agua`×24000, `piensos`×8000 |
| `cria_pollos` | Cría de pollos | `pollos` | 5000 | 3600 | 1 | 5140 | 30% | `agua`×6000, `piensos`×2000 |

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
| `molienda` | Molienda de trigo | `harina` | 8000 | 1800 | 2 | 6321 | 43% | `trigo`×10000, `electricidad`×2300 |
| `panaderia` | Panadería | `pan` | 10000 | 3600 | 3 | 19010 | 43% | `harina`×8000, `electricidad`×7000 |
| `nixtamalizado` | Nixtamalizado de maíz | `masa` | 18000 | 2700 | 2 | 7883 | 31% | `maiz`×10000, `electricidad`×2900 |
| `tortilleria` | Tortillería | `tortilla` | 9500 | 1800 | 2 | 8891 | 60% | `masa`×10000, `electricidad`×3300 |
| `queseria` | Quesería | `queso` | 1000 | 5400 | 3 | 23649 | 31% | `leche`×10000, `electricidad`×8700 |
| `salseria` | Salsería | `salsa` | 8000 | 2700 | 2 | 8891 | 39% | `tomate`×10000, `electricidad`×3300 |
| `planta_lactea` | Planta láctea | `lacteos` | 30000 | 3600 | 2 | 30651 | 77% | `leche`×40000, `electricidad`×11300 |
| `elab_mantequilla` | Elaboración de mantequilla | `mantequilla` | 8000 | 3600 | 2 | 30651 | 77% | `leche`×40000, `electricidad`×11300 |
| `elab_yogur` | Elaboración de yogur | `yogur` | 25000 | 3600 | 2 | 24984 | 71% | `leche`×30000, `electricidad`×9200 |
| `elab_chocolate` | Elaboración de chocolate | `chocolate` | 20000 | 5400 | 3 | 36318 | 55% | `cacao`×15000, `azucar`×10000, `electricidad`×13400 |
| `refino_azucar` | Refino de azúcar | `azucar` | 20000 | 3600 | 2 | 17455 | 59% | `cana_azucar`×50000, `electricidad`×6500 |
| `prensado_aceite` | Prensado de aceite vegetal | `aceite_vegetal` | 15000 | 3600 | 2 | 17301 | 58% | `soya`×40000, `electricidad`×6300 |
| `procesado_carne` | Procesado de carne | `carne_procesada` | 25000 | 3600 | 3 | 23402 | 54% | `ganado_bovino`×500, `electricidad`×8600 |
| `produccion_piensos` | Producción de piensos | `piensos` | 35000 | 3600 | 2 | 16420 | 56% | `maiz`×20000, `soya`×20000, `electricidad`×6000 |
| `embotellado_bebidas` | Embotellado de bebidas | `bebidas` | 35000 | 3600 | 2 | 17982 | 60% | `agua`×3000, `azucar`×10000, `electricidad`×6600 |
| `enlatado_conservas` | Enlatado de conservas | `conservas` | 35000 | 3600 | 2 | 16447 | 56% | `frutas`×20000, `verduras`×20000, `electricidad`×6100 |
| `hilado_fibra` | Hilado de fibra sintética | `fibra_sintetica` | 16000 | 3600 | 2 | 28862 | 75% | `plastico`×20000, `electricidad`×10600 |
| `elab_textiles` | Elaboración de textiles | `textiles` | 15000 | 5400 | 2 | 17755 | 39% | `algodon`×20000, `electricidad`×6500 |

### 5.9 `metalurgia` — Industria metalúrgica

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `fundicion_acero` | Fundición de acero | `acero` | 40000 | 5400 | 2 | 25066 | 57% | `hierro`×40000, `carbon`×10000, `electricidad`×15800 |
| `fundicion_inox` | Fundición de acero inoxidable | `acero_inoxidable` | 38000 | 5400 | 3 | 51875 | 69% | `acero`×40000, `niquel`×5000, `electricidad`×32500 |
| `refino_aluminio` | Refino de aluminio | `aluminio` | 25000 | 5400 | 2 | 25066 | 57% | `bauxita`×50000, `electricidad`×15800 |
| `refino_cobre` | Refino de cobre | `cobre_refinado` | 20000 | 5400 | 2 | 25066 | 57% | `mineral_cobre`×50000, `electricidad`×15800 |
| `laminado_aluminio` | Laminado de aluminio | `lamina_aluminio` | 13000 | 3600 | 2 | 26736 | 73% | `aluminio`×15000, `electricidad`×16800 |
| `laminado_lamina` | Laminado de láminas de acero | `lamina_acero` | 18000 | 3600 | 2 | 23823 | 70% | `acero`×20000, `electricidad`×14900 |
| `laminado_viga` | Laminado de vigas | `viga_acero` | 18000 | 3600 | 2 | 23823 | 70% | `acero`×20000, `electricidad`×14900 |
| `perfilado_aluminio` | Perfilado de aluminio | `perfil_aluminio` | 13000 | 3600 | 2 | 26736 | 73% | `aluminio`×15000, `electricidad`×16800 |
| `perfilado_metal` | Perfilado metálico | `perfil_metalico` | 18000 | 3600 | 2 | 23823 | 70% | `acero`×20000, `electricidad`×14900 |
| `extrusion_tubo` | Extrusión de tubos | `tubo_acero` | 17000 | 3600 | 2 | 23823 | 70% | `acero`×20000, `electricidad`×14900 |
| `trefilado_cable` | Trefilado de cable de cobre | `cable_cobre` | 14000 | 3600 | 2 | 31269 | 77% | `cobre_refinado`×15000, `electricidad`×19700 |
| `bobinado_cobre` | Bobinado de cobre | `bobina_cobre` | 13000 | 3600 | 2 | 31269 | 77% | `cobre_refinado`×15000, `electricidad`×19700 |

### 5.10 `materiales` — Fábrica de materiales de construcción

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `fundicion_vidrio` | Fundición de vidrio | `vidrio` | 30000 | 3600 | 2 | 13495 | 47% | `arena`×40000, `electricidad`×8500 |
| `templado_cristal` | Templado de cristal plano | `cristal_plano` | 18000 | 3600 | 2 | 19494 | 63% | `vidrio`×20000, `electricidad`×12200 |
| `produccion_cristal_tecnico` | Producción de cristal técnico | `cristal_tecnico` | 15000 | 3600 | 3 | 23823 | 55% | `vidrio`×20000, `electricidad`×14900 |
| `coccion_ladrillos` | Cocción de ladrillos | `ladrillos` | 50000 | 3600 | 2 | 12279 | 41% | `arcilla`×30000, `electricidad`×7700 |
| `produccion_cemento` | Producción de cemento | `cemento` | 35000 | 3600 | 2 | 13495 | 47% | `caliza`×40000, `electricidad`×8500 |
| `mezcla_hormigon` | Mezcla de hormigón | `hormigon` | 40000 | 1800 | 2 | 13899 | 74% | `cemento`×15000, `arena`×20000, `agua`×1000, `electricidad`×8700 |
| `produccion_asfalto` | Producción de asfalto | `asfalto` | 40000 | 3600 | 2 | 22126 | 67% | `petroleo`×20000, `piedra`×30000, `electricidad`×13800 |

### 5.11 `refineria` — Refinería petroquímica

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `refino_diesel` | Refino de diésel | `diesel` | 25000 | 3600 | 2 | 28379 | 75% | `petroleo`×40000, `electricidad`×17700 |
| `refino_gasolina` | Refino de gasolina | `gasolina` | 25000 | 3600 | 2 | 28379 | 75% | `petroleo`×40000, `electricidad`×17700 |
| `refino_queroseno` | Refino de queroseno | `queroseno` | 20000 | 3600 | 2 | 28379 | 75% | `petroleo`×40000, `electricidad`×17700 |
| `refino_lubricantes` | Refino de lubricantes | `lubricantes` | 15000 | 3600 | 2 | 28379 | 75% | `petroleo`×40000, `electricidad`×17700 |
| `produccion_lubricante_ind` | Producción de lubricante industrial | `lubricante_industrial` | 18000 | 3600 | 2 | 54126 | 87% | `lubricantes`×20000, `electricidad`×33800 |
| `sintesis_caucho` | Síntesis de caucho | `caucho_sintetico` | 25000 | 3600 | 2 | 23442 | 69% | `petroleo`×30000, `electricidad`×14600 |
| `sintesis_plastico` | Síntesis de plástico | `plastico` | 25000 | 3600 | 2 | 23442 | 69% | `petroleo`×30000, `electricidad`×14600 |
| `sintesis_quimicos` | Síntesis de productos químicos | `productos_quimicos` | 30000 | 3600 | 2 | 22530 | 68% | `petroleo`×25000, `sal`×10000, `electricidad`×14000 |
| `polimerizacion` | Polimerización | `polimeros` | 18000 | 3600 | 2 | 31265 | 77% | `plastico`×20000, `electricidad`×19500 |
| `produccion_resinas` | Producción de resinas | `resinas` | 17000 | 3600 | 2 | 26709 | 73% | `productos_quimicos`×20000, `electricidad`×16700 |
| `produccion_fertilizantes` | Producción de fertilizantes | `fertilizantes` | 35000 | 3600 | 2 | 27163 | 73% | `gas_natural`×20000, `fosfato`×20000, `electricidad`×16900 |
| `produccion_silicio` | Producción de silicio | `silicio` | 15000 | 5400 | 3 | 24304 | 33% | `arena`×40000, `electricidad`×15200 |

### 5.12 `generacion` — Generación eléctrica

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `generacion_hidro` | Generación hidroeléctrica | `electricidad` | 30000 | 3600 | 2 | 13200 | 45% | `agua`×60000 |
| `central_termica_carbon` | Central térmica de carbón | `electricidad` | 60000 | 3600 | 2 | 16200 | 56% | `carbon`×40000, `agua`×10000 |
| `central_termica_gas` | Central térmica de gas | `electricidad` | 60000 | 3600 | 2 | 18400 | 61% | `gas_natural`×20000, `agua`×10000 |

### 5.13 `aserradero` — Aserradero y papelera

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `aserrado` | Aserradero | `tablas` | 30000 | 3600 | 2 | 19090 | 62% | `troncos`×40000, `electricidad`×7000 |
| `tratado_madera` | Tratado de madera | `madera_tratada` | 18000 | 3600 | 2 | 22187 | 68% | `tablas`×20000, `electricidad`×8100 |
| `produccion_contrachapado` | Producción de contrachapado | `contrachapado` | 17000 | 3600 | 2 | 22187 | 68% | `tablas`×20000, `electricidad`×8100 |
| `produccion_celulosa` | Producción de celulosa | `celulosa` | 30000 | 3600 | 2 | 19090 | 62% | `troncos`×40000, `electricidad`×7000 |
| `produccion_papel` | Producción de papel | `papel` | 28000 | 3600 | 2 | 29316 | 75% | `celulosa`×30000, `electricidad`×10800 |
| `produccion_carton` | Producción de cartón | `carton` | 28000 | 3600 | 2 | 42939 | 83% | `papel`×30000, `electricidad`×15700 |

### 5.14 `electronica` — Planta de electrónica

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `ensamble_circuito` | Ensamblaje de circuitos impresos | `circuito_impreso` | 100 | 5400 | 3 | 20792 | 22% | `oro`×100, `cobre_refinado`×1000, `plastico`×500, `electricidad`×7600 |
| `ensamble_microchip` | Fabricación de microchips | `microchip` | 100 | 7200 | 3 | 49274 | 56% | `circuito_impreso`×100, `productos_quimicos`×500, `silicio`×1000, `electricidad`×18100 |
| `ensamble_sensor` | Fabricación de sensores | `sensor` | 100 | 5400 | 3 | 41069 | 61% | `circuito_impreso`×100, `electricidad`×15100 |
| `ensamble_pantalla` | Fabricación de pantallas | `pantalla` | 100 | 5400 | 3 | 46352 | 65% | `cristal_tecnico`×3000, `circuito_impreso`×100, `electricidad`×17000 |
| `ensamble_cableado` | Ensamblaje de cableado | `cableado` | 8000 | 3600 | 2 | 23519 | 69% | `cable_cobre`×5000, `plastico`×3000, `electricidad`×8700 |
| `ensamble_bateria` | Ensamblaje de batería | `bateria` | 100 | 5400 | 3 | 26873 | 40% | `litio`×3000, `plastico`×2000, `electricidad`×9900 |
| `ensamble_motor_elec` | Ensamblaje de motor eléctrico | `motor_electrico` | 100 | 5400 | 3 | 32176 | 50% | `bobina_cobre`×4000, `acero`×5000, `electricidad`×11800 |
| `ensamble_control` | Ensamblaje de sistema de control | `sistema_control` | 100 | 5400 | 3 | 225122 | 93% | `microchip`×200, `sensor`×200, `cableado`×2000, `electricidad`×82800 |

### 5.15 `componentes` — Fábrica de componentes mecánicos

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `ensamble_motor` | Ensamblaje de motor de combustión | `motor_combustion` | 100 | 7200 | 3 | 44992 | 52% | `acero`×15000, `aluminio`×5000, `cable_cobre`×2000, `electricidad`×16600 |
| `ensamble_motor_aero` | Ensamblaje de motor aeronáutico | `motor_aeronautico` | 100 | 7200 | 3 | 102353 | 79% | `aluminio`×15000, `acero`×10000, `microchip`×100, `electricidad`×37700 |
| `ensamble_chasis` | Ensamblaje de chasis | `chasis` | 100 | 5400 | 3 | 38514 | 58% | `viga_acero`×8000, `lamina_acero`×6000, `electricidad`×14200 |
| `ensamble_caja` | Ensamblaje de caja de cambios | `caja_cambios` | 100 | 5400 | 3 | 23589 | 31% | `acero`×8000, `electricidad`×8700 |
| `ensamble_frenos` | Ensamblaje de frenos | `frenos` | 100 | 5400 | 3 | 20772 | 22% | `acero`×4000, `electricidad`×7600 |
| `ensamble_suspension` | Ensamblaje de suspensión | `suspension` | 100 | 5400 | 3 | 25311 | 36% | `acero`×6000, `caucho_sintetico`×3000, `electricidad`×9300 |
| `ensamble_rodamientos` | Ensamblaje de rodamientos | `rodamientos` | 200 | 5400 | 3 | 20088 | 19% | `acero`×3000, `electricidad`×7400 |
| `ensamble_bomba` | Ensamblaje de bomba industrial | `bomba_industrial` | 100 | 5400 | 3 | 26142 | 38% | `acero`×5000, `tubo_acero`×3000, `electricidad`×9600 |
| `ensamble_hidraulico` | Ensamblaje de sistema hidráulico | `sistema_hidraulico` | 100 | 5400 | 3 | 58814 | 72% | `acero`×8000, `tubo_acero`×4000, `bomba_industrial`×100, `electricidad`×21600 |
| `ensamble_neumatico` | Fabricación de neumáticos | `neumatico` | 100 | 5400 | 3 | 23195 | 30% | `caucho_sintetico`×5000, `electricidad`×8500 |
| `ensamble_generador` | Ensamblaje de generador | `generador` | 100 | 5400 | 3 | 74944 | 78% | `motor_combustion`×100, `acero`×10000, `electricidad`×27600 |
| `ensamble_tanque` | Fabricación de tanque especializado | `tanque_especializado` | 100 | 5400 | 3 | 43360 | 63% | `lamina_acero`×12000, `tubo_acero`×5000, `electricidad`×16000 |
| `ensamble_tuberia` | Fabricación de tuberías | `tuberia` | 8000 | 3600 | 2 | 19397 | 63% | `tubo_acero`×6000, `plastico`×2000, `electricidad`×7100 |
| `ensamble_asiento` | Fabricación de asientos | `asiento` | 100 | 5400 | 3 | 25371 | 36% | `fibra_sintetica`×3000, `acero`×2000, `electricidad`×9300 |
| `ensamble_panel_int` | Fabricación de paneles interiores | `panel_interior` | 100 | 5400 | 2 | 19704 | 45% | `polimeros`×4000, `electricidad`×7200 |
| `ensamble_panel_pref` | Fabricación de panel prefabricado | `panel_prefabricado` | 100 | 3600 | 2 | 19674 | 63% | `hormigon`×15000, `viga_acero`×4000, `electricidad`×7200 |
| `ensamble_puerta` | Fabricación de puertas industriales | `puerta_industrial` | 100 | 3600 | 2 | 14264 | 50% | `acero`×6000, `plastico`×2000, `electricidad`×5200 |
| `ensamble_ventana` | Fabricación de ventanas | `ventana` | 100 | 3600 | 2 | 17368 | 59% | `cristal_plano`×4000, `perfil_aluminio`×2000, `electricidad`×6400 |
| `ensamble_aislamiento` | Producción de aislamiento térmico | `aislamiento_termico` | 10000 | 3600 | 2 | 27627 | 74% | `polimeros`×5000, `fibra_sintetica`×5000, `electricidad`×10100 |
| `ensamble_refrig` | Ensamblaje de sistema de refrigeración | `sistema_refrigeracion` | 100 | 5400 | 3 | 63427 | 74% | `motor_electrico`×100, `tuberia`×3000, `productos_quimicos`×2000, `electricidad`×23300 |

### 5.16 `ensamblaje` — Planta de ensamblaje final

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `fab_automovil` | Fabricación de automóvil | `automovil` | 100 | 14400 | 3 | 573644 | 92% | `chasis`×100, `motor_combustion`×100, `sistema_control`×100, `cristal_plano`×1500, `neumatico`×400, `asiento`×200, `panel_interior`×100, `electricidad`×211000 |
| `fab_avion` | Fabricación de avión de carga | `avion_carga` | 100 | 21600 | 3 | 876629 | 93% | `lamina_aluminio`×30000, `motor_aeronautico`×200, `sistema_control`×200, `cristal_tecnico`×5000, `electricidad`×322700 |
| `fab_barco_carga` | Fabricación de barco de carga | `barco_carga` | 100 | 21600 | 3 | 777729 | 92% | `viga_acero`×50000, `motor_combustion`×200, `sistema_control`×200, `cableado`×10000, `electricidad`×286300 |
| `fab_barco_petrolero` | Fabricación de barco petrolero | `barco_petrolero` | 100 | 21600 | 3 | 947568 | 93% | `viga_acero`×50000, `motor_combustion`×200, `tanque_especializado`×300, `bomba_industrial`×200, `sistema_control`×200, `electricidad`×348800 |
| `fab_camion_carga` | Fabricación de camión de carga | `camion_carga` | 100 | 18000 | 3 | 669723 | 92% | `chasis`×100, `motor_combustion`×100, `caja_cambios`×100, `suspension`×100, `frenos`×200, `neumatico`×600, `cableado`×3000, `sistema_control`×100, `cristal_plano`×2000, `electricidad`×246300 |
| `fab_camion_cisterna` | Fabricación de camión cisterna | `camion_cisterna` | 100 | 18000 | 3 | 634291 | 91% | `chasis`×100, `motor_combustion`×100, `tanque_especializado`×100, `bomba_industrial`×100, `neumatico`×600, `sistema_control`×100, `electricidad`×233300 |
| `fab_camion_refrigerado` | Fabricación de camión refrigerado | `camion_refrigerado` | 100 | 18000 | 3 | 636739 | 92% | `chasis`×100, `motor_combustion`×100, `sistema_refrigeracion`×100, `aislamiento_termico`×3000, `neumatico`×600, `sistema_control`×100, `electricidad`×234200 |
| `fab_computadora` | Fabricación de computadora | `computadora` | 100 | 7200 | 3 | 187635 | 88% | `microchip`×200, `pantalla`×100, `plastico`×2000, `cobre_refinado`×500, `electricidad`×69000 |
| `fab_excavadora` | Fabricación de excavadora | `excavadora` | 100 | 18000 | 3 | 507955 | 89% | `acero`×25000, `motor_combustion`×100, `sistema_hidraulico`×200, `sistema_control`×100, `electricidad`×186900 |
| `fab_grua` | Fabricación de grúa | `grua` | 100 | 18000 | 3 | 257993 | 79% | `acero`×25000, `motor_combustion`×100, `sistema_hidraulico`×200, `electricidad`×94900 |
| `fab_lavadora` | Fabricación de lavadora | `lavadora` | 100 | 7200 | 3 | 313152 | 93% | `acero`×5000, `motor_electrico`×100, `sistema_control`×100, `electricidad`×115200 |
| `fab_locomotora` | Fabricación de locomotora diésel | `locomotora_diesel` | 100 | 21600 | 3 | 547796 | 88% | `motor_combustion`×200, `chasis`×100, `sistema_control`×100, `generador`×100, `electricidad`×201600 |
| `fab_refrigerador` | Fabricación de refrigerador | `refrigerador` | 100 | 7200 | 3 | 119788 | 82% | `acero`×5000, `sistema_refrigeracion`×100, `panel_interior`×100, `electricidad`×44100 |
| `fab_telefono` | Fabricación de teléfono | `telefono` | 100 | 5400 | 3 | 177068 | 91% | `microchip`×100, `pantalla`×100, `bateria`×100, `circuito_impreso`×100, `electricidad`×65100 |
| `fab_televisor` | Fabricación de televisor | `televisor` | 100 | 7200 | 3 | 100614 | 79% | `pantalla`×100, `circuito_impreso`×100, `plastico`×2000, `electricidad`×37000 |
| `fab_vagon` | Fabricación de vagón de carga | `vagon_carga` | 100 | 10800 | 3 | 158880 | 80% | `viga_acero`×15000, `rodamientos`×800, `perfil_metalico`×8000, `electricidad`×58400 |

### 5.17 `construccion` — Constructora de infraestructura

| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |
| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |
| `constr_aeropuerto` | Construcción de aeropuerto de carga | `aeropuerto_carga` | 100 | 14400 | 3 | 864346 | 95% | `hormigon`×50000, `acero`×30000, `sistema_control`×300, `cableado`×8000, `electricidad`×318000 |
| `constr_almacen` | Construcción de almacén logístico | `almacen_logistico` | 100 | 14400 | 3 | 128976 | 67% | `hormigon`×40000, `acero`×25000, `cableado`×5000, `puerta_industrial`×200, `electricidad`×47400 |
| `constr_astillero` | Construcción de astillero | `astillero` | 100 | 18000 | 3 | 468498 | 88% | `acero`×40000, `sistema_hidraulico`×200, `sistema_control`×100, `electricidad`×172400 |
| `constr_edificio_com` | Construcción de edificio comercial | `edificio_comercial` | 100 | 14400 | 3 | 290549 | 85% | `hormigon`×60000, `acero`×25000, `ventana`×800, `puerta_industrial`×300, `electricidad`×106900 |
| `constr_edificio_res` | Construcción de edificio residencial | `edificio_residencial` | 100 | 14400 | 3 | 204848 | 79% | `hormigon`×60000, `acero`×20000, `ventana`×500, `cableado`×5000, `madera_tratada`×5000, `electricidad`×75400 |
| `constr_estacion` | Construcción de estación de carga | `estacion_carga` | 100 | 14400 | 3 | 89910 | 52% | `acero`×20000, `hormigon`×30000, `cableado`×5000, `electricidad`×33000 |
| `constr_fabrica_aeronaves` | Construcción de fábrica de aeronaves | `fabrica_aeronaves` | 100 | 18000 | 3 | 525063 | 90% | `aluminio`×30000, `microchip`×500, `motor_aeronautico`×100, `rodamientos`×400, `electricidad`×193200 |
| `constr_fabrica_ligera` | Construcción de fábrica urbana ligera | `fabrica_urbana_ligera` | 100 | 14400 | 3 | 327914 | 87% | `acero`×20000, `hormigon`×30000, `sistema_control`×100, `contrachapado`×3000, `electricidad`×120600 |
| `constr_planta_ensamblaje` | Construcción de planta de ensamblaje | `planta_ensamblaje` | 100 | 18000 | 3 | 637081 | 92% | `acero`×30000, `sistema_control`×200, `rodamientos`×400, `hormigon`×30000, `electricidad`×234300 |
| `constr_planta_industrial` | Construcción de planta industrial | `planta_industrial` | 100 | 18000 | 3 | 146075 | 63% | `acero`×30000, `hormigon`×40000, `vidrio`×10000, `rodamientos`×400, `electricidad`×53700 |
| `constr_planta_quimica` | Construcción de planta química | `planta_quimica` | 100 | 18000 | 3 | 691231 | 92% | `acero`×30000, `tubo_acero`×15000, `bomba_industrial`×300, `sistema_control`×200, `electricidad`×254300 |
| `constr_puerto` | Construcción de puerto comercial | `puerto_comercial` | 100 | 14400 | 3 | 245075 | 82% | `hormigon`×50000, `acero`×30000, `sistema_hidraulico`×200, `cableado`×8000, `electricidad`×90100 |
| `constr_refineria` | Construcción de refinería | `refineria` | 100 | 18000 | 3 | 735020 | 93% | `acero`×40000, `tubo_acero`×20000, `sistema_control`×200, `bomba_industrial`×400, `electricidad`×270400 |
| `constr_terminal` | Construcción de terminal ferroviaria | `terminal_ferroviaria` | 100 | 14400 | 3 | 581674 | 93% | `acero`×25000, `sistema_control`×200, `cableado`×5000, `electricidad`×214000 |

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
