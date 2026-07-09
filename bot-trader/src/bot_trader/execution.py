"""Action definitions and execution mapping for the market simulator bot."""

from __future__ import annotations

import logging
from enum import IntEnum
from typing import Optional
from pydantic import BaseModel

from market_client import MarketClient
from market_client.exceptions import MarketAPIError

logger = logging.getLogger(__name__)


class ActionType(IntEnum):
    """Supported bot action types."""
    HOLD = 0
    PLACE_BUY = 1
    PLACE_SELL = 2
    CANCEL_ORDER = 3


class Action(BaseModel):
    """Structured bot action representation."""
    action_type: ActionType
    product_id: Optional[str] = None
    price_cents: int = 0
    qty_cent: int = 0
    ttl_seconds: int = 3600
    order_id: Optional[str] = None


class ActionExecutor:
    """Handles execution of Action objects against the MarketClient."""

    def __init__(self, client: MarketClient) -> None:
        self.client = client

    async def execute(self, action: Action) -> bool:
        """Execute the action. Return True if successful, False otherwise."""
        try:
            if action.action_type == ActionType.HOLD:
                logger.debug("Action: HOLD")
                return True
                
            elif action.action_type == ActionType.PLACE_BUY:
                if not action.product_id or action.qty_cent <= 0 or action.price_cents <= 0:
                    logger.warning("Action: BUY invalid parameters: %s", action)
                    return False
                logger.info(
                    "Action: PLACE_BUY product=%s qty=%d price=%d",
                    action.product_id, action.qty_cent, action.price_cents
                )
                await self.client.place_order(
                    product_id=action.product_id,
                    side="buy",
                    qty_cent=action.qty_cent,
                    limit_price_cents=action.price_cents,
                    ttl_seconds=action.ttl_seconds
                )
                return True
                
            elif action.action_type == ActionType.PLACE_SELL:
                if not action.product_id or action.qty_cent <= 0 or action.price_cents <= 0:
                    logger.warning("Action: SELL invalid parameters: %s", action)
                    return False
                logger.info(
                    "Action: PLACE_SELL product=%s qty=%d price=%d",
                    action.product_id, action.qty_cent, action.price_cents
                )
                await self.client.place_order(
                    product_id=action.product_id,
                    side="sell",
                    qty_cent=action.qty_cent,
                    limit_price_cents=action.price_cents,
                    ttl_seconds=action.ttl_seconds
                )
                return True
                
            elif action.action_type == ActionType.CANCEL_ORDER:
                if not action.order_id:
                    logger.warning("Action: CANCEL invalid parameters: %s", action)
                    return False
                logger.info("Action: CANCEL order=%s", action.order_id)
                await self.client.cancel_order(order_id=action.order_id)
                return True
                
        except MarketAPIError as exc:
            logger.error("API error during action execution: %s", exc)
            return False
        except Exception as exc:
            logger.exception("Unexpected error executing action: %s", exc)
            return False
            
        return False
