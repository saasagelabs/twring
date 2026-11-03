import { describe, expect, it } from 'vitest';

import { COMPUTER_OFFLINE_MESSAGE } from './labels';
import { LINK_EXPIRED_COPY, readLinkInput } from './link';

// Owner rule: people who know nothing about how Twring works never see its plumbing.
const JARGON = /twring-connect|connector|--server/i;

describe('copy a person sees about their computer', () => {
  it('never names the plumbing', () => {
    const otherServer = readLinkInput(
      `cord://link?code=ABCDEFGH&server=${encodeURIComponent('https://other.example')}`,
      'https://api.twring.com',
    );
    const copies = [
      COMPUTER_OFFLINE_MESSAGE,
      LINK_EXPIRED_COPY.message,
      otherServer.ok ? '' : otherServer.message,
    ];
    for (const copy of copies) expect(copy).not.toMatch(JARGON);
  });
});
