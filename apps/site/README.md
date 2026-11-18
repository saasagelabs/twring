# twring.com

Static pages, no build step.

| Page | Path |
| --- | --- |
| Home | `index.html` (twring.com) |
| Request access | `beta/index.html` (twring.com/beta) |
| Support | `support/index.html` (twring.com/support) |
| Terms of service | `terms/index.html` (twring.com/terms) |
| Connect AI apps | `connector/index.html` (twring.com/connector) |
| One page per agent | `claude-code/`, `codex/`, `gemini-cli/`, `hermes/` (what a call is like and how to connect that agent) |
| Page not found | `404.html` (the web server shows it for any missing page) |
| Sign-in consent for AI apps | `oauth/consent/index.html` |
| Connector registry proof | `.well-known/mcp-registry-auth` |
| Search engines | `robots.txt`, `sitemap.xml`, `google115cd0c2612c5fd5.html` (Google Search Console proof) |
| AI answer engines | `llms.txt`: a plain summary of Twring and its pages |
| IndexNow key | `2da14f6b220d7c6ff8ab30cfa8e43f01.txt` (Bing, Yandex and others; public by design) |
| Icons | `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest` (from the app icon) |

Every page shares `assets/site.css` and the self-hosted fonts in `assets/fonts/` (the app's own Manrope, Inter and JetBrains Mono), so pages load no styles or fonts from other domains. The consent page allows only its own stylesheet and fonts in its content security policy, so it carries no inline styles; it still loads the sign-in library from its pinned address. Bump the `?v=` on the stylesheet link when it changes. The home page and the agent pages carry structured data (`application/ld+json`), including their FAQ: when an FAQ answer changes, change it there too (`pnpm lint` fails otherwise). The agent pages say what the connector really does (its default permissions, its hooks); when the connector's options change, check them. After publishing, tell search engines what changed with `scripts/indexnow.sh <url>...`. The home page film is `media/twring-in-30-seconds.mp4` (the 30 s intro, cut before its old end card) with its poster `media/twring-in-30-seconds.jpg`, which is also the link preview image.

The privacy page is not here: the gateway serves it, generated from [`docs/PRIVACY.md`](../../docs/PRIVACY.md) by `pnpm --filter @twring/gateway gen:privacy`.

## Publish

```bash
scripts/deploy-site.sh
```

It needs `CORD_PROD_HOST`, `CORD_PROD_KEY`, `TWRING_SUPABASE_URL` and `TWRING_SUPABASE_PUBLISHABLE_KEY` (both Supabase values are public). The consent page's placeholders are filled in a temporary copy, never in the repo. Publishing is a production change: it needs the owner's OK. App downloads live separately in `/var/www/cord-downloads` on the server.
