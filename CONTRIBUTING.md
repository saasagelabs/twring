# Contributing to Twring

Thanks for helping. Twring lets you call the AI agents you already run, and lets them call you.

## Where help is most welcome

- **Connecting more agents.** Plugins and examples that let another agent framework talk to
  Twring, like the Hermes plugin in `integrations/hermes` and the example in `examples/`. The
  protocols are in `docs/AGENT_ADAPTER_SPEC.md`.
- **Self-hosting on more machines.** Try the installer on hardware we have not (arm64 boards,
  home servers, other Linux distributions) and report what happened, or fix the docs.
- **Docs and examples.** Anything that makes connecting an agent quicker to understand.
- **Bug reports with steps and logs.** Use the bug report form.

Look for issues labelled `good first issue` or `help wanted`. For anything bigger, open an issue
first so we can agree on the approach before you write code.

The call pipeline, the shared contracts, sign-in and security code change often and carry every
call, so changes there come from the maintainers for now. Bug reports about them are welcome.

## How reviews work

A maintainer reviews every pull request; first-time contributors' checks start after a
maintainer approves them. Replies can take a few days.

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

Your contribution is under the license of the folder it changes (see [LICENSING.md](LICENSING.md)): AGPL-3.0 for the server, the relay and the self-host kit; Apache-2.0 for everything else.

## Security

Do not open public issues for security problems. See [SECURITY.md](SECURITY.md).
