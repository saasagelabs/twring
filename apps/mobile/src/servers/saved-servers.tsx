import { useState, useSyncExternalStore } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { ErrorNotice } from '../components/ErrorNotice';
import { TextButton } from '../components/TextButton';
import { playCallFeedback } from '../platform/haptics';
import { space, type, usePalette } from '../theme/tokens';

import { profileStore, type SelfhostProfile } from './profiles';
import { forgetServer, switchToServer } from './switching';

const subscribe = (listener: () => void) => profileStore.subscribe(listener);
const snapshot = () => profileStore.list();

/**
 * The servers this phone is paired with, as quiet rows under the sign-in buttons: use one again,
 * or forget it on this phone. Renders nothing when none are saved.
 */
export function SavedServers() {
  const palette = usePalette();
  const profiles = useSyncExternalStore(subscribe, snapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const saved = profiles.filter((p): p is SelfhostProfile => p.kind === 'selfhost');
  if (saved.length === 0) return null;

  async function use(serverId: string) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const result = await switchToServer(serverId).catch(() => undefined);
    setBusy(false);
    if (result === undefined || !result.ok) {
      setError(
        result?.message ??
          "Couldn't reach that server. Check the address, and that the server is running.",
      );
      playCallFeedback('error');
    }
  }

  function confirmForget(profile: SelfhostProfile) {
    Alert.alert(`Forget ${profile.name}?`, 'You can pair this phone again with a new code.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: () => void forgetServer(profile.serverId).catch(() => undefined),
      },
    ]);
  }

  return (
    <View style={styles.list}>
      {saved.map((profile) => (
        <View key={profile.serverId} style={styles.row}>
          <TextButton
            label={`Use ${profile.name}`}
            disabled={busy}
            accessibilityHint={`Signs in with ${profile.name}`}
            onPress={() => void use(profile.serverId)}
          />
          <TextButton
            label="Forget"
            disabled={busy}
            accessibilityHint={`Removes ${profile.name} from this phone`}
            onPress={() => confirmForget(profile)}
          />
        </View>
      ))}
      {error !== undefined && <ErrorNotice error={{ message: error, retryable: false }} />}
      {busy && <Text style={[type.body, { color: palette.textSecondary }]}>Connecting</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
