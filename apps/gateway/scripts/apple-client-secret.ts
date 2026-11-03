/**
 * Makes the "Secret Key (for OAuth)" Supabase needs for Sign in with Apple on the web (the AI-app
 * consent page): an ES256 token signed with the Sign in with Apple key. Apple accepts at most six
 * months, so it is renewed twice a year. The token goes to a file only; this prints the expiry.
 *
 *   pnpm --filter @twring/gateway exec tsx scripts/apple-client-secret.ts \
 *     --key <AuthKey_XXXX.p8> --key-id <KEYID> --team-id <TEAMID> --client-id com.twring.web --out <file>
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const LIFETIME_DAYS = 179;

export function appleClientSecret(options: {
  keyPem: string;
  keyId: string;
  teamId: string;
  clientId: string;
  now?: Date;
}): { token: string; expiresAt: Date } {
  if (!/^[A-Z0-9]{10}$/.test(options.keyId))
    throw new Error('The key id is 10 letters and digits.');
  if (!/^[A-Z0-9]{10}$/.test(options.teamId))
    throw new Error('The team id is 10 letters and digits.');
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(options.clientId))
    throw new Error('The Services ID looks like com.example.web.');
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const exp = iat + LIFETIME_DAYS * 86_400;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'ES256', kid: options.keyId, typ: 'JWT' })}.${part({
    iss: options.teamId,
    iat,
    exp,
    aud: 'https://appleid.apple.com',
    sub: options.clientId,
  })}`;
  const signature = sign('sha256', Buffer.from(body), {
    key: createPrivateKey(options.keyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return { token: `${body}.${signature.toString('base64url')}`, expiresAt: new Date(exp * 1000) };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      key: { type: 'string' },
      'key-id': { type: 'string' },
      'team-id': { type: 'string' },
      'client-id': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const { key, out } = values;
  if (!key || !out || !values['key-id'] || !values['team-id'] || !values['client-id'])
    throw new Error(
      'usage: --key <p8> --key-id <id> --team-id <id> --client-id <services id> --out <file>',
    );
  const { token, expiresAt } = appleClientSecret({
    keyPem: readFileSync(key, 'utf8'),
    keyId: values['key-id'],
    teamId: values['team-id'],
    clientId: values['client-id'],
  });
  writeFileSync(out, `${token}\n`, { mode: 0o600 });
  process.stdout.write(
    `Wrote the Apple secret to ${out}. It expires on ${expiresAt.toISOString().slice(0, 10)}: make a new one before then.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `apple-client-secret: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
