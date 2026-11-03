# Contributing to Twring

Thanks for helping. Twring lets you call the AI agents you already run, and lets them call you.

## Set up

- Node 24 and pnpm (through corepack: `corepack enable`).
- `pnpm install`
- Read `CLAUDE.md` (it applies to people too): the architecture rules, the TypeScript expectations and the docs to read first.

## Before you open a pull request

Run, from the repository root:

    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test

On Windows, run the gateway tests with `pnpm --filter @twring/gateway exec vitest run --maxWorkers=3`.

Never use em dashes in any text; `pnpm lint` fails on them.

## Sign your commits (DCO)

Every commit needs a sign-off line saying you have the right to submit it under this project's licenses ([Developer Certificate of Origin](https://developercertificate.org/)):

    git commit -s

This adds `Signed-off-by: Your Name <your@email>`. Pull requests without it cannot be merged.

## Licenses

Your contribution is under the license of the folder it changes (see [LICENSE.md](LICENSE.md)): AGPL-3.0 for the server, the relay and the self-host kit; Apache-2.0 for everything else.

## Security

Do not open public issues for security problems. See [SECURITY.md](SECURITY.md).
