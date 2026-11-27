"""The plugin as Hermes loads it: entry point, manifest and one version everywhere."""

import importlib.util
import re
import sys
import types
from pathlib import Path

import pytest

import cli
import twring_core
import twring_outbound

PLUGIN = Path(__file__).resolve().parent.parent


def manifest_text():
    return (PLUGIN / "plugin.yaml").read_text(encoding="utf-8")


def manifest_list(field):
    block = re.search(rf"^{field}:\n((?:  - .+\n)+)", manifest_text(), re.MULTILINE)
    assert block, f"plugin.yaml has no {field} list"
    return [line.strip()[2:].strip() for line in block.group(1).splitlines()]


def test_one_version_everywhere():
    version = re.search(r"^version: (\S+)$", manifest_text(), re.MULTILINE).group(1)
    assert version == "0.2.0"
    assert twring_core.PLUGIN_VERSION == version
    assert cli.USER_AGENT == f"twring-hermes/{version}"
    assert twring_outbound.USER_AGENT == f"twring-hermes/{version}"


def test_manifest_declares_the_tools_and_every_hook():
    assert manifest_list("provides_tools") == ["twring_ring_owner", "twring_message_owner"]
    assert set(manifest_list("provides_hooks")) == {
        "pre_tool_call",
        "post_tool_call",
        "pre_approval_request",
        "post_approval_response",
        "api_request_error",
    }


class FakeCtx:
    def __init__(self):
        self.order = []

    def register_tool(self, **kwargs):
        self.order.append(("tool", kwargs["name"]))

    def register_hook(self, name, callback):
        self.order.append(("hook", name))


@pytest.fixture
def plugin_package(monkeypatch):
    """Loads the plugin folder as a package, the way Hermes does, with the adapter stubbed (it
    needs Hermes's gateway)."""
    calls = []
    fake_adapter = types.ModuleType("twring_plugin.adapter")
    fake_adapter.register = lambda ctx: calls.append("platform")
    monkeypatch.setitem(sys.modules, "twring_plugin.adapter", fake_adapter)
    spec = importlib.util.spec_from_file_location(
        "twring_plugin", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)]
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "twring_plugin", module)
    spec.loader.exec_module(module)
    yield module, calls
    for name in [n for n in sys.modules if n.startswith("twring_plugin.")]:
        sys.modules.pop(name, None)


def test_register_adds_tools_and_hooks_then_the_platform(plugin_package):
    module, calls = plugin_package
    ctx = FakeCtx()
    module.register(ctx)
    assert ("tool", "twring_ring_owner") in ctx.order
    assert ("tool", "twring_message_owner") in ctx.order
    assert [name for kind, name in ctx.order if kind == "hook"] == [
        "pre_approval_request",
        "post_approval_response",
        "api_request_error",
    ]
    assert calls == ["platform"]


def test_a_broken_tools_module_does_not_stop_calls(plugin_package, monkeypatch):
    module, calls = plugin_package
    broken = types.ModuleType("twring_plugin.tools")

    def boom(ctx):
        raise RuntimeError("bad tools")

    broken.register_tools = boom
    monkeypatch.setitem(sys.modules, "twring_plugin.tools", broken)
    module.register(FakeCtx())
    assert calls == ["platform"]
