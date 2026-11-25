import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Screen } from '@/components/Screen';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { Sheet } from '@/components/Sheet';
import { readDeviceId } from '@/e2e/device-key';
import {
  devicesStateFrom,
  listDevices,
  removeCopy,
  removeDevice,
  syncTrusted,
  type DeviceRow,
  type DevicesState,
} from '@/e2e/devices';
import { playCallFeedback } from '@/platform/haptics';
import { forgetThisPhonePrivateKeys, privateKeychain } from '@/threads/chats';
import { space, type, usePalette } from '@/theme/tokens';

const LOAD_FAILED = 'Twring could not load your devices. Check your connection and try again.';
const REMOVE_FAILED = 'Twring could not remove that device. Check your connection and try again.';

type Loaded = { state: DevicesState; self?: string } | { error: string };

/** The list from the server; reading it also drops devices the server removed from this phone. */
async function fetchDevices(): Promise<Loaded> {
  const api = twringApi();
  if (api?.privateDevices === undefined) return { error: LOAD_FAILED };
  try {
    const store = privateKeychain();
    const [server, self] = await Promise.all([
      listDevices({ list: () => api.privateDevices!() }),
      readDeviceId(store),
    ]);
    await syncTrusted(store, server).catch(() => undefined);
    return { state: devicesStateFrom(server, self), ...(self !== undefined && { self }) };
  } catch {
    return { error: LOAD_FAILED };
  }
}

/** The phones and computers that can read private chats (C3 #11, Task 26). */
export default function PrivateDevicesScreen() {
  const palette = usePalette();
  const [state, setState] = useState<DevicesState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [removing, setRemoving] = useState<DeviceRow | undefined>();
  const [busy, setBusy] = useState(false);
  const [selfId, setSelfId] = useState<string | undefined>();

  const apply = useCallback((found: Loaded) => {
    if ('error' in found) {
      setError(found.error);
      return;
    }
    setSelfId(found.self);
    setError(undefined);
    setState(found.state);
  }, []);
  const load = useCallback(async () => apply(await fetchDevices()), [apply]);

  useEffect(() => {
    let current = true;
    void fetchDevices().then((found) => {
      if (current) apply(found);
    });
    return () => {
      current = false;
    };
  }, [apply]);

  const confirmRemove = async (row: DeviceRow) => {
    const api = twringApi();
    if (api?.removePrivateDevice === undefined) return;
    setBusy(true);
    try {
      await removeDevice(
        {
          api: { remove: (id) => api.removePrivateDevice!(id) },
          store: privateKeychain(),
          selfId,
          forgetSelf: forgetThisPhonePrivateKeys,
        },
        row.id,
      );
      playCallFeedback('ended');
      setRemoving(undefined);
      await load();
    } catch {
      playCallFeedback('error');
      setError(REMOVE_FAILED);
      setRemoving(undefined);
    } finally {
      setBusy(false);
    }
  };

  const copy = removing === undefined ? undefined : removeCopy(removing);

  return (
    <Screen title="Devices" back>
      <View style={styles.body}>
        <Text style={[type.body, { color: palette.textSecondary }]}>
          These phones and computers can read your private chats.
        </Text>
        {error !== undefined && (
          <ErrorNotice error={{ message: error, retryable: true }} onRetry={() => void load()} />
        )}
        {state === undefined && error === undefined && (
          <ActivityIndicator accessibilityLabel="Loading devices" />
        )}
        {state !== undefined && (
          <>
            <SettingsGroup title={state.count}>
              {state.devices.map((row, i) => (
                <SettingsRow
                  key={row.id}
                  label={row.thisPhone ? `${row.name} (This phone)` : row.name}
                  value={`${row.kind}, added ${row.added}`}
                  layout="stacked"
                  accessibilityHint="Asks before removing this device"
                  divider={i < state.devices.length - 1}
                  onPress={() => setRemoving(row)}
                />
              ))}
            </SettingsGroup>
            {state.hint !== undefined && (
              <Text style={[type.body, { color: palette.textSecondary }]}>{state.hint}</Text>
            )}
          </>
        )}
      </View>
      <Sheet
        visible={copy !== undefined}
        title={copy?.title ?? ''}
        onClose={() => {
          if (!busy) setRemoving(undefined);
        }}
      >
        {copy !== undefined && removing !== undefined && (
          <View style={styles.sheet}>
            <Text style={[type.body, { color: palette.textSecondary }]}>{copy.body}</Text>
            <GhostButton
              label={copy.confirm}
              tone="danger"
              disabled={busy}
              onPress={() => void confirmRemove(removing)}
            />
            {busy && <ActivityIndicator accessibilityLabel="Removing" />}
            <GhostButton label="Cancel" disabled={busy} onPress={() => setRemoving(undefined)} />
          </View>
        )}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.lg },
  sheet: { gap: 14 },
});
