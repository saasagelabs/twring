# @twring/agent-adapter

How the gateway talks to an agent that has its own address. One interface (`TwringAgentAdapter`), three implementations:

| Adapter | For |
| --- | --- |
| `NativeWsAdapter` | Agents that speak `cord-agent/1` over WebSocket (streaming, cancel, approvals) |
| `RestSseAdapter` | Agents that speak `cord-rest/1` over HTTP, streaming with server-sent events or plain JSON |
| `OpenAiChatAdapter` | Any OpenAI-compatible chat endpoint |

Also here: the connection test the app runs when you add an agent, the guard that blocks private and internal addresses (SSRF), stream size limits, the shared conformance suite every adapter must pass, and fake agents for tests and local work (`pnpm fake-agent`, `pnpm fake-rest-agent`).

Agents on a person's computer don't use this package: they connect through `twring-connect` (`apps/connector`). The protocol itself: [`docs/AGENT_ADAPTER_SPEC.md`](../../docs/AGENT_ADAPTER_SPEC.md).

```bash
pnpm --filter @twring/agent-adapter test
```
