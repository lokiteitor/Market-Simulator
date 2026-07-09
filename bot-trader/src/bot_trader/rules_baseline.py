"""Rule-based baseline strategy for the Agricultural Market Simulator bot."""

from __future__ import annotations

import logging
from typing import Dict, List

from market_client.models import AgentSnapshot, TopOfBook, Product
from .execution import Action, ActionType
from .state import StateTracker

logger = logging.getLogger(__name__)


class RuleBasedTrader:
    """Heuristic rule-based trading agent."""

    def __init__(self, tracker: StateTracker) -> None:
        self.tracker = tracker

    def decide(
        self,
        snapshot: AgentSnapshot,
        top_of_books: Dict[str, TopOfBook],
        seed_capital: int,
    ) -> Action:
        """Evaluate agent state and return the next action.
        
        Rules:
        1. Cancel any active orders that are stale (more than 3 active orders).
        2. If we have available inventory, place a SELL order for it slightly below the best ask.
        3. If we have ample capital, place a BUY order for a raw commodity slightly above the best bid.
        4. Otherwise, HOLD.
        """
        # Rule 1: Manage order bloop (cancel if we have too many active orders to free up capital/inventory)
        if len(snapshot.active_orders) > 3:
            stale_order = snapshot.active_orders[0]
            logger.info("Baseline: too many active orders. Cancelling stale order %s", stale_order.order_id)
            return Action(action_type=ActionType.CANCEL_ORDER, order_id=stale_order.order_id)

        # Rule 2: Sell inventory we hold
        for item in snapshot.inventory:
            if item.qty_available_cent > 100:  # more than 1 unit (100 centésimas)
                key = self.tracker.id_to_key.get(item.product_id)
                if not key:
                    continue
                tob = top_of_books.get(item.product_id)
                
                # Determine selling price
                price = 100  # Default fallback price
                if tob and tob.best_ask:
                    # Undercut slightly to get filled quickly
                    price = max(10, tob.best_ask.price_cents - 1)
                elif tob and tob.best_bid:
                    # Mark up from bid if no ask
                    price = int(tob.best_bid.price_cents * 1.05)
                
                # Check if we already have a sell order for this product to avoid redundancy
                already_selling = any(
                    o.product_id == item.product_id and o.side == "sell"
                    for o in snapshot.active_orders
                )
                if not already_selling:
                    # Sell 50% of available stock
                    qty = int(item.qty_available_cent * 0.5)
                    qty = max(100, qty)  # Minimum 1 unit
                    logger.info("Baseline: selling surplus inventory of %s (qty=%d, price=%d)", key, qty, price)
                    return Action(
                        action_type=ActionType.PLACE_SELL,
                        product_id=item.product_id,
                        qty_cent=qty,
                        price_cents=price
                    )

        # Rule 3: Buy raw primary commodities if we have capital
        # Primary products: wheat (trigo), corn (maiz), milk (leche), tomato (tomate), sprout (germinado)
        raw_keys = ["trigo", "maiz", "leche", "tomate"]
        
        # Only buy if we have at least 25% of seed capital available
        min_buying_capital = int(seed_capital * 0.25)
        if snapshot.capital_available_cents > min_buying_capital:
            # Check what we aren't already buying
            buying_product_ids = {
                o.product_id for o in snapshot.active_orders if o.side == "buy"
            }
            
            for key in raw_keys:
                pid = self.tracker.key_to_id.get(key)
                if not pid or pid in buying_product_ids:
                    continue
                
                tob = top_of_books.get(pid)
                price = 50  # Default fallback buy price
                if tob and tob.best_bid:
                    # Bid slightly higher to get filled
                    price = tob.best_bid.price_cents + 1
                elif tob and tob.best_ask:
                    # Discount from ask if no bid
                    price = int(tob.best_ask.price_cents * 0.95)
                
                # Place buy order with ~10% of available capital
                buy_budget = int(snapshot.capital_available_cents * 0.10)
                qty = int((buy_budget / price) * 100)
                qty = max(100, qty)  # Minimum 1 unit
                
                logger.info("Baseline: buying raw product %s (qty=%d, price=%d)", key, qty, price)
                return Action(
                    action_type=ActionType.PLACE_BUY,
                    product_id=pid,
                    qty_cent=qty,
                    price_cents=price
                )

        return Action(action_type=ActionType.HOLD)
