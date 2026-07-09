"""State observation and vectorization for the Agricultural Market Simulator bot."""

from __future__ import annotations

from typing import Dict, List, Optional
import numpy as np
from pydantic import BaseModel

from market_client.models import AgentSnapshot, Product, TopOfBook


class AgentState(BaseModel):
    """Normalized structured snapshot of the agent and market state."""

    # Agent wealth
    capital_available_ratio: float
    capital_reserved_ratio: float
    
    # Inventory positions (normalized by max expected inventory, e.g., 500.0 units = 50000 cents)
    inventory_available: Dict[str, float]  # product_key -> float
    inventory_reserved: Dict[str, float]   # product_key -> float

    # Market prices (normalized by historical baseline or mid prices, in centavos / 100)
    best_bid: Dict[str, float]             # product_key -> float (0.0 if None)
    best_ask: Dict[str, float]             # product_key -> float (0.0 if None)
    spread: Dict[str, float]               # product_key -> float


class StateTracker:
    """Manages product catalog mappings and serialises state to numpy vectors."""

    def __init__(self, products: List[Product]) -> None:
        self.products = products
        # Sorted keys to guarantee order in the observation vector
        self.product_keys = sorted([p.name.lower().replace(" ", "_") for p in products])
        
        # Mappings
        self.key_to_id: Dict[str, str] = {}
        self.id_to_key: Dict[str, str] = {}
        
        for p in products:
            key = p.name.lower().replace(" ", "_")
            self.key_to_id[key] = p.product_id
            self.id_to_key[p.product_id] = key

    @property
    def observation_dimension(self) -> int:
        """Total number of elements in the observation vector.
        
        - 2 for capital (available, reserved)
        - N_products for available inventory
        - N_products for reserved inventory
        - N_products for best bid
        - N_products for best ask
        - N_products for spread
        """
        return 2 + 5 * len(self.product_keys)

    def get_state(
        self,
        snapshot: AgentSnapshot,
        top_of_books: Dict[str, TopOfBook],
        seed_capital: float,
    ) -> AgentState:
        """Compile a normalized AgentState from snapshot and market data."""
        
        # Capital ratios
        capital_available_ratio = float(snapshot.capital_available_cents) / seed_capital
        capital_reserved_ratio = float(snapshot.capital_reserved_cents) / seed_capital

        # Inventory
        inv_avail = {k: 0.0 for k in self.product_keys}
        inv_res = {k: 0.0 for k in self.product_keys}
        
        for item in snapshot.inventory:
            key = self.id_to_key.get(item.product_id)
            if key in inv_avail:
                # Normalizing by 500 units (50000 centésimas) as a baseline scale
                inv_avail[key] = float(item.qty_available_cent) / 50000.0
                inv_res[key] = float(item.qty_reserved_cent) / 50000.0

        # Market prices
        best_bid = {k: 0.0 for k in self.product_keys}
        best_ask = {k: 0.0 for k in self.product_keys}
        spread = {k: 0.0 for k in self.product_keys}

        for key in self.product_keys:
            pid = self.key_to_id[key]
            tob = top_of_books.get(pid)
            if tob:
                bid = float(tob.best_bid.price_cents) / 100.0 if tob.best_bid else 0.0
                ask = float(tob.best_ask.price_cents) / 100.0 if tob.best_ask else 0.0
                best_bid[key] = bid
                best_ask[key] = ask
                if bid > 0 and ask > 0:
                    spread[key] = ask - bid
                else:
                    spread[key] = 0.0

        return AgentState(
            capital_available_ratio=capital_available_ratio,
            capital_reserved_ratio=capital_reserved_ratio,
            inventory_available=inv_avail,
            inventory_reserved=inv_res,
            best_bid=best_bid,
            best_ask=best_ask,
            spread=spread,
        )

    def vectorize(self, state: AgentState) -> np.ndarray:
        """Convert AgentState object to a flat float32 numpy observation vector."""
        vec = [
            state.capital_available_ratio,
            state.capital_reserved_ratio,
        ]
        
        # Add inventory
        for k in self.product_keys:
            vec.append(state.inventory_available[k])
        for k in self.product_keys:
            vec.append(state.inventory_reserved[k])
            
        # Add market info
        for k in self.product_keys:
            vec.append(state.best_bid[k])
        for k in self.product_keys:
            vec.append(state.best_ask[k])
        for k in self.product_keys:
            vec.append(state.spread[k])
            
        return np.array(vec, dtype=np.float32)
