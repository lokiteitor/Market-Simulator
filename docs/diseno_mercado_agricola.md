# Diseño conceptual: Simulación de mercado agrícola

## Propósito del documento

Este documento sintetiza las decisiones de diseño tomadas en la fase conceptual del sistema. Está dirigido a quien continúe la planeación técnica (arquitectura, selección de tecnologías, esquemas de datos, contratos de API). Las decisiones aquí registradas son resultado de una iteración de modelado del dominio y deben tomarse como **fijas** salvo que el contexto técnico revele una incompatibilidad. Donde existen extensiones futuras planeadas (v2), están marcadas explícitamente.

---

## 1. Visión general del sistema

Se construye un servidor autoritativo de estado que simula un mercado de productos agrícolas con desde ~100 hasta ~10.000 agentes participando simultáneamente (sin límite máximo). Los agentes son clientes externos que se conectan al sistema; el servidor es la única fuente de verdad sobre capital, inventarios, órdenes, procesos de transformación e historial.

**Roles de agentes:**
- **Productores primarios:** generan materias primas desde cero (siembra, cosecha, ganadería).
- **Transformadores:** compran materias primas, las procesan en productos de mayor valor, y los venden.
- **Consumidores finales:** compran productos para consumir, retirándolos del sistema.
- **Traders / intermediarios:** compran y revenden buscando ganancia por arbitraje, sin transformar.

Algunos agentes operan por reglas simples, otros por modelos de ML. El sistema no distingue entre ellos: todos consumen la misma API.

**Principio rector:** los agentes son clientes sin estado autoritativo. Toda información que un agente maneja localmente es caché de lo que vive en el servidor. Esto resuelve consistencia bajo concurrencia y reconexión sin pérdida.

---

## 2. Modelo de dominio

### 2.1 Catálogo

**Producto**
- Identificador único
- Nombre
- Unidad de medida (kg, L, cabezas, etc.)
- Categoría (materia prima primaria / intermedia / consumo final) — informativa, no restrictiva
- Todos los productos son **homogéneos**: no hay variantes de calidad en v1

**Receta**
- Identificador único
- Producto resultante (uno solo en v1; subproductos quedan para futuro)
- Cantidad producida por ejecución
- Lista de insumos: tuplas (producto, cantidad requerida)
- Duración del proceso en tiempo simulado
- Costo de salario asociado (ver sección de fees)

Las recetas son entidades canónicas del catálogo. Múltiples agentes pueden ejecutar la misma receta. El sistema valida toda transformación contra la receta de referencia, no contra una copia del agente.

**Caso especial — producción primaria:** las recetas de productores primarios se modelan como recetas **sin insumos** (lista vacía) cuyo resultado es la materia prima. La duración representa el ciclo productivo (cultivo, crianza). Esto unifica el concepto de transformación en todo el sistema.

> Pendiente para iteración futura: explorar producción primaria con insumos básicos del entorno (agua, energía) modelados como fees al sistema. En v1, producción desde cero pura.

### 2.2 Participantes y posesiones

**Agente**
- Identificador único (siempre fresco; no se reciclan identidades)
- Rol
- Capital disponible
- Capital reservado (en órdenes de compra activas)
- Estado: activo / en quiebra
- Timestamp de registro
- Instalaciones compradas (ver más abajo)

**Instalaciones (economía de instalaciones, ADR-021)**
- Un **tipo de instalación** (`campo`, `mina`, `metalurgia`, `electrónica`, …) agrupa varias recetas afines; cada receta pertenece a exactamente un tipo.
- El agente **compra** una instalación de un tipo y la **sube de nivel**; el `level` (nº de hectáreas / líneas de producción) es el número de procesos simultáneos que puede repartir entre **todas las recetas del tipo** (presupuesto de concurrencia compartido).
- **Nadie recibe instalaciones al inicio**: el agente nace sin producción y compra/mejora con su capital (`POST /agents/me/installations`). El precio crece por nivel (`base_price × growth^nivel`) y se acredita al banco central.
- Conceptualmente modela: campos/hectáreas para productores primarios, industrias/líneas de producción para transformadores.

**Posición de inventario**
- Relación (agente, producto)
- Cantidad disponible
- Cantidad reservada (en órdenes de venta activas)

La separación disponible/reservado tanto en capital como en inventario es fundamental para la consistencia bajo concurrencia. Las validaciones de invariantes son locales y baratas: nunca requieren escanear órdenes activas.

### 2.3 Actividad

**Orden**
- Identificador único
- Agente emisor
- Producto
- Lado: compra / venta
- Cantidad original
- Cantidad pendiente
- Precio límite
- TTL (obligatorio, máximo 1 semana de tiempo simulado, mínimo 1 minuto simulado)
- Estado: activa / parcialmente ejecutada / completada / cancelada / expirada
- Timestamps: creación, última actualización, expiración

**Transacción**
- Identificador único
- Orden compradora (con ID y agente)
- Orden vendedora (con ID y agente)
- Producto
- Cantidad ejecutada
- Precio efectivo
- Fee cobrado al comprador
- Fee cobrado al vendedor
- Timestamp

Una vez creada, la transacción es inmutable.

**Proceso de transformación**
- Identificador único
- Agente
- Receta
- Número de ejecuciones planificadas
- Ejecución actual en curso (1 a N)
- Estado: en curso / completado / cancelado
- Timestamp de inicio
- Timestamp esperado de finalización
- Snapshot de insumos consumidos al iniciar
- Salario pagado upfront

> Nota sobre ejecuciones: las recetas se ejecutan secuencialmente. El **nivel de la instalación del tipo** de la receta determina cuántos procesos puede correr en paralelo (compartido entre las recetas del tipo), no cuántas ejecuciones de la misma receta dentro de un proceso.

### 2.4 Diagrama relacional

```
Producto ──< Receta (resultado)
Producto ──< Insumo de receta
Receta >── Tipo de instalación ──< Instalación comprada >── Agente
Producto ──< Posición inventario >── Agente
Agente ──< Orden >── Producto
Orden ──< Transacción >── Orden
Agente ──< Proceso transformación >── Receta
```

---

## 3. Operaciones expuestas a los agentes

### 3.1 Lectura

- `get_self_state`: snapshot completo del agente (capital, inventario, órdenes activas, procesos en curso, instalaciones compradas). Usado en reconexión.
- `get_catalog`: lista de productos, recetas y tipos de instalación disponibles.
- `get_top_of_book(producto)`: mejor orden de compra y mejor orden de venta para un producto, con identidad del agente que la colocó. Si hay varias órdenes al mismo precio, se muestra solo la primera en cola precio-tiempo.
- `get_recent_transactions(producto, ventana)`: transacciones recientes de un producto.
- `get_my_history(filtros)`: historial propio del agente (sus órdenes, transacciones, procesos).

### 3.2 Acción

- `register_agent(rol)`: registro dinámico, disponible siempre durante la simulación. Devuelve identidad y estado inicial (sin instalaciones, ADR-021).
- `place_order(producto, lado, cantidad, precio_limite, ttl)`: coloca una orden.
- `cancel_order(orden_id)`: cancela una orden propia activa.
- `start_transformation(receta_id, ejecuciones)`: inicia un proceso de transformación.
- `cancel_transformation(proceso_id)`: cancela un proceso en curso (sin reembolso de insumos ni salario).
- `acquire_installation(tipo)`: compra o mejora una instalación del tipo dado (ADR-021).

### 3.3 Notificaciones (push del servidor al agente)

- `order_executed`: ejecución total o parcial de una orden propia.
- `order_expired`: TTL alcanzado sin ejecución completa.
- `order_cancelled`: confirmación de cancelación.
- `transformation_completed`: proceso terminado, inventario actualizado.
- `agent_joined` (broadcast): nuevo agente registrado.
- `agent_bankrupt` (broadcast): agente entró en quiebra.
- `bankruptcy_notice` (personal): notificación al agente de que ha quebrado y debe apagarse.
- `trade_printed` (por suscripción): tape en tiempo real. Se entrega solo a las
  conexiones que declararon interés en el producto vía el mensaje
  `subscribe_products` del canal WS (o en todos con `"*"`); el tape completo
  siempre está disponible vía `GET /market/{id}/trades`.

---

## 4. Ciclo de vida de una orden

```
[Creación] → [Validación atómica] → [Activa]
                                       ├── [Parcialmente ejecutada] → ...
                                       ├── [Completada]
                                       ├── [Cancelada]
                                       └── [Expirada]
```

**Creación y validación atómica:**
1. Validar existencia de agente, producto y que el agente no esté en quiebra.
2. Validar TTL dentro de límites (mínimo 1 minuto simulado, máximo 1 semana simulada).
3. Si es compra: verificar capital disponible ≥ cantidad × precio_límite. Mover esa cantidad de "disponible" a "reservado".
4. Si es venta: verificar inventario disponible ≥ cantidad. Mover esa cantidad de "disponible" a "reservado".
5. Si pasa todas las validaciones, registrar orden en estado **activa** e ingresarla al libro de órdenes del producto.

**Casado (matching):**
- Política: **prioridad precio-tiempo**. Mejor precio primero; en empate, la orden más antigua.
- Política de pricing: **el precio del que ya estaba en el libro** (la orden agresora toma el precio de la orden pasiva).
- Política de ejecución: **se permiten ejecuciones parciales**. Una orden puede casarse con múltiples contrapartes.
- El matching engine procesa por producto de forma serializada para evitar condiciones de carrera (mutex in-process + advisory lock de Postgres cluster-wide entre las N réplicas del Core; ADR-019).

**Ejecución de una transacción casada:**
1. Calcular cantidad efectiva (mínimo entre las cantidades pendientes de ambas órdenes).
2. Calcular precio efectivo (el de la orden pasiva).
3. Calcular fees del comprador y del vendedor.
4. Atómicamente:
   - Descontar capital reservado del comprador por (cantidad × precio).
   - Descontar capital disponible del comprador por fee.
   - Incrementar inventario disponible del comprador.
   - Descontar inventario reservado del vendedor.
   - Incrementar capital disponible del vendedor por (cantidad × precio).
   - Descontar capital disponible del vendedor por fee.
   - Actualizar cantidades pendientes de ambas órdenes.
   - Registrar la transacción en el historial.
5. Si alguna orden queda con cantidad pendiente cero, pasa a estado **completada** y libera reservas residuales. Si no, permanece **parcialmente ejecutada** en el libro.
6. Notificar a ambos agentes.

**Cancelación y expiración:**
- Liberan reservas restantes (capital o inventario) y mueven la orden a estado terminal.
- La expiración se evalúa contra el tiempo simulado actual. El TTL es **absoluto desde la creación**; no se reinicia con ejecuciones parciales.

---

## 5. Ciclo de vida de un proceso de transformación

```
[Solicitud] → [Validación atómica] → [En curso] → [Completado]
                                          └────→ [Cancelado]
```

**Solicitud y validación atómica:**
1. Validar existencia de agente, receta y que el agente no esté en quiebra.
2. Validar instalación (ADR-021): el agente ha **comprado** la instalación del tipo de esta receta (si no, `insufficient_capacity`) y su nivel no está saturado por los procesos en curso de las recetas del tipo (si no, `recipe_capacity_saturated`).
3. Validar insumos: el agente tiene en inventario disponible todos los insumos × ejecuciones planificadas.
4. Validar capital: el agente tiene capital disponible suficiente para pagar el salario completo upfront.
5. Si pasa todas las validaciones, atómicamente:
   - Descontar insumos del inventario disponible (consumo real, no reserva).
   - Descontar salario del capital disponible.
   - Crear proceso con estado **en curso**.
   - Calcular timestamp esperado de finalización: ahora + (duración_receta × ejecuciones).

**Finalización:**
- Modelo **híbrido lazy + sweeper**:
  - En toda lectura de estado del agente, materializar procesos vencidos del agente antes de devolver el estado.
  - Un sweeper de fondo de baja frecuencia recorre periódicamente todos los procesos vencidos y los materializa, para garantizar que las notificaciones se disparen oportunamente aunque el agente no consulte.
- Materializar significa: incrementar inventario disponible del agente por (cantidad_producida × ejecuciones), marcar proceso como **completado**, notificar al agente, registrar en historial.

**Cancelación:**
- Marca proceso como **cancelado**. No devuelve insumos ni reembolsa salario. Operación rara pero disponible.

**Capacidad y paralelismo:**
- Las ejecuciones dentro de un mismo proceso son **secuenciales**. Un proceso con 3 ejecuciones dura 3 × duración de la receta.
- El paralelismo está limitado por el `level` de la instalación del **tipo** de la receta, **compartido** por todas las recetas del tipo (ADR-021). Con un `campo` de nivel 3 el agente puede tener 3 procesos de cultivo simultáneos repartidos como quiera (p.ej. 2 trigo + 1 maíz).

---

## 6. Consistencia de estado

### Invariantes

Para todo agente activo:
- Capital disponible ≥ 0
- Capital reservado ≥ 0
- Para cada producto: inventario disponible ≥ 0 e inventario reservado ≥ 0
- La suma de reservas de capital coincide con la suma de (cantidad pendiente × precio límite) de sus órdenes de compra activas
- La suma de reservas de inventario por producto coincide con la suma de cantidades pendientes de sus órdenes de venta activas para ese producto

### Reglas de modificación

- Toda operación que modifique estado del agente se ejecuta como **transacción atómica** que valida invariantes antes de aplicar el cambio.
- El matching engine serializa el procesamiento por producto (cluster-wide vía advisory locks de Postgres; ADR-019).
- Las modificaciones que tocan a dos agentes simultáneamente (una transacción casada) se aplican como una sola unidad atómica.

### Representación numérica

- Cantidades de producto: máximo 2 decimales. **Internamente representadas como enteros en centésimas de la unidad** para evitar errores de punto flotante en validaciones.
- Capital: representado en la unidad mínima monetaria como entero (centavos).
- La conversión a/desde decimales ocurre solo en los bordes (API hacia agentes, registros para análisis).

---

## 7. Reconexión

El sistema soporta desconexión arbitraria de agentes sin pérdida de información. Una desconexión es simplemente la ausencia de conexión; no hay notificación al servidor ni efectos sobre órdenes activas o procesos en curso.

**Flujo de reconexión:**
1. El agente se autentica e identifica.
2. El servidor materializa lazy cualquier proceso de transformación vencido del agente.
3. El servidor envía un snapshot completo del estado:
   - Capital disponible y reservado.
   - Todas las posiciones de inventario (disponible y reservado por producto).
   - Todas las órdenes activas con su estado actual (incluyendo cantidades pendientes).
   - Todos los procesos de transformación en curso con timestamps de finalización.
   - Resumen de eventos desde la última desconexión (transacciones ejecutadas, procesos completados, órdenes expiradas, agentes nuevos, agentes quebrados) con un límite razonable.
4. El historial completo está disponible vía consultas separadas si el agente lo necesita.
5. El agente reanuda operación.

**Órdenes y procesos durante desconexión:**
- Las órdenes activas del agente siguen vigentes y pueden ejecutarse mientras está desconectado.
- Los procesos en curso continúan y se completan según su timestamp, generando inventario que el agente encontrará al reconectarse.
- El TTL de órdenes corre normalmente; órdenes pueden expirar durante la desconexión.

---

## 8. Tiempo

- **Factor de simulación: 5× tiempo real.** Una hora real equivale a 5 horas de tiempo simulado.
- Todas las duraciones del dominio (recetas, TTLs) se declaran en unidades de tiempo simulado.
- Una única función de conversión vive en el límite con el reloj de pared.
- El factor puede modificarse o la simulación puede pausarse sin afectar la lógica de dominio.

---

## 9. Fees y costos

### Fee de transacción

- Modelo **mixto**: componente fijo + componente proporcional al monto transado.
- Se cobra a **cada lado** de la transacción al momento de ejecutarse.
- Se descuenta del capital disponible inmediatamente.
- Parámetros configurables.

### Salario de transformación

- Modelo **proporcional a la duración del proceso**.
- Se paga **upfront** al iniciar el proceso.
- No se reembolsa en caso de cancelación.
- Parámetros configurables.

### Sin otros fees

- Colocar una orden (sin ejecutarla) es gratis.
- Cancelar una orden es gratis.
- Registro de agente es gratis.

### Destino de los fees

> **Actualizado (patrón oro, 2026-07):** los fees ya **no** salen del circuito. Se acreditan al capital del **banco central** en la misma transacción del matching, y el banco los recicla para financiar el capital semilla de los registros dinámicos antes de acuñar dinero nuevo. Ver sección 18.

---

## 10. Quiebra de agentes

**Detección:**
El agente entra en quiebra cuando se vuelve incapaz de continuar: capital total = 0, inventario total vendible = 0, sin procesos en curso y sin órdenes activas que puedan generar ingresos. La evaluación ocurre de forma reactiva cuando se cancela su última orden, vence su última orden, o se completa su último proceso de transformación sin recuperar capital.

**Acciones del sistema al detectar quiebra:**
1. Cancelar todas las órdenes activas residuales del agente (libera reservas).
2. Marcar al agente con estado **en quiebra** en su registro.
3. Enviar `bankruptcy_notice` al agente para que se apague.
4. Emitir broadcast `agent_bankrupt` a los demás agentes.
5. Rechazar cualquier operación futura del agente con error "agente en quiebra".

**Inventario residual:**
- Se **congela**. Permanece registrado en el agente pero es inaccesible. No se subasta ni se libera al sistema.

**Persistencia:**
- El agente quebrado persiste en el historial y en consultas de registro de agentes.
- Su identidad no se recicla. Nuevos agentes siempre reciben identidades frescas.

---

## 11. Registro dinámico de agentes

**Modelo:** llegadas libres. El sistema acepta registros de nuevos agentes en cualquier momento durante la simulación, sin límite máximo.

**Inicialización del nuevo agente:**
- Identidad fresca (nunca reciclada).
- **Capital semilla objetivo = promedio actual del capital total de los agentes activos del mercado** al momento del registro. Esto mantiene a los recién llegados competitivos.
- **Financiamiento del capital semilla (patrón oro, 2026-07):** el grant se cubre **primero con capital del banco central** (fees reciclados) y el resto se **acuña** solo si el oro del banco lo respalda al ratio de cobertura. Si el máximo respaldable queda por debajo del mínimo configurado, el registro se rechaza con `insufficient_gold_backing`. Cada acuñación emite el evento `money_issued`. Ver sección 18.
- **Sin instalaciones** (ADR-021): el agente nace sin capacidad productiva y debe comprar instalaciones con su capital semilla (que se subió para cubrir la 1ª compra).
- Sin fee de entrada.

**Notificación:**
- Broadcast `agent_joined` a todos los agentes activos.

**Caso especial — registro inicial:**
- Los agentes registrados en el setup inicial reciben capital semilla aleatorio dentro de un rango configurable **por rol**:
  - Productores primarios: rango bajo-medio.
  - Transformadores: rango medio-alto.
  - Consumidores: rango medio.
  - Traders: rango alto.
- Los rangos específicos son parámetros de configuración.
- La aleatoriedad es determinística a partir de la semilla maestra (ver sección de reproducibilidad).

---

## 12. Reproducibilidad

- El sistema acepta una **semilla maestra** al iniciar la simulación.
- La semilla se usa exclusivamente para el **setup inicial**: capital semilla de cada agente inicial, asignaciones aleatorias de capacidades si las hay, cualquier otro parámetro aleatorizado del setup.
- Cada agente inicial recibe un sub-generador derivado de (semilla maestra + identificador del agente) para que la generación sea **independiente del orden de inicialización**.
- La simulación en curso **no es reproducible**: orden exacto de matching en empates, eventos asíncronos, llegadas dinámicas, no son deterministas.
- La semilla maestra y la configuración inicial completa se persisten en el historial para contextualizar análisis posteriores.

---

## 13. Visibilidad del mercado

- **Nivel 1 — Top of book con identidad visible.**
- Para cada producto, los agentes pueden consultar la mejor orden de compra y la mejor orden de venta actuales.
- Se muestra una sola orden por lado (la primera en cola precio-tiempo cuando hay varias al mismo precio).
- Se revela la identidad del agente que colocó la orden visible.
- El resto del libro es privado: profundidad, número de órdenes, identidades del resto.
- Las transacciones ejecutadas son públicas en el historial reciente (con identidades de ambas contrapartes, producto, cantidad, precio, timestamp).

---

## 14. Historial

Toda mutación de estado genera un evento persistido en un log **append-only** antes de aplicarse. El estado actual es derivable reproduciendo eventos. El historial sirve a dos audiencias: agentes de ML que entrenan o deciden con datos pasados, y el investigador que analiza la simulación post-mortem.

### Series históricas a mantener

**Historial de transacciones**
- Cada transacción ejecutada: contrapartes, producto, cantidad, precio, fees cobrados, timestamp.
- Permite derivar series de precios, volúmenes, redes de comercio entre agentes.

**Historial de órdenes**
- Cada orden colocada con todos sus cambios de estado: creación, ejecuciones parciales, terminación.
- Permite reconstruir el libro de órdenes en cualquier punto del tiempo.

**Historial de procesos de transformación**
- Cada proceso: agente, receta, ejecuciones planificadas, insumos consumidos, salario pagado, producto y cantidad producida, duración real, estado final, timestamps.

**Historial de agentes**
- Registro de cada agente: rol, capital semilla, capacidades, timestamp de alta, timestamp de quiebra si aplica.

**Snapshots agregados periódicos**
- Cada cierto intervalo de tiempo simulado: foto del capital total por agente, inventario total por producto en el sistema, mejor bid/ask por producto, número de agentes activos, masa monetaria total.
- Derivables del event log pero materializados para evitar reconstrucción costosa en análisis.

**Configuración y semilla**
- Semilla maestra y configuración completa al inicio.
- Cambios de configuración durante la simulación si los hay.

---

## 15. Notificaciones

El sistema emite notificaciones push a los agentes:

**Personales (al agente afectado):**
- `order_executed` (incluyendo si es parcial o total)
- `order_expired`
- `order_cancelled`
- `transformation_completed`
- `bankruptcy_notice`

**Broadcast (a todos los agentes activos):**
- `agent_joined`
- `agent_bankrupt`

Las notificaciones son críticas para agentes reactivos. Sin ellas, los agentes tendrían que hacer polling, lo cual es ineficiente y desincroniza la simulación.

---

## 16. Resumen ejecutivo de parámetros configurables

Estos son los valores que deben quedar expuestos como configuración del sistema y que el equipo técnico debe estructurar para fácil ajuste:

- Factor de tiempo simulado (default: 5×)
- TTL mínimo y máximo de órdenes (1 minuto y 1 semana simulados)
- Rangos de capital semilla por rol
- Catálogo de tipos de instalación (mapeo receta→tipo, precios base, escalado, nivel máximo)
- Catálogo de productos
- Catálogo de recetas (con duraciones, cantidades, salarios, tipo de instalación)
- Fee de transacción: componente fijo y componente proporcional
- Fórmula de salario por duración de proceso
- Semilla maestra
- Frecuencia del sweeper de procesos
- Tamaño máximo del resumen de eventos en reconexión
- Patrón oro: usuario del banco (`BANK_USERNAME`), producto patrón (`GOLD_PRODUCT_KEY`), rango del yacimiento (`GOLD_DEPOSIT_MIN/MAX_QTY_CENT`), ratio de cobertura (`GOLD_COVERAGE_RATIO_BPS`), spread de la ventanilla (`GOLD_WINDOW_SPREAD_BPS`), capital inicial del banco (`GOLD_BANK_INITIAL_CAPITAL_CENTS`)

---

## 17. Alcance v1 vs futuro

**Dentro de v1 (lo definido en este documento):**
- Todo lo descrito arriba.
- **Participación humana:** la API debe ser capaz de aceptar participantes humanos además de agentes automatizados. El sistema no distingue entre clientes humanos y agentes programáticos: ambos consumen el mismo conjunto de operaciones (sección 3) y están sujetos a las mismas reglas de validación, fees, quiebra y notificaciones. Cualquier interfaz humana (UI web, cliente de escritorio, etc.) se construye sobre la misma API que usan los agentes.

**Diferido a v2 o posterior:**
- ~~Expansión de capacidad instalada por inversión de capital.~~ **Implementado** (economía de instalaciones, ADR-021).
- Producción primaria con insumos del entorno (agua, energía).
- Subastas de inventario de agentes quebrados.
- Variantes de calidad de productos.
- Subproductos en recetas.
- Heterogeneidad de productores (campos de tamaños distintos).
- ~~Reinyección de capital al sistema para compensar deflación por fees.~~ **Resuelto por el patrón oro** (sección 18): los fees se reciclan al banco y la masa monetaria se gobierna por acuñación/quema respaldadas.
- Niveles de visibilidad de mercado configurables por agente.

---

## 18. Patrón oro y política monetaria (añadido 2026-07)

La corrida opera bajo un **patrón oro** que gobierna la masa monetaria. Este apartado es el resumen conceptual; el detalle completo (fórmulas del seed, semántica de la ventanilla, emisión respaldada, concurrencia, configuración y auditoría) está en **`patron_oro_sistema_bancario.md`**. Implementación en `backend/src/services/bank-service.ts`, `agent-service.ts` y las tablas `gold_standard`, `gold_conversion`, `conversion_lot_consumption` y `resource_deposit` (ver `documentacion_base_datos.md`).

### Componentes

- **Banco central:** un agente especial (`central_bank`) creado por el seed con capital inicial configurable. No coloca órdenes; participa solo vía ventanilla y como receptor de fees.
- **Yacimiento finito de oro:** el oro es un producto `raw_primary` cuyo total extraíble se sortea con la semilla maestra en un rango configurable (`resource_deposit`). La producción de oro se recorta a lo que queda en el yacimiento; al agotarse se emite `deposit_depleted` y no se puede minar más.
- **Paridad y ventanilla:** el seed fija `parity = floor(M0 × coverage_bps / (100 × D))` (M0 = masa monetaria inicial, D = yacimiento). La **ventanilla acuñadora** compra oro a `window_bid` y lo vende a `window_ask` (paridad ± spread, ±5% por defecto), sin fees, vía `GET /bank` y `POST /bank/convert`.

### Reglas monetarias

1. **Vender oro al banco (`sell_gold`) acuña dinero:** el agente entrega oro (FIFO de sus lotes) y recibe dinero recién creado a `window_bid`. `money_issued` aumenta.
2. **Comprar oro al banco (`buy_gold`) destruye dinero:** el agente paga a `window_ask` y ese dinero desaparece del circuito. `money_burned` aumenta.
3. **Emisión respaldada:** la emisión neta (`issued − burned`) nunca supera `oro_del_banco × parity × coverage`. Aplica también al capital semilla de registros dinámicos.
4. **Fees al banco:** los fees de trading se acreditan al banco central (no se evaporan) y financian los registros dinámicos antes de acuñar.
5. **Masa monetaria actual** = `initial_money + money_issued − money_burned`, auditable contra el singleton `gold_standard`.

### Efecto económico

El precio de mercado del oro queda anclado a la banda `[window_bid, window_ask]` ("gold points"): si el mercado paga menos que el banco, conviene monetizar en ventanilla; si paga más, conviene comprar al banco y vender en mercado. Los bots productores y traders explotan exactamente este arbitraje (ver `funcionamiento_bots.md` §6). El yacimiento finito impone un techo duro a la expansión monetaria de la corrida.
