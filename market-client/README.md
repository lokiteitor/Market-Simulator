# Market Client

Python client library for the Agricultural Market Simulator API. Designed to be reused by multiple bots.

## Installation

From a bot directory:

```bash
pip install -e ../market-client
```

Or from the `market-client/` directory itself:

```bash
pip install -e .
```

For development (includes testing and linting tools):

```bash
pip install -e ".[dev]"
```

## Quick Start

```python
import asyncio
from market_client import MarketClient

async def main():
    async with MarketClient("http://localhost:8000/v1") as client:
        # Register or login
        await client.register("my_bot", "supersecretpass1", role="trader")

        # Get agent state
        state = await client.get_self_state()
        print(f"Capital: {state.capital_available_cents / 100:.2f}")

        # List products
        products = await client.list_products()
        for p in products:
            print(f"{p.name} ({p.unit})")

        # Check market
        top = await client.get_top_of_book(products[0].product_id)
        print(f"Best bid: {top.best_bid}")
        print(f"Best ask: {top.best_ask}")

        # Place an order
        order = await client.place_order(
            product_id=products[0].product_id,
            side="buy",
            qty_cent=1000,
            limit_price_cents=500,
            ttl_seconds=3600,
        )
        print(f"Order placed: {order.order_id}")

asyncio.run(main())
```

## WebSocket Streaming

Subscribe to real-time events using the WebSocket interface:

```python
from market_client import MarketClient, MarketWebSocket, WsNotification

async def on_trade(event: WsNotification):
    print(f"Trade executed: {event.payload}")

async def main():
    async with MarketClient("http://localhost:8000/v1") as client:
        tokens = await client.login("my_bot", "supersecretpass1")

        ws = MarketWebSocket("http://localhost:8000/v1", tokens.access_token)
        ws.on("order_executed", on_trade)
        await ws.listen()  # Blocks until stopped
```

## API Coverage

All methods are available on the `MarketClient` instance.

### Auth

| Method | Description |
|--------|-------------|
| `register(username, password, role)` | Create a new agent and receive auth tokens |
| `login(username, password)` | Authenticate and receive auth tokens |
| `refresh()` | Refresh the access token using the stored refresh token |

### Agent

| Method | Description |
|--------|-------------|
| `get_self_state()` | Get the authenticated agent's current state (capital, inventory, etc.) |

### Catalog

| Method | Description |
|--------|-------------|
| `list_products()` | List all available products in the market |

### Market

| Method | Description |
|--------|-------------|
| `get_top_of_book(product_id)` | Get the best bid/ask for a product |
| `get_order_book(product_id)` | Get the full order book depth for a product |

### Orders

| Method | Description |
|--------|-------------|
| `place_order(product_id, side, qty_cent, limit_price_cents, ttl_seconds)` | Place a new limit order |
| `cancel_order(order_id)` | Cancel an existing open order |
| `list_my_orders(status)` | List the agent's orders, optionally filtered by status |

### Transformations

| Method | Description |
|--------|-------------|
| `list_recipes()` | List all available transformation recipes |
| `start_transformation(recipe_id, qty_cent)` | Start a transformation (e.g., mill wheat → flour) |

### History

| Method | Description |
|--------|-------------|
| `get_trade_history(product_id, limit)` | Get recent trade history for a product |
| `get_price_candles(product_id, interval)` | Get OHLCV price candles for a product |

## Units Convention

> **Important:** All money values in the API are expressed in **centavos** (1/100 of the
> base currency). Divide by 100 for display. All quantities are in **centésimas**
> (1/100 of the base unit). For example, `qty_cent=1000` means 10.00 units and
> `limit_price_cents=500` means 5.00 in currency.
