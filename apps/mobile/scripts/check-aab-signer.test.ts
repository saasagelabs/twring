import { describe, expect, it } from 'vitest';

import { signerProblem } from './check-aab-signer.mjs';

/** The codemagic `android-release` signer check, fed `keytool -printcert -jarfile` output. */

const UPLOAD_SHA256 =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

function printcert(owner: string, sha256: string): string {
  return [
    'Signer #1:',
    '',
    'Signature:',
    '',
    `Owner: ${owner}`,
    `Issuer: ${owner}`,
    'Serial number: 1',
    'Certificate fingerprints:',
    '\t SHA1: 11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00',
    `\t SHA256: ${sha256}`,
    '',
  ].join('\n');
}

describe('check-aab-signer (android-release)', () => {
  it('passes the upload certificate when no expected fingerprint is set', () => {
    expect(signerProblem(printcert('CN=CORD Upload, O=SaaSage', UPLOAD_SHA256))).toBeUndefined();
    expect(signerProblem(printcert('CN=CORD Upload', UPLOAD_SHA256), '')).toBeUndefined();
  });

  it('fails an AAB signed with the Android debug certificate', () => {
    expect(signerProblem(printcert('CN=Android Debug, O=Android, C=US', UPLOAD_SHA256))).toMatch(
      /debug certificate/,
    );
  });

  it('fails a signer that does not match CORD_UPLOAD_CERT_SHA256', () => {
    const other = UPLOAD_SHA256.replace(/^AB/, '00');
    expect(signerProblem(printcert('CN=Someone Else', other), UPLOAD_SHA256)).toMatch(
      /does not match/,
    );
  });

  it('accepts a matching fingerprint written without colons or in lower case', () => {
    const plain = UPLOAD_SHA256.replace(/:/g, '').toLowerCase();
    expect(signerProblem(printcert('CN=CORD Upload', UPLOAD_SHA256), plain)).toBeUndefined();
  });

  it('fails when keytool listed no certificate (unsigned)', () => {
    expect(signerProblem('Not a signed jar file\n')).toMatch(/no signer/);
  });
});
