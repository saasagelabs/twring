#!/usr/bin/env node
// Prints the next iOS build number: one higher than the highest build App Store Connect has for
// the app (1 when it has none). Used by the TestFlight workflow (ios-testflight.sh).
//
//   ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_KEY_P8_PATH=... ASC_APP_ID=... node next-ios-build-number.mjs
//
// Never prints the key or the token; on an API error it prints the status and Apple's title.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const b64url = (value) => Buffer.from(value).toString('base64url');

/** An ES256 JWT for the App Store Connect API, valid for 20 minutes from nowSeconds. */
export function makeAscToken({ keyId, issuerId, privateKeyPem, nowSeconds }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: issuerId,
      iat: nowSeconds,
      exp: nowSeconds + 1200,
      aud: 'appstoreconnect-v1',
    }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

/** The highest leading integer among the builds' versions; 0 when there is none. */
export function highestBuildNumber(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  let highest = 0;
  for (const build of data) {
    const match = /^(\d+)/.exec(String(build?.attributes?.version ?? ''));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/** Reads the app's most recent builds and returns the highest build number plus one. */
export async function nextBuildNumber({ fetchImpl, appId, token }) {
  const query = new URLSearchParams({
    'filter[app]': appId,
    sort: '-uploadedDate',
    limit: '200',
    'fields[builds]': 'version',
  });
  const response = await fetchImpl(`https://api.appstoreconnect.apple.com/v1/builds?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const title = body?.errors?.[0]?.title ?? 'no error details';
    throw new Error(`App Store Connect answered ${response.status}: ${title}`);
  }
  return highestBuildNumber(body) + 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const missing = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_PATH', 'ASC_APP_ID'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    console.error(`Missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  try {
    const token = makeAscToken({
      keyId: process.env.ASC_KEY_ID,
      issuerId: process.env.ASC_ISSUER_ID,
      privateKeyPem: readFileSync(process.env.ASC_KEY_P8_PATH, 'utf8'),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    console.log(await nextBuildNumber({ fetchImpl: fetch, appId: process.env.ASC_APP_ID, token }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
