"""Configuration settings for the trader bot."""

from __future__ import annotations

import os


class Config:
    """Central configuration class reading from environment variables."""

    # API configuration
    API_URL: str = os.getenv("API_URL", "http://localhost:9080/v1")
    
    # Credentials (defaulting to a new generated user if not provided)
    USERNAME: str = os.getenv("BOT_USERNAME", "trader_bot_ml")
    PASSWORD: str = os.getenv("BOT_PASSWORD", "SuperSecurePassword123!")
    
    # Simulation factors
    SIMULATION_FACTOR: float = float(os.getenv("SIMULATION_FACTOR", "5.0"))
    
    # Frequency of decisions (in real-world seconds)
    TICK_INTERVAL: float = float(os.getenv("TICK_INTERVAL", "5.0"))
