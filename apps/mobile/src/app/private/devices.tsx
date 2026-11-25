import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Screen } from '@/components/Screen';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { Sheet } from '@/components/Sheet';
import {
  APPROVE_BUTTON,
  approveSheetCopy,
  approveWaiting,
  claimWaiting,
  DENY_BUTTON,
  denyWaiting,
  listWaiting,
  WAITING_TITLE,
  type ClaimedApproval,
} from '@/e2e/approve';
import { loadDeviceKey } from '@/e2e/device-key';
import {
  devicesStateFrom,
  listDevices,
  removeCopy,
  removeDevice,
  syncTrusted,
  type DeviceRow,
  type DevicesState,
} from '@/e2e/devices';
import { approveApi } from '@/e2e/pair-api';
import { playCallFeedback } from '@/platform/haptics';
import { shareHistory } from '@/e2e/share-history';
import { chatController, forgetThisPhonePrivateKeys, privateKeychain } from '@/threads/chats';
import { space, type, usePalette } from '@/theme/tokens';

const LOAD_FAILED = 'Twring could not load your devices. Check your connection and try again.';
const REMOVE_FAILED = 'Twring could not remove that device. Check your connection and try again.';
const APPROVE_FAILED =
  "Twring couldn't finish approving that phone. Ask again from the new phone and try once more.";

type Waiting = { id: string; name: string };
type Loaded = { state: DevicesState; self?: string; waiting: Waiting[] } | { error: string };

/** The list from the server; reading it also drops devices the server removed from this phone. */
async function fetchDevices(): Promise<Loaded> {
  const api = twringApi();
  if (api?.privateDevices === undefined) return { error: LOAD_FAILED };
  try {
    const store = privateKeychain();
    const [server, me, waiting] = await Promise.all([
      listDevices({ list: () => api.privateDevices!() }),
      loadDeviceKey(store),
      listWaiting({ api: approveApi(), store }).catch(() => []),
    ]);
    const self = me?.deviceId;
    // Phones another of this person's phones approved become trusted here too.
    await syncTrusted(store, server, undefined, me).catch(() => undefined);
    return {
      state: devicesStateFrom(server, self),
      ...(self !== undefined && { self }),
      waiting: waiting.map((a) => ({ id: a.id, name: a.name })),
    };
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
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [approving, setApproving] = useState<ClaimedApproval | undefined>();

  const apply = useCallback((found: Loaded) => {
    if ('error' in found) {
      setError(found.error);
      return;
    }
    setSelfId(found.self);
    setWaiting(found.waiting);
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

  /** Tapping a waiting phone takes it, so both phones show the same code. */
  const openWaiting = async (row: Waiting) => {
    setBusy(true);
    try {
      const out = await claimWaiting({ api: approveApi(), store: privateKeychain() }, row.id);
      if (out.ok) setApproving(out.claimed);
      else {
        playCallFeedback('error');
        setError(APPROVE_FAILED);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (approving === undefined) return;
    setBusy(true);
    try {
      const deps = { api: approveApi(), store: privateKeychain() };
      const out = approve
        ? await approveWaiting(deps, approving.approval)
        : await denyWaiting(deps, approving.approval.id);
      playCallFeedback(out.ok ? (approve ? 'connected' : 'ended') : 'error');
      if (!out.ok) setError(APPROVE_FAILED);
      // The new phone's older private messages: shared in the background, resumed on next open.
      const api = twringApi();
      if (out.ok && approve && api !== undefined) {
        const chats = chatController()?.getSummaries() ?? [];
        void shareHistory(
          api,
          deps.store,
          chats.filter((c) => c.private === true).map((c) => c.agent_id),
        );
      }
      setApproving(undefined);
      await load();
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
            {waiting.length > 0 && (
              <SettingsGroup title={WAITING_TITLE}>
                {waiting.map((row, i) => (
                  <SettingsRow
                    key={row.id}
                    label={row.name}
                    value="Tap to approve"
                    layout="stacked"
                    accessibilityHint="Shows a code to compare with that phone"
                    divider={i < waiting.length - 1}
                    onPress={() => void openWaiting(row)}
                  />
                ))}
              </SettingsGroup>
            )}
            {state.hint !== undefined && (
              <Text style={[type.body, { color: palette.textSecondary }]}>{state.hint}</Text>
            )}
            <SettingsGroup title="Recovery key">
              <SettingsRow
                label="Save a recovery key"
                value="Lets a new phone read old private messages"
                layout="stacked"
                accessibilityHint="Shows 12 words to write down"
                onPress={() => router.push('/private/recovery')}
              />
            </SettingsGroup>
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
      <Sheet
        visible={approving !== undefined}
        title={approving?.approval.name ?? ''}
        onClose={() => {
          if (!busy) setApproving(undefined);
        }}
      >
        {approving !== undefined && (
          <View style={styles.sheet}>
            <Text
              style={[type.title, { color: palette.textPrimary }]}
              accessibilityLabel={approving.code.split('').join(' ')}
            >
              {approving.code}
            </Text>
            <Text style={[type.body, { color: palette.textSecondary }]}>
              {approveSheetCopy(approving.approval.name)}
            </Text>
            <GhostButton label={APPROVE_BUTTON} disabled={busy} onPress={() => void decide(true)} />
            <GhostButton
              label={DENY_BUTTON}
              tone="danger"
              disabled={busy}
              onPress={() => void decide(false)}
            />
            {busy && <ActivityIndicator accessibilityLabel="Approving" />}
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
