import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Screen } from '@/components/Screen';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { Sheet } from '@/components/Sheet';
import {
  APPROVE_BUTTON,
  APPROVE_OUTDATED,
  approveNewPhoneWaitingCopy,
  approveSheetCopy,
  approveWaiting,
  checkReveal,
  claimWaiting,
  DENY_BUTTON,
  denyWaiting,
  forgetApprovalSecrets,
  listWaiting,
  pollApproval,
  resumePendingApprove,
  settlePendingApprove,
  type ResumeResult,
  WAITING_TITLE,
  type CheckedApproval,
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
const DECIDE_OFFLINE = 'Twring could not reach the server. Check your connection and tap again.';
const APPROVE_UNFINISHED =
  "Twring couldn't confirm that approval yet. It finishes the next time you open Devices with a connection.";

type Waiting = { id: string; name: string };
/** Claimed and waiting for the new phone's reveal, or checked with the code to compare. */
type Approving = {
  claimed: ClaimedApproval;
  checked?: CheckedApproval;
  /** An approve that failed on the network may have gone through, so a deny could no longer undo it. */
  acceptSent?: boolean;
};
/** How often the approving phone asks whether the new phone sent what the code needs. */
const REVEAL_POLL_MS = 2_000;
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
    const trusted = await syncTrusted(store, server, undefined, me).catch(() => undefined);
    return {
      state: devicesStateFrom(server, self, trusted && new Set(trusted.map((t) => t.id))),
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
  const [approving, setApproving] = useState<Approving | undefined>();
  const [connecting, setConnecting] = useState<DeviceRow | undefined>();
  /** What went wrong inside the approve sheet; the screen's own error stays for loads and removals. */
  const [sheetError, setSheetError] = useState<string | undefined>();

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
  const load = useCallback(async () => {
    const found = await fetchDevices();
    apply(found);
    return found;
  }, [apply]);
  /** An approve whose answer was lost: finished now if the connection is back. */
  const finishLostApprove = useCallback(async (): Promise<ResumeResult> => {
    const store = privateKeychain();
    // Nothing readable is nothing to finish: a keychain that fails says nothing about an approve.
    const out = await resumePendingApprove({ api: approveApi(), store }).catch(
      () => 'none' as const,
    );
    const api = twringApi();
    if (out === 'done' && api !== undefined)
      void shareHistory(api, store, chatController()?.loadedPrivateAgentIds());
    return out;
  }, []);
  /**
   * After the list loaded (which clears the error): what became of that approve, if anything. One
   * that ended is said even when the list failed, as it is gone and no Retry could say it; one
   * still waiting leaves a failed list its own error and is tried again with it.
   */
  const sayResumed = (found: Loaded, out: ResumeResult) => {
    if (out === 'ended') setError(APPROVE_FAILED);
    else if (out === 'waiting' && !('error' in found)) setError(APPROVE_UNFINISHED);
  };

  useEffect(() => {
    let current = true;
    void (async () => {
      const found = await fetchDevices();
      if (!current) return;
      apply(found);
      const out = await finishLostApprove();
      if (!current) return;
      if (out === 'done') await load();
      else sayResumed(found, out);
    })();
    return () => {
      current = false;
    };
  }, [apply, finishLostApprove, load]);

  /** An error inside the approve sheet, read out at once (focus stays on the button). */
  const sayInSheet = (message: string) => {
    setSheetError(message);
    AccessibilityInfo.announceForAccessibility(message);
  };

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
    setSheetError(undefined);
    try {
      const deps = { api: approveApi(), store: privateKeychain() };
      const out = await claimWaiting(deps, row.id);
      if (out.ok) setApproving({ claimed: out.claimed });
      else {
        // An older app on the new phone would show a code this phone never shows: turn it down,
        // so that phone says it was not approved instead of waiting until the request expires.
        if (out.code === 'outdated') await denyWaiting(deps, row.id);
        playCallFeedback('error');
        // After the reload, which clears the error it finds none of its own.
        await load();
        setError(out.code === 'outdated' ? APPROVE_OUTDATED : APPROVE_FAILED);
      }
    } finally {
      setBusy(false);
    }
  };

  // Waits for the new phone's reveal; the code exists only once it opened the commitment.
  const pendingClaim = approving?.checked === undefined ? approving?.claimed : undefined;
  useEffect(() => {
    if (pendingClaim === undefined) return;
    let live = true;
    const stop = pollApproval(async () => {
      const out = await checkReveal({ api: approveApi(), store: privateKeychain() }, pendingClaim);
      if (!live) return;
      if (out.ok && 'checked' in out) {
        stop();
        setSheetError(undefined);
        setApproving({ claimed: pendingClaim, checked: out.checked });
      } else if (!out.ok && out.code !== 'network') {
        stop();
        // Over for good: the saved nonce and claim go too (a network failure keeps them to resume).
        await forgetApprovalSecrets(privateKeychain(), pendingClaim.approval.id);
        playCallFeedback('error');
        setError(APPROVE_FAILED);
        setSheetError(undefined);
        setApproving(undefined);
      }
    }, REVEAL_POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, [pendingClaim]);

  const decide = async (approve: boolean) => {
    if (approving === undefined) return;
    const id = approving.claimed.approval.id;
    setBusy(true);
    setSheetError(undefined);
    try {
      const deps = { api: approveApi(), store: privateKeychain() };
      // A saved approve still finishing runs first, so the two never race (`resumePendingApprove`).
      await settlePendingApprove(deps.store);
      const out =
        approve && approving.checked !== undefined
          ? await approveWaiting(deps, approving.checked)
          : await denyWaiting(deps, id);
      // A deny the server already took (its first answer was lost), or a request that ran out:
      // that phone is not added either way, which is what the person asked for.
      const deniedAnyway = !approve && !out.ok && ['closed', 'expired'].includes(out.code);
      playCallFeedback(out.ok || deniedAnyway ? (approve ? 'connected' : 'ended') : 'error');
      // Nothing is over yet: the sheet stays with the same codes and tapping again carries on (an
      // accept the server already took gets the same answer again). After an approve only Approve
      // stays: if it went through, a deny would be refused and this phone would never finish it.
      if (!out.ok && out.code === 'network') {
        sayInSheet(DECIDE_OFFLINE);
        if (approve) setApproving({ ...approving, acceptSent: true });
        return;
      }
      // Only an approval that is over for good drops its saved nonce and claim: after 'cap' (a
      // device freed up) or a network failure, tapping the waiting phone again carries on.
      if (!out.ok && ['mismatch', 'closed', 'expired', 'forgotten'].includes(out.code))
        await forgetApprovalSecrets(deps.store, id);
      // The new phone's older private messages: shared in the background, resumed on next open.
      const api = twringApi();
      if (out.ok && approve && api !== undefined) {
        void shareHistory(api, deps.store, chatController()?.loadedPrivateAgentIds());
      }
      setApproving(undefined);
      // After the reload, which clears the error it finds none of its own.
      await load();
      // 'forgotten': this phone's keys were cleared meanwhile, by the person's own sign-out or
      // removal, so there is nothing to tell them about this approve.
      if (!out.ok && out.code !== 'forgotten' && !deniedAnyway) setError(APPROVE_FAILED);
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
          <ErrorNotice
            error={{ message: error, retryable: true }}
            onRetry={() =>
              void finishLostApprove().then(async (out) => sayResumed(await load(), out))
            }
          />
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
                  value={
                    row.connected
                      ? `${row.kind}, added ${row.added}`
                      : `${row.kind}, not connected to this phone`
                  }
                  layout="stacked"
                  accessibilityHint={
                    row.connected
                      ? 'Asks before removing this device'
                      : 'Offers to connect with this phone'
                  }
                  divider={i < state.devices.length - 1}
                  onPress={() => (row.connected ? setRemoving(row) : setConnecting(row))}
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
        title={approving?.claimed.approval.name ?? ''}
        onClose={() => {
          if (busy) return;
          // It may have gone through: saved, and finished the next time Devices opens.
          if (approving?.acceptSent === true) setError(APPROVE_UNFINISHED);
          setApproving(undefined);
          setSheetError(undefined);
        }}
      >
        {approving !== undefined && approving.checked === undefined && (
          <View style={styles.sheet}>
            <Text style={[type.body, { color: palette.textSecondary }]}>
              {approveNewPhoneWaitingCopy(approving.claimed.approval.name)}
            </Text>
            <ActivityIndicator accessibilityLabel="Waiting for the new phone" />
            {sheetError !== undefined && (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[type.body, { color: palette.textSecondary }]}
              >
                {sheetError}
              </Text>
            )}
            <GhostButton
              label={DENY_BUTTON}
              tone="danger"
              disabled={busy}
              onPress={() => void decide(false)}
            />
          </View>
        )}
        {approving?.checked !== undefined && (
          <View style={styles.sheet}>
            <Text
              style={[type.title, { color: palette.textPrimary }]}
              accessibilityLabel={approving.checked.code.split('').join(' ')}
            >
              {approving.checked.code}
            </Text>
            <Text style={[type.body, { color: palette.textSecondary }]}>
              {approveSheetCopy(approving.checked.approval.name)}
            </Text>
            {sheetError !== undefined && (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[type.body, { color: palette.textSecondary }]}
              >
                {sheetError}
              </Text>
            )}
            <GhostButton label={APPROVE_BUTTON} disabled={busy} onPress={() => void decide(true)} />
            {approving.acceptSent !== true && (
              <GhostButton
                label={DENY_BUTTON}
                tone="danger"
                disabled={busy}
                onPress={() => void decide(false)}
              />
            )}
            {busy && <ActivityIndicator accessibilityLabel="Approving" />}
          </View>
        )}
      </Sheet>
      <Sheet
        visible={connecting !== undefined}
        title={connecting === undefined ? '' : `Connect with ${connecting.name}?`}
        onClose={() => setConnecting(undefined)}
      >
        {connecting !== undefined && (
          <View style={styles.sheet}>
            <Text style={[type.body, { color: palette.textSecondary }]}>
              {`So both phones can read the same private chats. Tap Start, then open Twring on ${connecting.name} and approve this phone in Devices.`}
            </Text>
            <GhostButton
              label="Start"
              onPress={() => {
                setConnecting(undefined);
                router.push('/private/pair?approve=1');
              }}
            />
            <GhostButton
              label={`Remove ${connecting.name}`}
              tone="danger"
              onPress={() => {
                setRemoving(connecting);
                setConnecting(undefined);
              }}
            />
            <GhostButton label="Cancel" onPress={() => setConnecting(undefined)} />
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
