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
import { playCallFeedback } from '@/platform/haptics';
import { deviceOnlyStore } from '@/platform/secure-store';
import { type, usePalette } from '@/theme/tokens';

/**
 * "Make chats private" on a computer agent (ADR-044). Hidden unless the server offers private
 * chats; with no paired computer it pairs first, and pairing returns here with `ask` set.
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
  const [features, setFeatures] = useState<string[]>([]);
  const [trusted, setTrusted] = useState<TrustedDevice[]>([]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    void twringApi()
      ?.serverFeatures?.()
      .then((found) => {
        if (current) setFeatures(found);
      })
      .catch(() => undefined);
    void loadTrusted(deviceOnlyStore)
      .then((found) => {
        if (current) setTrusted(found);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [ask]);

  useEffect(() => {
    if (ask && !isPrivate) setVisible(true);
  }, [ask, isPrivate]);

  if (!showPrivateRow({ features, agent })) return null;
  const copy = confirmPrivateCopy(agent.name);

  const confirm = async () => {
    const api = twringApi();
    if (api?.setPrivate === undefined) return;
    setBusy(true);
    setError(undefined);
    const result = await turnOnPrivate({
      agentId: agent.id,
      trusted: await loadTrusted(deviceOnlyStore).catch(() => trusted),
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
