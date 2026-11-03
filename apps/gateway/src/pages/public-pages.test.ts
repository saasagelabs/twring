import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createRequestAuth } from '../auth';

import { renderMarkdown } from './markdown';
import { PRIVACY_BODY_HTML } from './privacy.generated';
import { renderPrivacyNotice } from './privacy-notice';

const CONFIG = { operatorName: 'Jane <Doe> & Co', supportEmail: 'help@example.com' };

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    onError: () => undefined,
    publicPages: CONFIG,
  });
  apps.push(app);
  return app;
}

describe('public pages', () => {
  it('the checked-in privacy page matches docs/PRIVACY.md', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../../../../docs/PRIVACY.md', import.meta.url)),
      'utf8',
    );
    expect(
      renderPrivacyNotice(doc),
      'docs/PRIVACY.md changed: run `pnpm --filter @twring/gateway gen:privacy`',
    ).toBe(PRIVACY_BODY_HTML);
  });

  it('reads as a finished notice: no draft note, no internal references, no store form', () => {
    expect(PRIVACY_BODY_HTML).toMatch(/^<h1>Privacy notice<\/h1>/);
    expect(PRIVACY_BODY_HTML).not.toMatch(/\(draft\)|This draft|<blockquote>|ADR-|Data safety/i);
    // The Play form answers stay in docs/PRIVACY.md for the store, off the public page.
    expect(renderPrivacyNotice('# A\n\nkept\n\n## Google Play Data safety answers\n\ncut\n')).toBe(
      '<h1>A</h1>\n<p>kept</p>\n',
    );
  });

  it('says what Twring receives from a self-hosted server', () => {
    expect(PRIVACY_BODY_HTML).toContain('<h2>9. Self-hosted servers</h2>');
    expect(PRIVACY_BODY_HTML).toMatch(/sealed/i);
    expect(PRIVACY_BODY_HTML).toMatch(/never stored/i);
    expect(PRIVACY_BODY_HTML).toContain('twring uninstall');
    expect(PRIVACY_BODY_HTML).toMatch(/90 days/);
  });

  it.each(['/privacy', '/account-deletion'])(
    '%s links the operator to the page they gave, escaped',
    async (url) => {
      const app = buildApp({
        env: loadGatewayEnv(gatewayEnvFixture()),
        onError: () => undefined,
        publicPages: {
          operatorName: '@rishflips',
          operatorUrl: 'https://x.com/rishflips?a=1&b="2"',
          supportEmail: 'help@example.com',
        },
      });
      apps.push(app);
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).toContain(
        '<a href="https://x.com/rishflips?a=1&amp;b=&quot;2&quot;">@rishflips</a>',
      );
    },
  );

  it.each(['/privacy', '/account-deletion'])(
    '%s looks like Twring: dark, cyan, the logo linking home',
    async (url) => {
      const res = await setup().inject({ method: 'GET', url });
      expect(res.body).toContain('--bg: #000');
      expect(res.body).toContain('#19D6F2');
      expect(res.body).toMatch(
        /<header[^>]*>[\s\S]*<a class="logo" href="https:\/\/twring\.com\/"/,
      );
      expect(res.body).toContain('<span class="wordmark">twring</span>');
      // One way home from the header: a second link there is noise for a screen reader.
      expect(res.body.match(/<header[\s\S]*<\/header>/)![0].match(/<a /g)).toHaveLength(1);
      expect(res.body).toMatch(/<footer[\s\S]*href="\/privacy"[\s\S]*href="\/account-deletion"/);
      // Still only inline styles: nothing for the CSP to load.
      expect(res.body).not.toMatch(/<link|@import|url\(/i);
      // Text sizes follow the reader's own text size setting.
      expect(res.body).not.toMatch(/font(-size)?:[^;}]*\dpx/);
    },
  );

  it('boxes only the notice’s Operator, Contact and Effective lines', async () => {
    const privacy = (await setup().inject({ method: 'GET', url: '/privacy' })).body;
    const deletion = (await setup().inject({ method: 'GET', url: '/account-deletion' })).body;
    expect(privacy).toContain('<div class="notice">\n<h1>Privacy notice</h1>');
    expect(deletion).not.toContain('class="notice"');
    // No unscoped rule: it would box the deletion page's opening sentence too.
    expect(privacy).not.toMatch(/(^|\n|\} )h1 \+ p/);
    expect(privacy).toContain('.notice h1 + p {');
  });

  it.each(['/privacy', '/account-deletion'])(
    '%s is public, static HTML with no scripts or cookies',
    async (url) => {
      const res = await setup().inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.body).toMatch(/^<!doctype html>/);
      expect(res.body).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
      expect(res.body).not.toContain('{{');
      // Operator lines come from config, escaped.
      expect(res.body).toContain('help@example.com');
      if (url === '/privacy') expect(res.body).toContain('Jane &lt;Doe&gt; &amp; Co');
    },
  );

  it('the deletion page says how to delete in the app and by email', async () => {
    const res = await setup().inject({ method: 'GET', url: '/account-deletion' });
    expect(res.body).toContain('Delete account');
    expect(res.body).toContain('mailto:help@example.com?subject=Delete%20my%20Twring%20account');
    expect(res.body).toContain('within 30 days');
    expect(res.body).toContain('Jane &lt;Doe&gt; &amp; Co');
  });

  it('inserts config values literally, even ones that look like replacement patterns', async () => {
    // `$'`, `$&` and `` $` `` mean something to String.replace; config text must not.
    const operatorName = "Acme $' $& $` Ltd";
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError: () => undefined,
      publicPages: { operatorName, supportEmail: 'help@example.com' },
    });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/privacy' });
    expect(res.body).toContain('Acme $&#39; $&amp; $` Ltd');
    expect(res.body.match(/<!doctype html>/g)).toHaveLength(1);
    expect(res.body.match(/<\/html>/g)).toHaveLength(1);
    expect(res.body).not.toContain('{{');
  });

  it('never puts config values in a response header', async () => {
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError: () => undefined,
      publicPages: { operatorName: 'Evil\r\nSet-Cookie: a=b', supportEmail: 'help@example.com' },
    });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/account-deletion' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(res.headers)).not.toContain('Evil');
  });

  it('needs no sign-in (not a /v1 route)', async () => {
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError: () => undefined,
      publicPages: CONFIG,
      // Rejects every token, like a signed-out caller.
      auth: createRequestAuth(() => Promise.reject(new Error('no token'))),
    });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/privacy' })).statusCode).toBe(200);
  });
});

describe('renderMarkdown', () => {
  it('escapes raw HTML instead of passing it through', () => {
    expect(renderMarkdown('Hi <script>alert(1)</script> **bold**')).toBe(
      '<p>Hi &lt;script&gt;alert(1)&lt;/script&gt; <strong>bold</strong></p>\n',
    );
  });

  it('renders a paragraph that starts with # but is not a heading', () => {
    expect(renderMarkdown('#tag line')).toBe('<p>#tag line</p>\n');
  });
});
