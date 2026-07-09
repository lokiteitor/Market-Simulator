# 🤖 Sistema de Bots v1 (Agricultural Market Simulator)

Este es el sistema de agentes y bots autónomos (versión 1) escrito en Go. Utiliza el **Go SDK** oficial y su motor de agentes (`engine.Engine`) para autenticar, sincronizar el estado del mercado por WebSocket en tiempo real y ejecutar decisiones de compra/venta y procesos productivos de manera concurrente.

## 🗺️ Estructura de Archivos

* **[`main.go`](file:///home/ddelgado/git/lab/world/bots-v1/main.go)**: Orquestador y CLI que lee el archivo `config.yaml` y lanza los agentes de forma paralela en goroutines.
* **[`config.yaml`](file:///home/ddelgado/git/lab/world/bots-v1/config.yaml)**: Configuración global del servidor, precios base del catálogo y credenciales/capacidades individuales de cada agente.
* **[`primary_producer.go`](file:///home/ddelgado/git/lab/world/bots-v1/primary_producer.go)**: Comportamiento del agente productor. Cultiva/ordena insumos primarios y los vende con un margen de ganancia.
* **[`transformer.go`](file:///home/ddelgado/git/lab/world/bots-v1/transformer.go)**: Comportamiento del agente transformador. Compra insumos intermedios o primarios, ejecuta la receta de procesamiento (ej. Harina $\rightarrow$ Pan) y vende el resultado final.
* **[`consumer.go`](file:///home/ddelgado/git/lab/world/bots-v1/consumer.go)**: Comportamiento del consumidor final. Compra bienes listos para el consumo (categoría `final_consumption`) retirándolos de circulación para simular la demanda real.
* **[`trader.go`](file:///home/ddelgado/git/lab/world/bots-v1/trader.go)**: Comportamiento del agente especulador/trader. Compra barato (descuento del 15% bajo el precio promedio/base) y vende caro (15% de markup).

---

## 🚀 Cómo Compilar y Ejecutar

### 1. Compilación
Asegúrate de compilar el binario desde esta carpeta:
```bash
go build -o bots-v1-runner
```

### 2. Ejecución
Para iniciar la simulación de bots concurrentes:
```bash
./bots-v1-runner -config config.yaml
```

---

## 🛠️ Personalización de Parámetros

El archivo **[`config.yaml`](file:///home/ddelgado/git/lab/world/bots-v1/config.yaml)** te permite configurar:
1. **`server`**: Los puntos de enlace HTTP y WebSocket del APISIX Gateway del simulador.
2. **`prices`**: El precio base estimado de cada producto (en centavos de capital) usado por las heurísticas para calcular márgenes o límites de compra/venta.
3. **`bots`**: Una lista de agentes configurables. Cada uno especifica:
   * `username` / `password`: Credenciales de acceso.
   * `role`: Uno de los 4 roles admitidos (`primary_producer`, `transformer`, `consumer`, `trader`).
   * `auto_register`: Si se establece en `true`, el bot intentará registrarse en el servidor automáticamente si sus credenciales no existen.
   * `requested_capacities`: Las recetas y números de instalaciones productivas iniciales que tiene permitidas usar.
