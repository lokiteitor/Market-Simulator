"""PPO training script for the Agricultural Market Simulator bot."""

from __future__ import annotations

import os
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback

from bot_trader.rl.env import MarketEnv
from bot_trader.config import Config


def train():
    """Start PPO model training on CPU."""
    print("Initializing Market Simulator Environment...")
    env = MarketEnv(
        api_url=Config.API_URL,
        username_prefix=Config.USERNAME,
        password=Config.PASSWORD,
        tick_interval=Config.TICK_INTERVAL,
    )
    
    # Create directories for saving model artifacts
    os.makedirs("models", exist_ok=True)
    os.makedirs("logs", exist_ok=True)
    
    print("Setting up PPO Policy Network on CPU...")
    # Initialize PPO agent. We use a standard MLP policy with 3 layers.
    # We use a small learning rate and policy architecture suitable for small discrete action spaces.
    model = PPO(
        "MlpPolicy",
        env,
        learning_rate=3e-4,
        n_steps=512,            # Short step horizon for low-latency updates
        batch_size=64,
        n_epochs=5,
        gamma=0.99,
        verbose=1,
        tensorboard_log="./logs/",
        device="cpu",           # Enforce CPU execution
    )
    
    # Save a checkpoint every 2048 steps
    checkpoint_callback = CheckpointCallback(
        save_freq=2048,
        save_path="./models/",
        name_prefix="ppo_trader_bot"
    )
    
    total_timesteps = int(os.getenv("TRAINING_STEPS", "10000"))
    print(f"Starting PPO training for {total_timesteps} timesteps on CPU...")
    
    try:
        model.learn(
            total_timesteps=total_timesteps,
            callback=checkpoint_callback,
            progress_bar=False
        )
        print("Training complete! Saving final model...")
        model.save("./models/ppo_trader_bot_final")
    except KeyboardInterrupt:
        print("Training interrupted. Saving current model checkpoint...")
        model.save("./models/ppo_trader_bot_interrupted")
    finally:
        env.close()


if __name__ == "__main__":
    train()
