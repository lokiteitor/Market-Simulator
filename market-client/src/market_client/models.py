"""Data-model layer for the Agricultural Market Simulator API client.

Every model is an **immutable** Pydantic v2 ``BaseModel`` (``frozen=True``).

* Money values are integers expressed in **centavos** (cents).
* Quantity values are integers expressed in **centésimas** (hundredths of the
  base unit).
* The API uses ``snake_case`` for all JSON field names — no aliasing is needed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict

__all__ = [
    "AgentPublic",
    "AgentSnapshot",
    "CapacityStatus",
    "Event",
    "EventPage",
    "InventoryLot",
    "InventoryPosition",
    "LotConsumption",
    "Order",
    "OrderPage",
    "Page",
    "PlaceOrderResponse",
    "Problem",
    "ProblemError",
    "Product",
    "Recipe",
    "RecipeInput",
    "RegisterAgentResponse",
    "TokenPair",
    "TopOfBook",
    "TopOfBookSide",
    "Trade",
    "TradePage",
    "TransformationPage",
    "TransformationProcess",
    "TransformationProcessDetail",
    "WsNotification",
]

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


class TokenPair(BaseModel):
    """Access / refresh token pair returned after login or registration."""

    model_config = ConfigDict(frozen=True)

    access_token: str
    refresh_token: str
    token_type: str
    access_expires_at: datetime
    refresh_expires_at: datetime


# ---------------------------------------------------------------------------
# Products & recipes
# ---------------------------------------------------------------------------


class Product(BaseModel):
    """A tradeable product in the market."""

    model_config = ConfigDict(frozen=True)

    product_id: str
    name: str
    unit: str
    category: Literal["raw_primary", "intermediate", "final_consumption"]
    created_at: datetime


class RecipeInput(BaseModel):
    """A single input line inside a :class:`Recipe`."""

    model_config = ConfigDict(frozen=True)

    product_id: str
    qty_required_cent: int


class Recipe(BaseModel):
    """A transformation recipe that converts inputs into an output product."""

    model_config = ConfigDict(frozen=True)

    recipe_id: str
    name: str
    output_product_id: str
    output_qty_cent: int
    duration_seconds: int
    wage_rate_cents_per_sec: int
    inputs: list[RecipeInput]
    created_at: datetime


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------


class AgentPublic(BaseModel):
    """Public-facing view of a market agent."""

    model_config = ConfigDict(frozen=True)

    agent_id: str
    username: str
    role: Literal["primary_producer", "transformer", "consumer", "trader"]
    status: Literal["active", "bankrupt"]
    registered_at: datetime
    bankrupt_at: datetime | None


# ---------------------------------------------------------------------------
# Inventory & capacity
# ---------------------------------------------------------------------------


class CapacityStatus(BaseModel):
    """Current capacity utilisation for a given recipe."""

    model_config = ConfigDict(frozen=True)

    recipe_id: str
    installations: int
    running: int
    available_slots: int


class InventoryPosition(BaseModel):
    """Aggregate inventory position for a single product."""

    model_config = ConfigDict(frozen=True)

    product_id: str
    qty_available_cent: int
    qty_reserved_cent: int


class InventoryLot(BaseModel):
    """An individual inventory lot with cost and provenance information."""

    model_config = ConfigDict(frozen=True)

    lot_id: str
    product_id: str
    origin: Literal["initial", "production", "purchase"]
    qty_original_cent: int
    qty_available_cent: int
    qty_reserved_cent: int
    unit_cost_cents: int
    acquired_at: datetime
    source_trade_id: str | None
    source_process_id: str | None


# ---------------------------------------------------------------------------
# Orders & trades
# ---------------------------------------------------------------------------


class Order(BaseModel):
    """A buy or sell order on the order book."""

    model_config = ConfigDict(frozen=True)

    order_id: str
    agent_id: str
    product_id: str
    side: Literal["buy", "sell"]
    qty_original_cent: int
    qty_pending_cent: int
    limit_price_cents: int
    status: Literal["active", "partial", "completed", "cancelled", "expired"]
    created_at: datetime
    updated_at: datetime
    expires_at: datetime


class Trade(BaseModel):
    """A single executed trade between a buyer and a seller."""

    model_config = ConfigDict(frozen=True)

    trade_id: str
    buy_order_id: str
    sell_order_id: str
    buyer_agent_id: str
    seller_agent_id: str
    product_id: str
    qty_executed_cent: int
    price_cents: int
    fee_buyer_cents: int
    fee_seller_cents: int
    executed_at: datetime


class PlaceOrderResponse(Order):
    """Response returned when a new order is placed.

    Extends :class:`Order` with the list of trades that were immediately
    generated by the matching engine.
    """

    trades_generated: list[Trade]


# ---------------------------------------------------------------------------
# Market data (top-of-book)
# ---------------------------------------------------------------------------


class TopOfBookSide(BaseModel):
    """Best bid or best ask entry at the top of the order book."""

    model_config = ConfigDict(frozen=True)

    order_id: str
    agent_id: str
    price_cents: int
    qty_pending_cent: int


class TopOfBook(BaseModel):
    """Top-of-book snapshot for a single product."""

    model_config = ConfigDict(frozen=True)

    product_id: str
    observed_at: datetime
    best_bid: TopOfBookSide | None
    best_ask: TopOfBookSide | None


# ---------------------------------------------------------------------------
# Transformation processes
# ---------------------------------------------------------------------------


class TransformationProcess(BaseModel):
    """A running (or completed) transformation process."""

    model_config = ConfigDict(frozen=True)

    process_id: str
    agent_id: str
    recipe_id: str
    executions_planned: int
    current_execution: int
    status: Literal["running", "completed", "cancelled"]
    wage_paid_cents: int
    started_at: datetime
    expected_end_at: datetime
    actual_end_at: datetime | None


class LotConsumption(BaseModel):
    """Record of inventory consumed by a transformation process."""

    model_config = ConfigDict(frozen=True)

    lot_id: str
    product_id: str
    qty_consumed_cent: int
    unit_cost_cents: int


class TransformationProcessDetail(TransformationProcess):
    """Extended view of a :class:`TransformationProcess` with I/O details."""

    inputs_consumed: list[LotConsumption]
    produced_lot: InventoryLot | None


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


class Event(BaseModel):
    """A domain event recorded by the simulator."""

    model_config = ConfigDict(frozen=True)

    event_id: str
    event_type: str
    agent_id: str | None
    occurred_at: datetime
    payload: dict[str, Any]


# ---------------------------------------------------------------------------
# Agent snapshot (composite)
# ---------------------------------------------------------------------------


class AgentSnapshot(BaseModel):
    """Full snapshot of an agent's current state."""

    model_config = ConfigDict(frozen=True)

    agent: AgentPublic
    capital_available_cents: int
    capital_reserved_cents: int
    inventory: list[InventoryPosition] = []
    active_orders: list[Order] = []
    running_processes: list[TransformationProcess] = []
    capacities: list[CapacityStatus] = []
    recent_events: list[Event] = []


# ---------------------------------------------------------------------------
# Registration response
# ---------------------------------------------------------------------------


class RegisterAgentResponse(BaseModel):
    """Response returned when a new agent is registered.

    Combines authentication tokens with the initial agent snapshot.
    """

    model_config = ConfigDict(frozen=True)

    access_token: str
    refresh_token: str
    token_type: str
    access_expires_at: datetime
    refresh_expires_at: datetime
    agent: AgentSnapshot


# ---------------------------------------------------------------------------
# Generic pagination
# ---------------------------------------------------------------------------

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """Cursor-based pagination wrapper."""

    model_config = ConfigDict(frozen=True)

    items: list[T]
    next_cursor: str | None


OrderPage = Page[Order]
TradePage = Page[Trade]
TransformationPage = Page[TransformationProcess]
EventPage = Page[Event]

# ---------------------------------------------------------------------------
# WebSocket notifications
# ---------------------------------------------------------------------------


class WsNotification(BaseModel):
    """A real-time notification received over the WebSocket channel."""

    model_config = ConfigDict(frozen=True)

    type: str
    occurred_at: datetime
    payload: dict[str, Any]


# ---------------------------------------------------------------------------
# RFC 7807 Problem Details
# ---------------------------------------------------------------------------


class ProblemError(BaseModel):
    """A single validation / business-rule error within a :class:`Problem`."""

    model_config = ConfigDict(frozen=True)

    code: str
    field: str | None = None
    message: str


class Problem(BaseModel):
    """RFC 7807 *Problem Details* response body."""

    model_config = ConfigDict(frozen=True)

    type: str
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None
    errors: list[ProblemError] = []
