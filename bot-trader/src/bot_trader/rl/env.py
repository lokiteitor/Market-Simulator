"""Gymnasium environment wrapper for the Agricultural Market Simulator."""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Dict, List, Tuple

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from market_client import MarketClient
from market_client.exceptions import MarketAPIError
from market_client.models import AgentSnapshot, Product, TopOfBook

from bot_trader.config import Config
from bot_trader.execution import Action, ActionExecutor, ActionType
from bot_trader.state import AgentState, StateTracker

logger = logging.getLogger(__name__)


def run_async(coro) -> Any:
    """Helper to run async coroutines synchronously."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


class MarketEnv(gym.Env):
    """Gymnasium environment wrapping the Agricultural Market Simulator API."""

    metadata = {"render_modes": ["human"]}

    def __init__(
        self,
        api_url: str = Config.API_URL,
        username_prefix: str = Config.USERNAME,
        password: str = Config.PASSWORD,
        tick_interval: float = Config.TICK_INTERVAL,
    ) -> None:
        super().__init__()
        self.api_url = api_url
        self.username_prefix = username_prefix
        self.password = password
        self.tick_interval = tick_interval
        
        # Async HTTP client
        self.client = MarketClient(base_url=self.api_url)
        self.executor = ActionExecutor(self.client)
        
        # State and product tracking
        self.tracker: StateTracker | None = None
        self.current_state: AgentState | None = None
        self.username: str | None = None
        self.is_bankrupt = False
        self.seed_capital: float = 0.0

        # Spaces definitions
        # N_products = 11.
        # Action space: 1 (HOLD) + 3 * 11 (BUY, SELL, CANCEL per product) = 34 discrete actions.
        self.action_space = spaces.Discrete(34)
        
        # Observation space will be initialized on reset once products catalog is fetched.
        # Observation size = 2 + 5 * 11 = 57 elements.
        self.observation_space = spaces.Box(
            low=-1e6,
            high=1e6,
            shape=(57,),
            dtype=np.float32
        )

    def _get_reconnect_loop(self) -> None:
        """Ensure connection and registration."""
        run_async(self._async_connect())

    async def _async_connect(self) -> None:
        """Async registration or login if needed."""
        # Fetch catalog products first
        products = await self.client.list_products()
        self.tracker = StateTracker(products)
        
        # If first run or bankrupt, register a new agent
        if self.username is None or self.is_bankrupt:
            self.username = f"{self.username_prefix}_{uuid.uuid4().hex[:6]}"
            logger.info("Registering new agent: %s", self.username)
            try:
                await self.client.register(
                    username=self.username,
                    password=self.password,
                    role="trader"
                )
                self.is_bankrupt = False
            except MarketAPIError as exc:
                logger.error("Registration failed: %s. Attempting login.", exc)
                await self.client.login(username=self.username, password=self.password)

        # Get initial state to determine seed capital
        snapshot = await self.client.get_self_state()
        self.seed_capital = float(snapshot.capital_available_cents + snapshot.capital_reserved_cents)
        logger.info("Env determined seed capital: %.2f cents", self.seed_capital)

    async def _fetch_observations(self) -> Tuple[AgentSnapshot, Dict[str, TopOfBook]]:
        """Fetch snapshot and book states in parallel."""
        snapshot = await self.client.get_self_state()
        
        # Fetch all top of books in parallel
        tasks = [self.client.get_top_of_book(p.product_id) for p in self.tracker.products]
        tops = await asyncio.gather(*tasks)
        top_of_books = {t.product_id: t for t in tops}
        
        return snapshot, top_of_books

    def reset(
        self,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        """Reset the environment. Registers a new agent if bankrupt."""
        super().reset(seed=seed)
        
        # Ensure we are registered & logged in
        run_async(self._async_connect())
        
        # Fetch initial observation data
        snapshot, top_of_books = run_async(self._fetch_observations())
        
        # Update state
        self.current_state = self.tracker.get_state(snapshot, top_of_books, self.seed_capital)
        obs = self.tracker.vectorize(self.current_state)
        
        return obs, {"username": self.username, "capital": snapshot.capital_available_cents}

    def _decode_action(self, action_idx: int, snapshot: AgentSnapshot, top_of_books: Dict[str, TopOfBook]) -> Action:
        """Decode discrete action ID into a structured Action object."""
        if action_idx == 0:
            return Action(action_type=ActionType.HOLD)

        # Normalize index to product
        # product_idx = (action_idx - 1) // 3
        # type_offset = (action_idx - 1) % 3
        product_idx = int((action_idx - 1) // 3)
        action_sub_type = int((action_idx - 1) % 3)
        
        if product_idx >= len(self.tracker.product_keys):
            return Action(action_type=ActionType.HOLD)
            
        key = self.tracker.product_keys[product_idx]
        pid = self.tracker.key_to_id[key]
        tob = top_of_books.get(pid)

        if action_sub_type == 0:
            # BUY action
            price = 50  # default cents
            if tob and tob.best_bid:
                price = tob.best_bid.price_cents + 1
            elif tob and tob.best_ask:
                price = int(tob.best_ask.price_cents * 0.95)
            
            # Buy 1 unit (100 centésimas)
            return Action(
                action_type=ActionType.PLACE_BUY,
                product_id=pid,
                qty_cent=100,
                price_cents=max(1, price)
            )
            
        elif action_sub_type == 1:
            # SELL action
            price = 100  # default cents
            if tob and tob.best_ask:
                price = tob.best_ask.price_cents - 1
            elif tob and tob.best_bid:
                price = int(tob.best_bid.price_cents * 1.05)
                
            # Sell 1 unit (100 centésimas)
            return Action(
                action_type=ActionType.PLACE_SELL,
                product_id=pid,
                qty_cent=100,
                price_cents=max(1, price)
            )
            
        elif action_sub_type == 2:
            # CANCEL action (cancel oldest active order for this product)
            target_order_id = None
            for order in snapshot.active_orders:
                if order.product_id == pid:
                    target_order_id = order.order_id
                    break
            return Action(
                action_type=ActionType.CANCEL_ORDER,
                order_id=target_order_id
            )

        return Action(action_type=ActionType.HOLD)

    def step(
        self,
        action: int,
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        """Run one timestep of the agent's logic."""
        # 1. Fetch current view of the world
        snapshot, top_of_books = run_async(self._fetch_observations())
        
        # 2. Decode & execute action
        decoded_action = self._decode_action(action, snapshot, top_of_books)
        action_success = run_async(self.executor.execute(decoded_action))
        
        # 3. Wait for tick interval (real time) to let simulation execute trades
        run_async(asyncio.sleep(self.tick_interval))
        
        # 4. Fetch updated observations
        new_snapshot, new_top_of_books = run_async(self._fetch_observations())
        
        # 5. Build new state vector
        prev_state = self.current_state
        self.current_state = self.tracker.get_state(new_snapshot, new_top_of_books, self.seed_capital)
        obs = self.tracker.vectorize(self.current_state)
        
        # 6. Check terminations
        self.is_bankrupt = (new_snapshot.agent.status == "bankrupt")
        terminated = self.is_bankrupt
        
        # 7. Compute reward
        from bot_trader.rl.reward import compute_reward
        reward = compute_reward(prev_state, self.current_state, terminated, action_success)
        
        return obs, reward, terminated, False, {
            "username": self.username,
            "action_executed": decoded_action.action_type.name,
            "capital": new_snapshot.capital_available_cents,
        }

    def close(self) -> None:
        """Close client sessions."""
        run_async(self.client.close())
