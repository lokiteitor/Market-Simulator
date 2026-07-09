# 🤖 Agricultural Market Simulator - Python Agents & Client

Este repositorio contiene las herramientas en Python para interactuar con la simulación del mercado agrícola.

Se divide en dos partes:
1. **`market-client/`**: Una librería de Python independiente y reutilizable que expone un cliente REST (`MarketClient`) y un cliente de streaming WebSocket (`MarketWebSocket`) con tipado estático completo.
2. **`bot-trader/`**: Un bot que implementa tanto una estrategia basada en reglas como un pipeline de aprendizaje por refuerzo (RL) usando Gymnasium y Stable-Baselines3 (PPO) sobre CPU.

---

## 📋 Requisitos Rápidos

* Python 3.12 o superior.
* Servidor del Mercado Agrícola ejecutándose (usualmente vía Docker Compose con APISIX Gateway escuchando en `http://localhost:9080/v1`).

---

## 🚀 Guía de Inicio Rápido

Ejecuta los siguientes comandos desde la raíz del proyecto para instalar todo y correr el bot baseline:

```bash
# 1. Instalar la librería cliente en tu entorno virtual (editable)
pip install -e ./market-client

# 2. Instalar el bot trader con dependencias de Machine Learning
pip install -e ./bot-trader[ml]

# 3. Correr el bot heurístico baseline (Fase 1)
python3 -m bot_trader.main rules

# 4. Entrenar la red neuronal PPO sobre CPU (Fase 3)
python3 -m bot_trader.rl.train
```

---

## 🗺️ Estructura y Flujo del Código

```
├── market-client/              # Librería reutilizable
│   ├── src/market_client/
│   │   ├── http.py             # Cliente Async HTTP (httpx), maneja auto-refresh de JWT
│   │   ├── ws.py               # Cliente WebSocket con auto-reconnect
│   │   ├── models.py           # Modelos de datos Pydantic v2 (centavos y centésimas)
│   │   └── exceptions.py       # Excepciones tipadas por código de estado HTTP
│
└── bot-trader/                 # Agente Inteligente
    ├── src/bot_trader/
    │   ├── main.py             # CLI de control del bot
    │   ├── rules_baseline.py   # Heurísticas de mercado básico (arbitraje, liquidación)
    │   ├── state.py            # Vectoriza el snapshot de la API a observaciones flotantes (57 variables)
    │   ├── execution.py        # Mapea decisiones discretas a llamadas a la API
    │   └── rl/
    │       ├── env.py          # Gymnasium Environment (34 acciones discretas)
    │       ├── reward.py       # Reward shaping (retorno sobre riqueza, penalización por bancarrota)
    │       └── train.py        # Script de entrenamiento con PPO
```

---

## 📈 Visualizar el Entrenamiento
Mientras entrenas con `python3 -m bot_trader.rl.train`, puedes monitorizar en tiempo real el progreso de las recompensas acumuladas y la estabilidad de la red con:
```bash
tensorboard --logdir bot-trader/logs/
```
Abre la URL indicada (usualmente `http://localhost:6006`) en tu navegador.
