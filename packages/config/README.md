# @twring/config

Typed, validated settings. `@twring/config/gateway` reads the gateway's environment (`CORD_*`, provider keys, limits) and refuses to start on a missing or unsafe value, for example production without real sign-in. `@twring/config/mobile` does the same for the app's public settings.

Add a setting here first, with a test, then use it. Examples of every setting are in `apps/gateway/.env*.example` and `apps/mobile/.env.example`.

```bash
pnpm --filter @twring/config test
```
