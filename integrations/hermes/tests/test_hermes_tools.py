"""The Twring tools and hooks inside real Hermes, in a process that never starts the gateway
(the `hermes` terminal, cron). Needs Hermes installed (run with Hermes's own Python); skipped
elsewhere."""

import importlib.util
import sys
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parent.parent

# conftest.py puts the plugin folder first on sys.path for the unit tests, and the plugin's own
# tools.py would then shadow Hermes's `tools` package. Hermes itself loads the plugin as
# hermes_plugins.twring, so import Hermes's modules with the plugin folder off the path, and drop
# a plugin `tools` module another test may have imported. Hermes's `tools` stays in sys.modules
# for the rest of this process, so Hermes's own lazy imports find it too.
if importlib.util.find_spec("hermes_cli") is None:
    pytest.skip("needs Hermes installed (run with Hermes's own Python)", allow_module_level=True)
_saved_path = list(sys.path)
sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != PLUGIN]
if not hasattr(sys.modules.get("tools"), "__path__"):
    sys.modules.pop("tools", None)
try:
    from ruamel.yaml import YAML  # noqa: E402  (ships with Hermes; PyYAML does not since 0.23)
    from hermes_cli.plugins import PluginManager, PluginManifest  # noqa: E402
    from toolsets import resolve_toolset  # noqa: E402
    from tools.registry import registry  # noqa: E402
finally:
    sys.path[:] = _saved_path


@pytest.fixture
def clean_registry():
    """Undo what loading the plugin leaves behind, as Hermes's own
    tests/hermes_cli/test_deferred_platform_client_tools.py does."""
    from gateway.platform_registry import platform_registry

    before_tools = set(registry.get_all_tool_names())
    before_modules = set(sys.modules)
    yield
    for name in set(registry.get_all_tool_names()) - before_tools:
        registry.deregister(name)
    platform_registry.unregister("twring")
    for name in set(sys.modules) - before_modules:
        if name.startswith("hermes_plugins."):
            sys.modules.pop(name, None)


def twring_manifest():
    data = YAML(typ="safe").load((PLUGIN / "plugin.yaml").read_text(encoding="utf-8"))
    return PluginManifest(
        name=data["name"],
        kind=data["kind"],
        source="user",
        path=str(PLUGIN),
        key=data["name"],
        provides_tools=data["provides_tools"],
        provides_hooks=data["provides_hooks"],
    )


def test_tools_and_hooks_load_without_the_gateway(clean_registry):
    adapter_modules_before = {n for n in sys.modules if n.endswith(".adapter")}
    manager = PluginManager()
    manager._register_deferred_platform(twring_manifest())
    assert sorted(resolve_toolset("twring")) == ["twring_message_owner", "twring_ring_owner"]
    for hook in ("pre_approval_request", "post_approval_response", "api_request_error"):
        assert manager._hooks.get(hook), f"{hook} not registered"
    # The one register() entry also registers the approval transport and the Hermes skill.
    assert manager.get_approval_transport("twring") is not None
    assert "twring:twring" in manager._plugin_skills
    # The adapter (and with it the gateway) stayed deferred.
    assert {n for n in sys.modules if n.endswith(".adapter")} == adapter_modules_before


def test_tools_are_hidden_while_hermes_is_not_linked(clean_registry, monkeypatch):
    monkeypatch.delenv("TWRING_TOKEN", raising=False)
    manager = PluginManager()
    manager._register_deferred_platform(twring_manifest())
    assert {"twring_ring_owner", "twring_message_owner"} <= set(registry.get_all_tool_names())
    assert registry.is_toolset_available("twring") is False
