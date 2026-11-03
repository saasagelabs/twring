# @twring/contracts

The shared language of Twring: TypeScript types plus Zod schemas for everything that crosses a boundary between the app, the gateway, linked computers and agents. Calls and call states, agents, rings, chats, files, access and invites, realtime events, the agent protocols (`cord-agent/1` native, `cord-rest/1`), the connector link codes and the AI-app connector.

Rule: anything from outside (an agent, a phone, a request) is parsed with these schemas before product code uses it. Event types are discriminated unions, so a `switch` over them must handle every case.

```bash
pnpm --filter @twring/contracts test
```
