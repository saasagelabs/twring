import type { Agent } from '@twring/contracts';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { Sheet } from '@/components/Sheet';
import { loadTrusted, type TrustedDevice } from '@/e2e/pairing';
import {
  confirmPrivateCopy,
  PRIVATE_ROW_LABEL,
  showPrivateRow,
  turnOnPrivate,
} from '@/e2e/private-state';
import { privateAvailability } from '@/e2e/private-availability';
import { playCallFeedback } from '@/platform/haptics';
import { activeServerUrl } from '@/servers/active';
import { currentScope, privateKeychain } from '@/threads/chats';
import { type, usePalette } from '@/theme/tokens';

/**
 * "Make chats private" on a computer agent (ADR-044). Hidden unless private chats are on for this
 * account (asked once per session per server and account); with no paired computer it pairs first, and pairing returns here with `ask` set.
 */
export function PrivateChatsRow({
  agent,
  isPrivate,
  ask,
  onTurnedOn,
}: {
  agent: Pick<Agent, 'id' | 'name' | 'protocol'>;
  isPrivate: boolean;
  /** Back from pairing: open the confirmation at once. */
  ask: boolean;
  onTurnedOn: () => void;
}) {
  const palette = usePalette();
  const availabilityKey = `${activeServerUrl()}|${currentScope() ?? ''}`;
  const [available, setAvailable] = useState(
    () => privateAvailability.peek(availabilityKey) === 'on',
  );
  const [trusted, setTrusted] = useState<TrustedDevice[]>([]);
  // Back from pairing: the question opens at once.
  const [visible, setVisible] = useState(ask && !isPrivate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    const api = twringApi();
    if (api?.privateChatsStatus !== undefined)
      void privateAvailability
        .ask(availabilityKey, () => api.privateChatsStatus!())
        .then((status) => {
          // Unknown (offline, a server error) reads as off for now and is asked again later.
          if (current) setAvailable(status === 'on');
        });
    void loadTrusted(privateKeychain())
      .then((found) => {
        if (current) setTrusted(found);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [ask, availabilityKey]);

  if (!showPrivateRow({ available, agent })) return null;
  const copy = confirmPrivateCopy(agent.name);

  const confirm = async () => {
    const api = twringApi();
    if (api?.setPrivate === undefined) return;
    setBusy(true);
    setError(undefined);
    const result = await turnOnPrivate({
      agentId: agent.id,
      trusted: await loadTrusted(privateKeychain()).catch(() => trusted),
      nav: router,
      api: { setPrivate: (id) => api.setPrivate!(id) },
    });
    setBusy(false);
    if (result.status === 'failed') {
      playCallFeedback('error');
      setError(result.message);
      return;
    }
    setVisible(false);
    if (result.status === 'on') {
      playCallFeedback('connected');
      onTurnedOn();
    }
  };

  return (
    <SettingsGroup title="Privacy">
      {isPrivate ? (
        <SettingsRow label="Private chats" value="On" divider={false} />
      ) : (
        <SettingsRow
          label={PRIVATE_ROW_LABEL}
          accessibilityHint="Asks before making new messages private"
          divider={false}
          onPress={() => {
            setError(undefined);
            setVisible(true);
          }}
        />
      )}
      <Sheet
        visible={visible}
        title={copy.title}
        onClose={() => {
          if (!busy) setVisible(false);
        }}
      >
        <View style={styles.sheet}>
          {error !== undefined && <ErrorNotice error={{ message: error, retryable: true }} />}
          <Text style={[type.body, { color: palette.textSecondary }]}>{copy.body}</Text>
          <GhostButton label={copy.confirm} disabled={busy} onPress={() => void confirm()} />
          {busy && <ActivityIndicator accessibilityLabel="Turning on" />}
          <GhostButton label="Cancel" disabled={busy} onPress={() => setVisible(false)} />
        </View>
      </Sheet>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({ sheet: { gap: 14 } });
