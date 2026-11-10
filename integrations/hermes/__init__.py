"""Twring for Hermes: call your Hermes from your phone, and let it call you back."""


def register(ctx):
    """Hermes plugin entry point. The adapter is imported here, inside Hermes, not at import time."""
    from .adapter import register as register_twring

    register_twring(ctx)


__all__ = ["register"]
