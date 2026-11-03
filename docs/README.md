# Twring docs

Start with [`PRODUCT.md`](PRODUCT.md), then [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Product and design

| Doc | What it covers |
| --- | --- |
| [`PRODUCT.md`](PRODUCT.md) | What Twring is, who it is for, and what is out of scope |
| [`UX_UI_SPEC.md`](UX_UI_SPEC.md) | Screens and how they behave |
| [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) | Motion, components, haptics, accessibility |
| [`PRIVACY.md`](PRIVACY.md) | The privacy notice (source for twring.com/privacy) |

## Architecture

| Doc | What it covers |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System boundaries and the rules that must not drift (TWR-001 to TWR-010) |
| [`DECISIONS.md`](DECISIONS.md) | Every architecture decision (ADR) and why |
| [`TECH_STACK.md`](TECH_STACK.md) | Approved technologies and dependency policy |
| [`VOICE_ARCHITECTURE.md`](VOICE_ARCHITECTURE.md) | The latency-critical voice path |
| [`CALL_STATE_MACHINE.md`](CALL_STATE_MACHINE.md) | Call states and transitions |
| [`AGENT_ADAPTER_SPEC.md`](AGENT_ADAPTER_SPEC.md) | How an agent plugs into Twring |
| [`ADAPTERS.md`](ADAPTERS.md) | Native, REST/SSE, AG-UI and A2A strategy |
| [`BACKEND_SPEC.md`](BACKEND_SPEC.md) | What the gateway is responsible for |
| [`DATA_MODEL.md`](DATA_MODEL.md) | What the server stores |
| [`MOBILE_PLATFORM_SPEC.md`](MOBILE_PLATFORM_SPEC.md) | Android and iPhone platform rules |
| [`SECURITY_AND_PRIVACY.md`](SECURITY_AND_PRIVACY.md) | Trust boundaries, secrets, logging |
| [`OBSERVABILITY_AND_SLOS.md`](OBSERVABILITY_AND_SLOS.md) | Call quality budgets and what is measured |
| [`OFFICIAL_REFERENCES.md`](OFFICIAL_REFERENCES.md) | Provider and platform documentation links |

## Build, test and ship

| Doc | What it covers |
| --- | --- |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Local setup, keys, fake agents, running the app on a phone |
| [`TESTING_AND_RELEASE.md`](TESTING_AND_RELEASE.md) | Test strategy and release gates |
| [`RELEASE_TEST_LIST.md`](RELEASE_TEST_LIST.md) | The device test run before every build that reaches people, with past results |
| [`ORCHESTRATION.md`](ORCHESTRATION.md) | How Claude Code and Codex split work |
