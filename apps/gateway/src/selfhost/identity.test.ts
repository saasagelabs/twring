import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serverIdSchema } from '@twring/contracts';
import { importSPKI, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import { base32Lower, loadServerIdentity, serverIdFor } from './identity';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function keyFile() {
  const pair = generateKeyPairSync('ed25519');
  const dir = await mkdtemp(join(tmpdir(), 'twring-identity-'));
  dirs.push(dir);
  const file = join(dir, 'server.key');
  await writeFile(file, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  return { file, publicPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() };
}

describe('server identity', () => {
  it('base32 matches RFC 4648 vectors (lower case, no padding)', () => {
    expect(base32Lower(Buffer.from('foobar'))).toBe('mzxw6ytboi');
    expect(base32Lower(Buffer.from('f'))).toBe('my');
  });

  it('server id is stable for a fixed key and follows the Global Constraints formula', async () => {
    const { file } = await keyFile();
    const a = await loadServerIdentity(file);
    const b = await loadServerIdentity(file);
    expect(a.id).toBe(b.id);
    expect(a.publicKeyRaw).toHaveLength(32);
    const digest = createHash('sha256').update(a.publicKeyRaw).digest().subarray(0, 20);
    expect(a.id).toBe(`srv_${base32Lower(digest)}`);
    expect(serverIdFor(a.publicKeyRaw)).toBe(a.id);
    expect(serverIdSchema.safeParse(a.id).success).toBe(true);
  });

  it('the id comes from the real Ed25519 public key, derived independently from the file', async () => {
    const { file } = await keyFile();
    const identity = await loadServerIdentity(file);
    const spki = createPublicKey(createPrivateKey(await readFile(file, 'utf8'))).export({
      format: 'der',
      type: 'spki',
    });
    // An Ed25519 SPKI is a fixed 12-byte header followed by the raw 32-byte key.
    const raw = spki.subarray(spki.length - 32);
    expect(Buffer.from(identity.publicKeyRaw).equals(raw)).toBe(true);
    const digest = createHash('sha256').update(raw).digest().subarray(0, 20);
    expect(identity.id).toBe(`srv_${base32Lower(digest)}`);
  });

  it('signs a JWS that verifies with the public key', async () => {
    const { file, publicPem } = await keyFile();
    const identity = await loadServerIdentity(file);
    const jws = await identity.sign({ iss: identity.id, sub: 'dev_1', aud: 'twring-relay' });
    const { payload, protectedHeader } = await jwtVerify(
      jws,
      await importSPKI(publicPem, 'EdDSA'),
      { issuer: identity.id, audience: 'twring-relay' },
    );
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.sub).toBe('dev_1');
  });
});
