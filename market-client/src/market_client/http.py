"""Core HTTP client for the Agricultural Market Simulator API.

Wraps :class:`httpx.AsyncClient` with automatic JWT authentication
management, transparent token refresh, and typed Pydantic model
responses for every endpoint.

Usage::

    async with MarketClient() as client:
        await client.login("alice", "s3cret")
        products = await client.list_products()
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from .models import (
    AgentPublic,
    AgentSnapshot,
    CapacityStatus,
    EventPage,
    InventoryLot,
    InventoryPosition,
    Order,
    OrderPage,
    PlaceOrderResponse,
    Problem,
    Product,
    Recipe,
    RegisterAgentResponse,
    TokenPair,
    TopOfBook,
    Trade,
    TradePage,
    TransformationPage,
    TransformationProcess,
    TransformationProcessDetail,
)
from .exceptions import (
    MarketAPIError,
    AuthenticationError,
    ForbiddenError,
    NotFoundError,
    DomainValidationError,
    ConflictError,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class MarketClient:
    """Async HTTP client for the Agricultural Market Simulator API.

    Parameters
    ----------
    base_url:
        Root URL of the API including the version prefix,
        e.g. ``http://localhost:8000/v1``.
    timeout:
        Default request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8000/v1",
        timeout: float = 30.0,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
        )
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        self._access_expires_at: datetime | None = None

    # -- Context manager -----------------------------------------------------

    async def __aenter__(self) -> MarketClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying HTTP transport."""
        await self._client.aclose()

    # -- Internal helpers ----------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        """Return an ``Authorization`` header dict, or empty if unauthenticated."""
        if self._access_token:
            return {"Authorization": f"Bearer {self._access_token}"}
        return {}

    def _is_token_expiring(self, buffer_seconds: int = 60) -> bool:
        """Return ``True`` if the access token expires within *buffer_seconds*."""
        if self._access_token is None or self._access_expires_at is None:
            return True
        remaining = (
            self._access_expires_at - datetime.now(timezone.utc)
        ).total_seconds()
        return remaining < buffer_seconds

    async def _ensure_auth(self) -> None:
        """Transparently refresh the access token when it is near expiry."""
        if self._refresh_token and self._is_token_expiring():
            logger.info("Access token expiring soon – refreshing automatically")
            await self.refresh()

    def _store_tokens(self, pair: TokenPair) -> None:
        """Persist token data returned by login / register / refresh."""
        self._access_token = pair.access_token
        self._refresh_token = pair.refresh_token
        self._access_expires_at = pair.access_expires_at
        logger.info("Tokens stored (expires at %s)", self._access_expires_at)

    def _clear_tokens(self) -> None:
        self._access_token = None
        self._refresh_token = None
        self._access_expires_at = None

    @staticmethod
    def _clean_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
        """Remove ``None`` values from a query-parameter dict."""
        if params is None:
            return None
        cleaned = {k: v for k, v in params.items() if v is not None}
        return cleaned or None

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        auth_required: bool = True,
    ) -> httpx.Response:
        """Send an HTTP request with optional auth and automatic retry on 401.

        Parameters
        ----------
        method:
            HTTP method (``GET``, ``POST``, ``DELETE``, …).
        path:
            URL path relative to *base_url* (e.g. ``/orders``).
        json:
            JSON body payload.
        params:
            Query parameters.  ``None`` values are stripped automatically.
            List values are passed through to *httpx* which serialises them
            as repeated query-string keys.
        auth_required:
            When ``True`` (default) the request includes the current
            ``Authorization`` header and triggers a transparent token
            refresh if the access token is near expiry.
        """
        params = self._clean_params(params)

        headers: dict[str, str] = {}
        if auth_required:
            await self._ensure_auth()
            headers.update(self._auth_headers())

        logger.debug("%s %s params=%s json=%s", method, path, params, json)

        response = await self._client.request(
            method,
            path,
            headers=headers,
            json=json,
            params=params,
        )

        # Transparent 401 retry – refresh once, then replay the request.
        if response.status_code == 401 and self._refresh_token:
            logger.info("Received 401 – attempting token refresh and retry")
            await self.refresh()
            headers.update(self._auth_headers())
            response = await self._client.request(
                method,
                path,
                headers=headers,
                json=json,
                params=params,
            )

        if response.is_client_error or response.is_server_error:
            problem: Problem | None = None
            message = f"HTTP {response.status_code} on {method} {path}"
            try:
                problem = Problem.model_validate(response.json())
                message = f"{message}: {problem.detail}" if hasattr(problem, "detail") else message
            except Exception:  # noqa: BLE001
                body = response.text
                if body:
                    message = f"{message}: {body}"
            exc_map = {
                401: AuthenticationError,
                403: ForbiddenError,
                404: NotFoundError,
                409: ConflictError,
                422: DomainValidationError,
            }
            exc_cls = exc_map.get(response.status_code, MarketAPIError)
            raise exc_cls(
                status_code=response.status_code,
                message=message,
                problem=problem,
            )

        return response

    # -----------------------------------------------------------------------
    # Auth endpoints (public – no auth required)
    # -----------------------------------------------------------------------

    async def register(
        self,
        username: str,
        password: str,
        role: str = "trader",
    ) -> RegisterAgentResponse:
        """POST /auth/register – create a new agent and store tokens."""
        resp = await self._request(
            "POST",
            "/auth/register",
            json={"username": username, "password": password, "role": role},
            auth_required=False,
        )
        result = RegisterAgentResponse.model_validate(resp.json())
        self._store_tokens(
            TokenPair(
                access_token=result.access_token,
                refresh_token=result.refresh_token,
                token_type=result.token_type,
                access_expires_at=result.access_expires_at,
                refresh_expires_at=result.refresh_expires_at,
            )
        )
        logger.info("Registered as %r (role=%s)", username, role)
        return result

    async def login(self, username: str, password: str) -> TokenPair:
        """POST /auth/login – authenticate and store tokens."""
        resp = await self._request(
            "POST",
            "/auth/login",
            json={"username": username, "password": password},
            auth_required=False,
        )
        pair = TokenPair.model_validate(resp.json())
        self._store_tokens(pair)
        logger.info("Logged in as %r", username)
        return pair

    async def refresh(self) -> TokenPair:
        """POST /auth/refresh – exchange the refresh token for a new pair."""
        resp = await self._request(
            "POST",
            "/auth/refresh",
            json={"refresh_token": self._refresh_token},
            auth_required=False,
        )
        pair = TokenPair.model_validate(resp.json())
        self._store_tokens(pair)
        logger.info("Token refreshed successfully")
        return pair

    async def logout(self) -> None:
        """POST /auth/logout – invalidate the current refresh token."""
        await self._request(
            "POST",
            "/auth/logout",
            json={"refresh_token": self._refresh_token},
            auth_required=False,
        )
        self._clear_tokens()
        logger.info("Logged out – tokens cleared")

    # -----------------------------------------------------------------------
    # Agent endpoints (auth required)
    # -----------------------------------------------------------------------

    async def get_self_state(
        self,
        events_limit: int | None = None,
    ) -> AgentSnapshot:
        """GET /agents/me – retrieve the authenticated agent's full state."""
        resp = await self._request(
            "GET",
            "/agents/me",
            params={"events_limit": events_limit},
        )
        return AgentSnapshot.model_validate(resp.json())

    async def get_inventory(
        self,
        product_id: str | None = None,
    ) -> list[InventoryPosition]:
        """GET /agents/me/inventory – list inventory positions."""
        resp = await self._request(
            "GET",
            "/agents/me/inventory",
            params={"product_id": product_id},
        )
        return [InventoryPosition.model_validate(item) for item in resp.json()]

    async def get_inventory_lots(
        self,
        product_id: str | None = None,
        only_with_stock: bool = True,
    ) -> list[InventoryLot]:
        """GET /agents/me/inventory/lots – list individual inventory lots."""
        resp = await self._request(
            "GET",
            "/agents/me/inventory/lots",
            params={
                "product_id": product_id,
                "only_with_stock": only_with_stock,
            },
        )
        return [InventoryLot.model_validate(item) for item in resp.json()]

    async def get_capacities(self) -> list[CapacityStatus]:
        """GET /agents/me/capacities – list agent capacity statuses."""
        resp = await self._request("GET", "/agents/me/capacities")
        return [CapacityStatus.model_validate(item) for item in resp.json()]

    async def get_public_agent(self, agent_id: str) -> AgentPublic:
        """GET /agents/{agent_id} – fetch public profile of an agent."""
        resp = await self._request("GET", f"/agents/{agent_id}")
        return AgentPublic.model_validate(resp.json())

    # -----------------------------------------------------------------------
    # Catalog endpoints (public – no auth required)
    # -----------------------------------------------------------------------

    async def list_products(self) -> list[Product]:
        """GET /catalog/products – list all available products."""
        resp = await self._request(
            "GET",
            "/catalog/products",
            auth_required=False,
        )
        return [Product.model_validate(item) for item in resp.json()]

    async def get_product(self, product_id: str) -> Product:
        """GET /catalog/products/{product_id} – retrieve a single product."""
        resp = await self._request(
            "GET",
            f"/catalog/products/{product_id}",
            auth_required=False,
        )
        return Product.model_validate(resp.json())

    async def list_recipes(
        self,
        output_product_id: str | None = None,
    ) -> list[Recipe]:
        """GET /catalog/recipes – list recipes, optionally filtered."""
        resp = await self._request(
            "GET",
            "/catalog/recipes",
            params={"output_product_id": output_product_id},
            auth_required=False,
        )
        return [Recipe.model_validate(item) for item in resp.json()]

    async def get_recipe(self, recipe_id: str) -> Recipe:
        """GET /catalog/recipes/{recipe_id} – retrieve a single recipe."""
        resp = await self._request(
            "GET",
            f"/catalog/recipes/{recipe_id}",
            auth_required=False,
        )
        return Recipe.model_validate(resp.json())

    # -----------------------------------------------------------------------
    # Market endpoints (auth required)
    # -----------------------------------------------------------------------

    async def get_top_of_book(self, product_id: str) -> TopOfBook:
        """GET /market/{product_id}/top – best bid/ask for a product."""
        resp = await self._request("GET", f"/market/{product_id}/top")
        return TopOfBook.model_validate(resp.json())

    async def get_recent_trades(
        self,
        product_id: str,
        since: str | None = None,
        limit: int = 100,
    ) -> list[Trade]:
        """GET /market/{product_id}/trades – recent trades for a product."""
        resp = await self._request(
            "GET",
            f"/market/{product_id}/trades",
            params={"since": since, "limit": limit},
        )
        return [Trade.model_validate(item) for item in resp.json()]

    # -----------------------------------------------------------------------
    # Order endpoints (auth required)
    # -----------------------------------------------------------------------

    async def place_order(
        self,
        product_id: str,
        side: str,
        qty_cent: int,
        limit_price_cents: int,
        ttl_seconds: int,
        client_order_id: str | None = None,
    ) -> PlaceOrderResponse:
        """POST /orders – place a new limit order."""
        body: dict[str, Any] = {
            "product_id": product_id,
            "side": side,
            "qty_cent": qty_cent,
            "limit_price_cents": limit_price_cents,
            "ttl_seconds": ttl_seconds,
        }
        if client_order_id is not None:
            body["client_order_id"] = client_order_id
        resp = await self._request("POST", "/orders", json=body)
        return PlaceOrderResponse.model_validate(resp.json())

    async def cancel_order(self, order_id: str) -> Order | None:
        """DELETE /orders/{order_id} – cancel an open order.

        Returns the :class:`Order` if the server responds with 200
        (order was already in a terminal state), or ``None`` on 204
        (cancellation accepted).
        """
        resp = await self._request("DELETE", f"/orders/{order_id}")
        if resp.status_code == 204:
            return None
        return Order.model_validate(resp.json())

    async def get_order(self, order_id: str) -> Order:
        """GET /orders/{order_id} – retrieve order details."""
        resp = await self._request("GET", f"/orders/{order_id}")
        return Order.model_validate(resp.json())

    async def list_orders(
        self,
        status: list[str] | None = None,
        product_id: str | None = None,
        side: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> OrderPage:
        """GET /orders – list orders with optional filters and pagination."""
        resp = await self._request(
            "GET",
            "/orders",
            params={
                "status": status,
                "product_id": product_id,
                "side": side,
                "limit": limit,
                "cursor": cursor,
            },
        )
        return OrderPage.model_validate(resp.json())

    async def get_order_trades(self, order_id: str) -> list[Trade]:
        """GET /orders/{order_id}/trades – trades that filled this order."""
        resp = await self._request("GET", f"/orders/{order_id}/trades")
        return [Trade.model_validate(item) for item in resp.json()]

    # -----------------------------------------------------------------------
    # Transformation endpoints (auth required)
    # -----------------------------------------------------------------------

    async def start_transformation(
        self,
        recipe_id: str,
        executions_planned: int,
    ) -> TransformationProcess:
        """POST /transformations – begin a new transformation process."""
        resp = await self._request(
            "POST",
            "/transformations",
            json={
                "recipe_id": recipe_id,
                "executions_planned": executions_planned,
            },
        )
        return TransformationProcess.model_validate(resp.json())

    async def cancel_transformation(self, process_id: str) -> None:
        """DELETE /transformations/{process_id} – cancel a running transformation."""
        await self._request("DELETE", f"/transformations/{process_id}")

    async def get_transformation(
        self,
        process_id: str,
    ) -> TransformationProcessDetail:
        """GET /transformations/{process_id} – retrieve transformation details."""
        resp = await self._request("GET", f"/transformations/{process_id}")
        return TransformationProcessDetail.model_validate(resp.json())

    async def list_transformations(
        self,
        status: list[str] | None = None,
        recipe_id: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> TransformationPage:
        """GET /transformations – list transformations with filters."""
        resp = await self._request(
            "GET",
            "/transformations",
            params={
                "status": status,
                "recipe_id": recipe_id,
                "limit": limit,
                "cursor": cursor,
            },
        )
        return TransformationPage.model_validate(resp.json())

    # -----------------------------------------------------------------------
    # History endpoints (auth required)
    # -----------------------------------------------------------------------

    async def get_trade_history(
        self,
        side: str | None = None,
        product_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 200,
        cursor: str | None = None,
    ) -> TradePage:
        """GET /history/trades – paginated trade history."""
        resp = await self._request(
            "GET",
            "/history/trades",
            params={
                "side": side,
                "product_id": product_id,
                "since": since,
                "until": until,
                "limit": limit,
                "cursor": cursor,
            },
        )
        return TradePage.model_validate(resp.json())

    async def get_event_history(
        self,
        event_type: list[str] | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 200,
        cursor: str | None = None,
    ) -> EventPage:
        """GET /history/events – paginated event history."""
        resp = await self._request(
            "GET",
            "/history/events",
            params={
                "event_type": event_type,
                "since": since,
                "until": until,
                "limit": limit,
                "cursor": cursor,
            },
        )
        return EventPage.model_validate(resp.json())
