"""The Twring skill for Hermes, built from skills/twring by apps/connector/scripts/gen-skill.mjs.

Registered as a plugin skill, so Hermes loads it as ``twring:twring``. It names the plugin's
tools (twring_message_owner, twring_ring_owner) and never the shell or the link token.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

SKILL_DIR = Path(__file__).resolve().parent / "skills" / "twring"

DESCRIPTION = (
    "How to talk to your owner on a Twring call, and when to message or ring their phone with "
    "twring_message_owner and twring_ring_owner."
)


def register_skill(ctx) -> None:
    """Never stops the plugin: without the skill, the call hint and tool descriptions still apply."""
    try:
        ctx.register_skill("twring", SKILL_DIR / "SKILL.md", DESCRIPTION)
    except (ValueError, FileNotFoundError) as error:
        logger.warning("Twring skill not registered: %s", error)
