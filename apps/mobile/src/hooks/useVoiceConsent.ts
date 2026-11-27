import { useCallback, useEffect, useRef, useState } from 'react';

import { giveVoiceConsent, hasVoiceConsent } from '@/e2e/voice-consent';
import { reportClientError } from '@/observability/sentry';
import { privateKeychain } from '@/threads/chats';

/**
 * Whether this phone may send this private chat's voice notes through Twring's server. `given` is
 * undefined while loading (the mic then asks, the safe default); `latest` is a ref so a recording
 * finished later never reads a stale value. Reloads when the chat turns private.
 */
export function useVoiceConsent(agentId: string, isPrivate: boolean) {
  const key = `${agentId}|${isPrivate}`;
  const [loaded, setLoaded] = useState<{ key: string; given: boolean }>();
  const given = loaded?.key === key ? loaded.given : undefined;
  const latest = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    latest.current = undefined;
    if (!isPrivate) return;
    void hasVoiceConsent(privateKeychain(), agentId).then((found) => {
      // A "Record" tapped while this was loading wins.
      if (!live || latest.current === true) return;
      latest.current = found;
      setLoaded({ key, given: found });
    });
    return () => {
      live = false;
    };
  }, [agentId, isPrivate, key]);
  const give = useCallback(() => {
    latest.current = true;
    setLoaded({ key, given: true });
    giveVoiceConsent(privateKeychain(), agentId).catch((error: unknown) =>
      reportClientError('voice_consent', error),
    );
  }, [agentId, key]);
  return { given, latest, give };
}
