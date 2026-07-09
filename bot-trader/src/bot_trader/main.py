"""Main entrypoint to run the trader bot (rules baseline or RL policy inference)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from market_client import MarketClient
from market_client.models import Product

from bot_trader.config import Config
from bot_trader.state import StateTracker
from bot_trader.execution import ActionExecutor, ActionType
from bot_trader.rules_baseline import RuleBasedTrader

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("bot_trader")


async def run_baseline():
    """Run the rule-based baseline bot in a loop."""
    logger.info("Starting Rule-Based Baseline Trader on URL: %s", Config.API_URL)
    
    async with MarketClient(base_url=Config.API_URL) as client:
        # Step 1: Register or Login
        logger.info("Logging in agent: %s", Config.USERNAME)
        try:
            # Try login
            await client.login(username=Config.USERNAME, password=Config.PASSWORD)
        except Exception:
            # Fallback to register if agent doesn't exist
            logger.info("Agent %s not found. Registering...", Config.USERNAME)
            await client.register(username=Config.USERNAME, password=Config.PASSWORD, role="trader")

        # Step 2: Fetch products and setup state tracker
        products = await client.list_products()
        tracker = StateTracker(products)
        strategy = RuleBasedTrader(tracker)
        executor = ActionExecutor(client)

        # Get initial state to determine seed capital
        initial_snap = await client.get_self_state()
        seed_capital = initial_snap.capital_available_cents + initial_snap.capital_reserved_cents
        logger.info("Baseline determined seed capital: %d cents", seed_capital)

        logger.info("Initialization complete. Entering trade loop...")
        
        while True:
            try:
                # 1. Fetch current agent snapshot
                snapshot = await client.get_self_state()
                
                # Check for bankruptcy
                if snapshot.agent.status == "bankrupt":
                    logger.critical("Agent is bankrupt! Shutting down trader loop.")
                    break
                    
                # 2. Fetch top of books for all products in parallel
                tasks = [client.get_top_of_book(p.product_id) for p in products]
                tops = await asyncio.gather(*tasks)
                top_of_books = {t.product_id: t for t in tops}

                # 3. Request decision from strategy
                action = strategy.decide(snapshot, top_of_books, seed_capital)
                
                # 4. Execute the action
                if action.action_type != ActionType.HOLD:
                    await executor.execute(action)

            except Exception as exc:
                logger.exception("Error in baseline loop: %s", exc)

            # Wait for the next tick
            await asyncio.sleep(Config.TICK_INTERVAL)


async def run_inference(model_path: str):
    """Run inference using a trained PPO model."""
    logger.info("Starting RL Policy Inference using model: %s", model_path)
    
    # Import stable-baselines3 only when needed
    try:
        from stable_baselines3 import PPO
    except ImportError:
        logger.error("stable-baselines3 is not installed. Run `pip install -e .[ml]`")
        sys.exit(1)

    from bot_trader.rl.env import MarketEnv
    
    # Create the gymnasium environment
    env = MarketEnv(
        api_url=Config.API_URL,
        username_prefix=Config.USERNAME + "_inference",
        password=Config.PASSWORD,
        tick_interval=Config.TICK_INTERVAL
    )
    
    # Load the trained model
    logger.info("Loading model from %s...", model_path)
    try:
        model = PPO.load(model_path, env=env, device="cpu")
    except Exception as exc:
        logger.error("Failed to load model: %s", exc)
        env.close()
        sys.exit(1)

    obs, info = env.reset()
    logger.info("Model loaded. Running trade inference loop...")
    
    while True:
        try:
            # Let the PPO policy predict the next action
            action, _ = model.predict(obs, deterministic=True)
            
            # Execute step in gymnasium env
            obs, reward, terminated, truncated, info = env.step(action)
            
            logger.info(
                "Step executed. Action: %s, Reward: %.2f, Terminated: %s, Capital: %s cents",
                info.get("action_executed"),
                reward,
                terminated,
                info.get("capital")
            )
            
            if terminated:
                logger.warning("Agent went bankrupt. Resetting environment...")
                obs, info = env.reset()

        except KeyboardInterrupt:
            logger.info("Shutting down inference...")
            break
        except Exception as exc:
            logger.exception("Error in inference loop: %s", exc)
            await asyncio.sleep(Config.TICK_INTERVAL)

    env.close()


def main():
    """Main entrypoint parsing CLI args."""
    parser = argparse.ArgumentParser(description="Agricultural Market Simulator Bot")
    subparsers = parser.add_subparsers(dest="mode", required=True, help="Mode of operation")

    # Baseline subparser
    subparsers.add_parser("rules", help="Run the heuristic rule-based baseline bot")

    # Inference subparser
    inference_parser = subparsers.add_parser("inference", help="Run inference using a trained PPO model")
    inference_parser.add_argument(
        "--model",
        type=str,
        default="./models/ppo_trader_bot_final.zip",
        help="Path to the saved trained PPO model .zip file"
    )

    args = parser.parse_args()

    if args.mode == "rules":
        try:
            asyncio.run(run_baseline())
        except KeyboardInterrupt:
            logger.info("Baseline bot stopped by user.")
    elif args.mode == "inference":
        asyncio.run(run_inference(args.model))


if __name__ == "__main__":
    main()
