# twring.com

Static pages, no build step.

| Page | Path |
| --- | --- |
| Home | `index.html` (twring.com) |
| Request access | `beta/index.html` (twring.com/beta) |
| Support | `support/index.html` (twring.com/support) |
| Terms of service | `terms/index.html` (twring.com/terms) |
| Connect AI apps | `connector/index.html` (twring.com/connector) |
| Sign-in consent for AI apps | `oauth/consent/index.html` |
| Connector registry proof | `.well-known/mcp-registry-auth` |

Home, invite, support and terms share `assets/site.css` and the self-hosted fonts in `assets/fonts/` (the app's own Manrope, Inter and JetBrains Mono), so these four pages load nothing from other domains (the AI-app connect and consent pages still use Google Fonts). Bump the `?v=` on the stylesheet link when it changes. The home page film is `media/twring-in-30-seconds.mp4` (the 30 s intro, cut before its old end card) with its poster `media/twring-in-30-seconds.jpg`, which is also the link preview image.

The privacy page is not here: the gateway serves it, generated from [`docs/PRIVACY.md`](../../docs/PRIVACY.md) by `pnpm --filter @twring/gateway gen:privacy`.

## Publish

```bash
scripts/deploy-site.sh
```

It needs `CORD_PROD_HOST`, `CORD_PROD_KEY`, `TWRING_SUPABASE_URL` and `TWRING_SUPABASE_PUBLISHABLE_KEY` (both Supabase values are public). The consent page's placeholders are filled in a temporary copy, never in the repo. Publishing is a production change: it needs the owner's OK. App downloads live separately in `/var/www/cord-downloads` on the server.
