# 🤖 Bot Trader (Agricultural Market Simulator)

Este es un agente de trading automático diseñado en Python para el simulador de mercado agrícola. Soporta tanto un **algoritmo de reglas heurísticas (baseline)** como un **modelo inteligente entrenado mediante Aprendizaje por Refuerzo (Reinforcement Learning - PPO)** usando CPU.

---

## 🛠️ Instalación y Configuración

### 1. Requisitos Previos
Asegúrate de estar usando Python 3.12 o superior.

### 2. Instalar la librería compartida `market-client`
Desde la raíz del proyecto o desde el directorio `market-client/`, instala la librería en modo editable para que el bot pueda importarla:
```bash
pip install -e ../market-client
```

### 3. Instalar las dependencias del Bot
Instala el bot con soporte para aprendizaje automático (`[ml]`):
```bash
pip install -e .[ml]
```
Esto instalará `gymnasium`, `stable-baselines3` (con PyTorch CPU por defecto) y `numpy` de forma automática.

### 4. Variables de Entorno
Puedes configurar los siguientes parámetros usando variables de entorno o un archivo `.env`:
* `API_URL`: URL del Core del simulador (Default: `http://localhost:8000/v1`).
* `BOT_USERNAME`: Nombre base para registrar al bot en el mercado (Default: `trader_bot_ml`).
* `BOT_PASSWORD`: Contraseña para el agente (Default: `SuperSecurePassword123!`).
* `TICK_INTERVAL`: Intervalo de decisión en segundos reales (Default: `5.0`).
* `TRAINING_STEPS`: Número de steps a entrenar el modelo (Default: `10000`).

---

## 🎮 Modos de Ejecución

### Opción A: Correr el Bot Baseline (Reglas Heurísticas)
Este bot utiliza reglas simples como undercut de precios, liquidación de inventario acumulado y compra de materias primas baratas. Es excelente para verificar la conectividad y servir de base de comparación.
```bash
python3 -m bot_trader.main rules
```

### Opción B: Entrenar el Agente de Aprendizaje por Refuerzo (RL)
Entrena la red neuronal mediante PPO sobre CPU. El proceso registrará dinámicamente nuevos agentes y se recuperará automáticamente ante bancarrotas.
```bash
python3 -m bot_trader.rl.train
```
Durante el entrenamiento, se guardarán checkpoints de los pesos del modelo en `models/` y logs en `logs/`. Puedes visualizar el progreso de las recompensas acumuladas con:
```bash
tensorboard --logdir ./logs/
```

### Opción C: Ejecutar Inferencia (Modelo Inteligente)
Una vez entrenado, puedes poner a correr el bot inteligente cargando el modelo final guardado:
```bash
python3 -m bot_trader.main inference --model ./models/ppo_trader_bot_final.zip
```
