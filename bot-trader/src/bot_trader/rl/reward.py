"""Reward calculation for the Agricultural Market Simulator RL bot."""

from __future__ import annotations

import logging
from .env import MarketEnv  # noqa: F401
from bot_trader.state import AgentState

logger = logging.getLogger(__name__)


def compute_reward(
    prev_state: AgentState,
    current_state: AgentState,
    is_bankrupt: bool,
    action_success: bool,
) -> float:
    """Calculate reward for transitioning from prev_state to current_state.
    
    Reward elements:
    1. delta_wealth: Change in total portfolio value (capital + estimated inventory value).
    2. bankrupt_penalty: Massive negative reward if the agent is bankrupt.
    3. execution_penalty: Small penalty if the action failed (invalid state/limits).
    4. reserve_ratio_penalty: Small penalty for keeping too much capital reserved in stale bids.
    """
    if is_bankrupt:
        return -500.0

    # 1. Delta Wealth calculation
    # We estimate product value using the best ask price (as replacement cost) or best bid.
    # Fallback to a baseline of 100 cents if no market price is available.
    def estimate_product_value(key: str, state: AgentState) -> float:
        bid = state.best_bid.get(key, 0.0)
        ask = state.best_ask.get(key, 0.0)
        if ask > 0:
            return ask
        if bid > 0:
            return bid
        return 1.0  # fallback $1.00 (100 cents)

    prev_inv_value = 0.0
    curr_inv_value = 0.0

    for key in prev_state.inventory_available.keys():
        # Scale back inventory to units (from normalized /500 ratio)
        prev_qty = (prev_state.inventory_available[key] + prev_state.inventory_reserved[key]) * 500.0
        curr_qty = (current_state.inventory_available[key] + current_state.inventory_reserved[key]) * 500.0
        
        prev_inv_value += prev_qty * estimate_product_value(key, prev_state)
        curr_inv_value += curr_qty * estimate_product_value(key, current_state)

    # Capital is normalized by seed_capital. Convert to actual units relative to seed capital.
    prev_wealth = prev_state.capital_available_ratio + prev_state.capital_reserved_ratio + (prev_inv_value / 100.0)
    curr_wealth = current_state.capital_available_ratio + current_state.capital_reserved_ratio + (curr_inv_value / 100.0)
    
    delta_wealth = curr_wealth - prev_wealth

    # Scale wealth changes: e.g. a 1% increase in wealth gives +1.0 reward.
    reward = delta_wealth * 100.0

    # 2. Action success penalty
    if not action_success:
        reward -= 2.0

    # 3. Capital utilization penalty: penalize keeping capital reserved without getting filled
    if current_state.capital_reserved_ratio > 0.8:
        reward -= 0.5

    return float(reward)
