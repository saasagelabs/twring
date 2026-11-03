import type { FastifyInstance } from 'fastify';

import { escapeHtml } from './markdown';
import { PRIVACY_BODY_HTML } from './privacy.generated';

/** Who runs this Twring, from config (CORD_OPERATOR_NAME, CORD_OPERATOR_URL, CORD_SUPPORT_EMAIL). */
export interface PublicPagesConfig {
  operatorName: string;
  /** Where the operator's name links, e.g. their X profile (https, checked by config). */
  operatorUrl?: string;
  supportEmail: string;
}

/**
 * The twring.com look (black, cyan, light display type) in one inline sheet: the CSP loads
 * nothing, so the site's web fonts appear only where the reader has them installed.
 */
const STYLE = `
:root { color-scheme: dark; --bg: #000; --line: rgba(255,255,255,0.08);
  --line-strong: rgba(255,255,255,0.14); --cyan: #19D6F2; --cyan-line: rgba(25,214,242,0.35);
  --cyan-tint: rgba(25,214,242,0.07); --text: #fff; --text-sec: rgba(255,255,255,0.72);
  --text-ter: rgba(255,255,255,0.5);
  --display: "Manrope", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --body: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--text); font: 1rem/1.7 var(--body); -webkit-font-smoothing: antialiased;
  background: var(--bg) radial-gradient(56rem 28rem at 50% -12rem, rgba(25,214,242,0.12), transparent 70%) no-repeat; }
.top, main, footer { max-width: 46rem; margin: 0 auto; padding-left: 1rem; padding-right: 1rem; }
.top { padding-top: 1.25rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--line); }
.logo { display: inline-flex; align-items: center; gap: 0.625rem; border: 0; color: var(--text); }
.wordmark { font: 200 1.5rem/1 var(--display); letter-spacing: -0.02em; text-shadow: 0 0 18px rgba(25,214,242,0.35); }
main { padding-top: 3.5rem; padding-bottom: 4rem; }
.eyebrow { margin: 0 0 1.125rem; font: 0.75rem/1 var(--mono); letter-spacing: 3px; text-transform: uppercase; color: var(--cyan); }
h1 { margin: 0 0 1.75rem; font: 200 clamp(2.375rem, 8vw, 3.625rem)/1.05 var(--display); letter-spacing: -0.03em; }
h2 { margin: 3.5rem 0 1rem; padding-top: 1.75rem; border-top: 1px solid var(--line);
  font: 300 clamp(1.3125rem, 3.4vw, 1.625rem)/1.3 var(--display); letter-spacing: -0.01em; }
h3 { margin: 2rem 0 0.5rem; font: 400 1.125rem/1.4 var(--display); }
p, li { color: var(--text-sec); }
strong { color: var(--text); font-weight: 600; }
a { color: var(--cyan); text-decoration: none; border-bottom: 1px solid var(--cyan-line); }
a:hover { border-bottom-color: var(--cyan); }
a:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; border-radius: 2px; }
ul, ol { padding-left: 1.25em; } li { margin: 0.625rem 0; } li::marker { color: var(--cyan); }
.notice h1 + p { margin: 0 0 2.5rem; padding: 1rem 1.25rem; border: 1px solid var(--line); border-radius: 14px;
  background: rgba(255,255,255,0.025); font: 0.8125rem/2 var(--mono); color: var(--text-sec); }
.notice h1 + p strong { display: inline-block; min-width: 6.5em; font-weight: 400; font-size: 0.6875rem;
  letter-spacing: 1.6px; text-transform: uppercase; color: var(--text-ter); }
.table { margin: 1.25rem 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,0.02); }
table { width: 100%; border-collapse: collapse; font-size: 0.90625rem; line-height: 1.55; }
th { padding: 0.875rem 1rem; border-bottom: 1px solid var(--line-strong); text-align: left; white-space: nowrap;
  font: 400 0.6875rem/1.4 var(--mono); letter-spacing: 1.6px; text-transform: uppercase; color: var(--text-ter); }
td { min-width: 9rem; padding: 0.875rem 1rem; border-top: 1px solid var(--line); vertical-align: top; color: var(--text-sec); }
tbody tr:first-child td { border-top: 0; }
code { padding: 1px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--cyan-tint);
  font: 0.88em var(--mono); color: var(--text); }
footer { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; padding-top: 1.75rem; padding-bottom: 3rem;
  border-top: 1px solid var(--line); font: 0.75rem/1.8 var(--mono); letter-spacing: 1px; color: var(--text-ter); }
footer a { color: var(--text-ter); border-bottom-color: var(--line-strong); }
footer a:hover { color: var(--text); border-bottom-color: var(--text-ter); }
`;

/** The Twring mark from twring.com, drawn inline so the CSP has nothing to load. */
const LOGO =
  '<svg width="38" height="25" viewBox="0 0 100 66" aria-hidden="true"><path d="M 50 33 L 68 15 L 86 33 L 68 51 L 50 33 L 32 15 L 14 33 L 32 51 Z" fill="none" stroke="#19D6F2" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"/></svg>';

/** A complete, script-free page. Everything interpolated into `body` must already be escaped. */
function page(title: string, eyebrow: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noarchive">
<meta name="theme-color" content="#000000">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
<a class="logo" href="https://twring.com/" aria-label="twring home">${LOGO}<span class="wordmark">twring</span></a>
</header>
<main>
<p class="eyebrow">${escapeHtml(eyebrow)}</p>
${body}</main>
<footer>
<span>Twring</span>
<a href="/privacy">Privacy</a>
<a href="/account-deletion">Delete your account</a>
<a href="https://twring.com/">twring.com</a>
</footer>
</body>
</html>
`;
}

/** The operator's name, linked to the page they gave when there is one. */
function operator(config: PublicPagesConfig): string {
  const name = escapeHtml(config.operatorName);
  return config.operatorUrl === undefined
    ? name
    : `<a href="${escapeHtml(config.operatorUrl)}">${name}</a>`;
}

function fill(html: string, config: PublicPagesConfig): string {
  // Function replacers: a string replacement would expand `$&`, `` $` `` and `$'` in config text.
  const name = operator(config);
  const contact = mailto(config.supportEmail);
  return html.replaceAll('{{OPERATOR}}', () => name).replaceAll('{{CONTACT_EMAIL}}', () => contact);
}

function mailto(email: string, subject?: string): string {
  const query = subject === undefined ? '' : `?subject=${encodeURIComponent(subject)}`;
  return `<a href="mailto:${escapeHtml(email)}${escapeHtml(query)}">${escapeHtml(email)}</a>`;
}

/** The privacy notice, generated from docs/PRIVACY.md at build time. */
export function privacyPage(config: PublicPagesConfig): string {
  // The notice's first paragraph (Operator, Contact, Effective) is styled as a box.
  const notice = `<div class="notice">\n${fill(PRIVACY_BODY_HTML, config)}</div>\n`;
  return page('Privacy notice | Twring', 'Legal', notice);
}

/** How to delete a Twring account, with or without the app (Google Play's web deletion link). */
export function accountDeletionPage(config: PublicPagesConfig): string {
  const email = mailto(config.supportEmail, 'Delete my Twring account');
  return page(
    'Delete your Twring account',
    'Your account',
    `<h1>Delete your Twring account</h1>
<p>Twring is run by ${operator(config)}. You can delete your account and everything Twring stores about you at any time.</p>

<h2>In the app</h2>
<ol>
<li>Open Twring and go to <strong>Settings</strong>.</li>
<li>Choose <strong>Delete account</strong> and confirm.</li>
</ol>
<p>This happens straight away: Twring deletes your data, then your sign-in account, and signs you out.
If the second step fails, the app says so and lets you try again.</p>
<p>To delete only your agents, saved keys, and call history but keep your account, choose
<strong>Delete my data</strong> instead.</p>

<h2>Without the app</h2>
<p>Email ${email} from the address you sign in with, with the subject <strong>Delete my Twring account</strong>.
We delete your account and data within 30 days and reply to confirm. We may ask you to confirm the
request from that address before deleting.</p>

<h2>What gets deleted</h2>
<ul>
<li>Your sign-in account: email address, Google account id, name, and profile picture link.</li>
<li>Your agents, their settings, and their encrypted keys.</li>
<li>Your call summaries (times, durations, outcomes, and usage counts).</li>
<li>Any call still in progress is ended.</li>
</ul>

<h2>What is kept, and for how long</h2>
<ul>
<li>Call audio and transcripts: never stored, so there is nothing to delete.</li>
<li>Daily usage counters (calls and seconds per day): removed within 2 days.</li>
<li>Server logs and crash reports, which carry ids and error codes but no transcripts, keys, or
email addresses: removed within 30 days.</li>
</ul>

<p><a href="/privacy">Read the full privacy notice</a>.</p>
`,
  );
}

/**
 * `GET /privacy` and `GET /account-deletion`: public, static, script-free pages for the Play
 * listing. No cookies; a strict CSP allows only the inline stylesheet.
 */
export function registerPublicPages(app: FastifyInstance, config: PublicPagesConfig): void {
  const pages: Record<string, string> = {
    '/privacy': privacyPage(config),
    '/account-deletion': accountDeletionPage(config),
  };
  for (const [path, html] of Object.entries(pages)) {
    app.get(path, (_request, reply) =>
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'public, max-age=3600')
        .send(html),
    );
  }
}
