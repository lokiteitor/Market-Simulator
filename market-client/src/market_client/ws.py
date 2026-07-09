"""WebSocket client for real-time notifications from the Agricultural Market Simulator.

The server pushes JSON-encoded event notifications over a unidirectional
(server → client) WebSocket channel.  The client registers handlers for
specific event types (or all events via the ``*`` wildcard) and dispatches
incoming messages accordingly.

Connection lifecycle::

    ws = MarketWebSocket(base_url="http://localhost:8000/v1", access_token="tok")
    ws.on("order_executed", my_handler)
    ws.on_all(log_everything)
    await ws.listen()       # blocks, auto-reconnects on failure
    # ... from another coroutine:
    await ws.stop()

Authentication is performed via the ``?token=`` query parameter on the
WebSocket URI.  The server sends ping frames every 30 s; the underlying
*websockets* library replies with pong frames automatically.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from typing import Awaitable, Callable

import websockets
from websockets.asyncio.client import ClientConnection

from .models import WsNotification

logger = logging.getLogger(__name__)


class MarketWebSocket:
    """Async WebSocket client for the market simulator event stream.

    Parameters
    ----------
    base_url:
        HTTP(S) base URL of the API (e.g. ``http://localhost:8000/v1``).
        The scheme is converted to ``ws://`` / ``wss://`` automatically.
    access_token:
        Bearer / API token appended as ``?token=`` query parameter.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8000/v1",
        access_token: str = "",
    ) -> None:
        # Convert HTTP scheme → WS scheme.
        ws_base = base_url.replace("https://", "wss://").replace("http://", "ws://")
        self.ws_url: str = ws_base.rstrip("/") + "/ws"
        self.access_token: str = access_token

        self._connection: ClientConnection | None = None
        self._handlers: dict[str, list[Callable]] = {}
        self._running: bool = False
        self._reconnect_delay: float = 1.0

    # ------------------------------------------------------------------
    # Handler registration
    # ------------------------------------------------------------------

    def on(
        self,
        event_type: str,
        handler: Callable[[WsNotification], Awaitable[None] | None],
    ) -> None:
        """Register a handler for a specific event type.

        Parameters
        ----------
        event_type:
            One of the server event types (e.g. ``"order_executed"``).
        handler:
            Sync or async callable accepting a :class:`WsNotification`.
        """
        self._handlers.setdefault(event_type, []).append(handler)

    def on_all(
        self,
        handler: Callable[[WsNotification], Awaitable[None] | None],
    ) -> None:
        """Register a handler that receives *every* event regardless of type.

        Internally stored under the ``"*"`` wildcard key.
        """
        self._handlers.setdefault("*", []).append(handler)

    # ------------------------------------------------------------------
    # Token management
    # ------------------------------------------------------------------

    def update_token(self, access_token: str) -> None:
        """Update the access token used for future (re)connections.

        This does **not** affect the currently open connection; the new token
        will be used the next time :meth:`connect` is called.
        """
        self.access_token = access_token

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Open a WebSocket connection to the market simulator.

        The access token is sent as a ``?token=`` query parameter.
        ``ping_interval`` is set to ``None`` because the *server* is
        responsible for heartbeat pings.
        """
        uri = f"{self.ws_url}?token={self.access_token}"
        self._connection = await websockets.connect(uri, ping_interval=None)
        logger.info("WebSocket connected to %s", self.ws_url)

    async def disconnect(self) -> None:
        """Gracefully close the WebSocket connection."""
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
            logger.info("WebSocket disconnected")

    async def listen(self) -> None:
        """Main event loop: connect, read messages, dispatch, and auto-reconnect.

        This method blocks until :meth:`stop` is called.  On connection
        failures it reconnects with exponential backoff (1 s → 60 s).
        """
        self._running = True

        while self._running:
            try:
                await self.connect()
                # Successful connection — reset backoff.
                self._reconnect_delay = 1.0

                async for raw_message in self._connection:  # type: ignore[union-attr]
                    if not self._running:
                        break
                    try:
                        data = json.loads(raw_message)
                        notification = WsNotification(**data)
                    except (json.JSONDecodeError, TypeError, ValueError) as exc:
                        logger.warning("Failed to parse WS message: %s", exc)
                        continue

                    await self._dispatch(notification)

            except (
                websockets.exceptions.ConnectionClosed,
                websockets.exceptions.WebSocketException,
                OSError,
            ) as exc:
                if not self._running:
                    break
                logger.warning(
                    "WebSocket connection error: %s — reconnecting in %.1f s",
                    exc,
                    self._reconnect_delay,
                )
                await asyncio.sleep(self._reconnect_delay)
                # Exponential backoff capped at 60 s.
                self._reconnect_delay = min(self._reconnect_delay * 2, 60.0)
            finally:
                await self.disconnect()

    async def stop(self) -> None:
        """Signal the listen loop to stop and disconnect."""
        self._running = False
        await self.disconnect()

    # ------------------------------------------------------------------
    # Internal dispatch
    # ------------------------------------------------------------------

    async def _dispatch(self, notification: WsNotification) -> None:
        """Invoke all registered handlers that match *notification*.

        Handlers registered for the specific ``notification.type`` **and**
        wildcard (``"*"``) handlers are called.  Async handlers are awaited;
        sync handlers are called directly.  Exceptions inside handlers are
        logged but never propagate — a misbehaving handler must not crash the
        listener.
        """
        handlers: list[Callable] = [
            *self._handlers.get(notification.type, []),
            *self._handlers.get("*", []),
        ]

        for handler in handlers:
            try:
                result = handler(notification)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                logger.exception(
                    "Handler %r raised an exception for event %r",
                    handler,
                    notification.type,
                )
