"""Twring for Hermes: call your Hermes from your phone, and let it call you back."""

import logging

logger = logging.getLogger(__name__)


def register(ctx):
    """Hermes plugin entry point. Tools and hooks first (they need no gateway; Hermes also loads
    them through tools.py in processes that never start the gateway), then the platform. The
    adapter is imported here, inside Hermes, not at import time."""
    try:
        from .tools import register_tools

        register_tools(ctx)  # also registers the hooks (hooks.register_hooks, once per manager)
    except Exception:
        logger.warning("Twring: could not register the Twring tools", exc_info=True)
    from .adapter import register as register_twring

    register_twring(ctx)


__all__ = ["register"]
