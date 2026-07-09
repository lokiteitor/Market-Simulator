"""Custom exceptions for the market client."""

from __future__ import annotations

from .models import Problem


class MarketAPIError(Exception):
    """Raised when the API returns a 4xx/5xx error."""

    def __init__(self, status_code: int, message: str, problem: Problem | None = None) -> None:
        self.status_code = status_code
        self.problem = problem
        self.message = message
        super().__init__(f"[{status_code}] {message}")

    @property
    def error_code(self) -> str | None:
        """First error code from the problem errors list, if any."""
        if self.problem and self.problem.errors:
            return self.problem.errors[0].code
        return None


class AuthenticationError(MarketAPIError):
    """Raised on 401 Unauthorized."""
    pass


class ForbiddenError(MarketAPIError):
    """Raised on 403 Forbidden (e.g., agent is bankrupt)."""
    pass


class NotFoundError(MarketAPIError):
    """Raised on 404 Not Found."""
    pass


class DomainValidationError(MarketAPIError):
    """Raised on 422 Unprocessable Entity (domain rule violation)."""
    pass


class ConflictError(MarketAPIError):
    """Raised on 409 Conflict."""
    pass
