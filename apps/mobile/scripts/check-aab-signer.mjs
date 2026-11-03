#!/usr/bin/env node
// Checks who signed a release AAB, from `keytool -printcert -jarfile app.aab` on stdin.
//
// Fails (exit 1) when:
//   - no signer certificate is listed;
//   - any signer is the Android debug certificate (CN=Android Debug), which Play rejects and
//     which means the upload key was not used;
//   - CORD_UPLOAD_CERT_SHA256 is set and no signer's SHA-256 fingerprint matches it (colons and
//     case are ignored). Unset: this check is skipped.
//
// Prints only public certificate fingerprints, never key material.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const normalize = (value) => value.replace(/[^0-9a-f]/gi, '').toUpperCase();

/** @returns {string | undefined} why the signer is not acceptable; undefined when it is. */
export function signerProblem(printcert, expectedSha256) {
  const owners = [...printcert.matchAll(/^\s*Owner:\s*(.+)$/gm)].map((m) => m[1].trim());
  const sha256 = [...printcert.matchAll(/^\s*SHA256:\s*([0-9A-Fa-f:]+)\s*$/gm)].map((m) =>
    normalize(m[1]),
  );
  if (owners.length === 0 || sha256.length === 0) return 'no signer certificate found';
  if (owners.some((owner) => /(^|,\s*)CN=Android Debug(,|$)/i.test(owner))) {
    return 'signed with the Android debug certificate, not the upload key';
  }
  const expected = normalize(expectedSha256 ?? '');
  if (expected !== '' && !sha256.includes(expected)) {
    return 'signer SHA-256 does not match CORD_UPLOAD_CERT_SHA256';
  }
  return undefined;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readFileSync(0, 'utf8');
  for (const line of input.split(/\r?\n/)) {
    if (/^\s*SHA(1|256):/.test(line)) console.log(line.trim());
  }
  const problem = signerProblem(input, process.env.CORD_UPLOAD_CERT_SHA256);
  if (problem !== undefined) {
    console.error(`AAB signer check failed: ${problem}`);
    process.exit(1);
  }
  console.log('AAB signer check passed');
}
