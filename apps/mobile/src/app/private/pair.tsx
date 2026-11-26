import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { GhostButton } from '@/components/GhostButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { QrScanner } from '@/components/QrScanner';
import { Screen } from '@/components/Screen';
import {
  APPROVE_ASK,
  APPROVE_DONE,
  APPROVE_PATH,
  approvalStatus,
  approveCheckCopy,
  approverUpdate,
  finishApproval,
  forgetApprovalSecrets,
  loadApprovalSecret,
  pollApproval,
  requestApproval,
  revealApproval,
  shownApprover,
  type ApproveFailure,
  type ShownApprover,
} from '@/e2e/approve';
import { loadDeviceKey } from '@/e2e/device-key';
import { listDevices } from '@/e2e/devices';
import { otherPhones } from '@/e2e/other-phones';
import { approveApi, pairApi, recoveryApi } from '@/e2e/pair-api';
import {
  claimPairing,
  confirmPairing,
  loadTrusted,
  parsePairInput,
  parseTypedPairCode,
} from '@/e2e/pairing';
import type { PairFailure, PairInput, TrustedDevice } from '@/e2e/pairing';
import { RECOVERY_COPY, restoreOffer } from '@/e2e/recovery';
import { shareHistory } from '@/e2e/share-history';
import { playCallFeedback } from '@/platform/haptics';
import { activeServerUrl } from '@/servers/active';
import { chatController, privateKeychain, resetPrivateChats } from '@/threads/chats';
import { font } from '@/theme/fonts';
import { space, type, usePalette } from '@/theme/tokens';

const HELP = 'Ask your agent on the computer to show the pairing code.';
const NOT_A_CODE = `That is not a pairing code from your computer. ${HELP}`;
const STOPPED =
  'Pairing stopped. The numbers did not match, so nothing was saved. Ask your agent on the computer to show a new pairing code.';

const FAILURE_COPY: Record<PairFailure, string> = {
  expired: 'This code has expired. Ask your agent on the computer to show a new pairing code.',
  claimed: 'This code was already used. Ask your agent on the computer to show a new pairing code.',
  mismatch: STOPPED,
  cap: 'You already have 5 devices. Remove one under Devices on the agent page first.',
  network: 'Twring could not reach the server. Check your connection and try again.',
  wrong_server:
    'This code is for a different Twring server. Sign in to that server on this phone, or pair a computer that uses the same server as this phone.',
  wrong_code: "That code didn't work. Check it on your computer and try again.",
  too_many: 'Too many tries. Wait a minute and try again.',
};

const APPROVE_FAILURE_COPY: Record<ApproveFailure | 'denied' | 'refused', string> = {
  already_added: 'This phone already has private chats.',
  cap: 'You already have 5 devices. Remove one under Devices on your other phone first.',
  busy: 'Too many phones are waiting. Try again in a few minutes.',
  expired: 'This took too long, so nothing was saved. Try again.',
  closed: 'This request was already answered. Try again.',
  mismatch: 'Approving stopped, so nothing was saved. Try again.',
  outdated: 'Your other phone needs the latest Twring. Update it, then try again.',
  network: 'Twring could not reach the server. Check your connection and try again.',
  denied: 'Your other phone did not approve this phone. Nothing was saved.',
  refused: 'Approving stopped, so nothing was saved. Try again.',
};
/** How often the new phone asks whether its other phone answered (C3 #11 P4b ruling 7). */
const APPROVE_POLL_MS = 2_000;

const SCAN_COPY = {
  needCamera: 'Twring needs the camera to scan the code on your computer.',
  cameraOff: 'Camera access is off for Twring. Turn it on in your phone settings, then try again.',
  viewfinder: 'Camera viewfinder. Point it at the code on your computer.',
  typeInstead: 'Not now',
};

type Step =
  | { kind: 'start' }
  | { kind: 'scan' }
  | { kind: 'type' }
  | { kind: 'compare'; safety: string; connector: TrustedDevice }
  | { kind: 'done'; offerRecovery: boolean }
  | { kind: 'approve'; id: string; shown?: ShownApprover }
  | { kind: 'approved' }
  | { kind: 'error'; message: string; retry: 'scan' | 'type' | 'approve' };

const deps = () => ({
  api: pairApi(),
  store: privateKeychain(),
  activeServer: activeServerUrl(),
  phoneName: Platform.OS === 'ios' ? 'iPhone' : 'Android phone',
});

/** "Safety code 1 2 3 4 5 6": a screen reader reads each digit, not "one hundred twenty three". */
function spoken(code: string): string {
  return `Safety code ${code.replace(/\D/g, '').split('').join(' ')}`;
}

/**
 * Pair this phone with a computer for private chats (ADR-044): scan the code the computer shows,
 * compare a 6-digit number on both screens, and only a "Yes" saves the computer. Opened from an
 * agent's "Make chats private" (`?agentId=`), Done returns to that agent to finish turning it on.
 */
export default function PrivatePairScreen() {
  const palette = usePalette();
  const params = useLocalSearchParams<{ agentId?: string; approve?: string }>();
  const agentId = typeof params.agentId === 'string' && params.agentId ? params.agentId : undefined;
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  // Changes on every failed try, so the scanner listens again even for the same message.
  const [failures, setFailures] = useState(0);
  // The code as typed, for people who cannot scan (the QR is on this phone, or the camera fails).
  const [typed, setTyped] = useState('');
  const typedInput = parseTypedPairCode(typed);
  // A phone with no key whose account has a recovery backup can restore instead (C3 #11).
  const [backup, setBackup] = useState<'found' | 'removed' | undefined>();
  // Other phones on this account: one of them can approve this phone (ADR-045).
  const [others, setOthers] = useState<{ id: string; name: string }[]>([]);

  const fail = (message: string, retry: 'scan' | 'type' | 'approve' = 'scan') => {
    playCallFeedback('error');
    setStep({ kind: 'error', message, retry });
  };

  // Approving from another phone (C3 #11, Task 27): ask once, then check every 2 s while open.
  const startApprove = async () => {
    setBusy(true);
    try {
      const out = await requestApproval({
        api: approveApi(),
        store: privateKeychain(),
        phoneName: deps().phoneName,
      });
      if (out.ok) setStep({ kind: 'approve', id: out.approval.id });
      else fail(APPROVE_FAILURE_COPY[out.code], 'approve');
    } catch {
      fail(APPROVE_FAILURE_COPY.network, 'approve');
    } finally {
      setBusy(false);
    }
  };

  // Opened from the Devices screen ("Connect with ..."): start asking at once.
  const autoApprove = params.approve === '1';
  useEffect(() => {
    let live = true;
    const api = twringApi();
    // One list read serves both the recovery offer and the other-phone check.
    let listed: Promise<unknown> | undefined;
    const rawList = () => (listed ??= api!.privateDevices!());
    // The device list tells a key this phone just made (opening a chat) from one in use.
    const devices = api?.privateDevices === undefined ? {} : { devices: { list: rawList } };
    restoreOffer({ api: recoveryApi(), store: privateKeychain(), ...devices }).then(
      (offer) => {
        if (live && (offer.kind === 'found' || offer.kind === 'removed')) setBackup(offer.kind);
      },
      () => undefined,
    );
    if (api?.privateDevices !== undefined)
      loadDeviceKey(privateKeychain())
        .then(async (me) => {
          const phones = await otherPhones(() => listDevices({ list: rawList }), me?.deviceId);
          // A phone this phone is already connected with has nothing to approve; the same rule
          // as Devices. A trusted list that cannot be read keeps every phone listed.
          const trusted = await loadTrusted(privateKeychain()).then(
            (list) => new Set(list.map((t) => t.id)),
            () => undefined,
          );
          return trusted === undefined ? phones : phones.filter((p) => !trusted.has(p.id));
        })
        .then(
          (phones) => {
            if (live) setOthers(phones);
          },
          // A list that will not load leaves today's layout.
          () => undefined,
        );
    if (autoApprove) void Promise.resolve().then(() => (live ? startApprove() : undefined));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approveId = step.kind === 'approve' ? step.id : undefined;
  const approveShown = step.kind === 'approve' ? step.shown : undefined;
  useEffect(() => {
    if (approveId === undefined) return;
    let live = true;
    const store = privateKeychain();
    const check = async () => {
      const out = await approvalStatus({ api: approveApi(), store }, approveId);
      if (!live || !out.ok) return;
      const approval = out.approval;
      if (approval.state === 'claimed') {
        if (approval.approver_nonce === undefined) return;
        const me = await loadDeviceKey(store);
        const secret = await loadApprovalSecret(store, approveId);
        if (!live) return;
        if (me === undefined || secret === undefined) {
          await forgetApprovalSecrets(store, approveId);
          fail(APPROVE_FAILURE_COPY.refused, 'approve');
          return;
        }
        const shown = shownApprover(approval, me, secret);
        if (shown === undefined) return;
        const update = approverUpdate(approveShown, shown);
        if (update === 'changed') {
          await forgetApprovalSecrets(store, approveId);
          fail(APPROVE_FAILURE_COPY.refused, 'approve');
        } else if (update === 'show') {
          // ADR-046: reveal only now the approving phone's nonce is fixed, then show the code.
          const revealed = await revealApproval({ api: approveApi(), store }, approval);
          if (!live) return;
          if (revealed.ok) setStep({ kind: 'approve', id: approveId, shown });
          else if (revealed.code !== 'network') {
            await forgetApprovalSecrets(store, approveId);
            fail(APPROVE_FAILURE_COPY.refused, 'approve');
          }
        }
      } else if (approval.state === 'accepted') {
        // Only the phone whose code was shown may vouch for this one (P4b ruling 5).
        const done =
          approveShown !== undefined && (await finishApproval({ store }, approval, approveShown));
        if (!live) return;
        if (done) {
          resetPrivateChats();
          // Shares this phone's earlier messages with the approver, in the background.
          const api = twringApi();
          if (api !== undefined)
            void shareHistory(api, store, chatController()?.loadedPrivateAgentIds());
          playCallFeedback('connected');
          setStep({ kind: 'approved' });
        } else {
          await forgetApprovalSecrets(store, approveId);
          fail(APPROVE_FAILURE_COPY.refused, 'approve');
        }
      } else if (approval.state === 'denied') {
        await forgetApprovalSecrets(store, approveId);
        fail(APPROVE_FAILURE_COPY.denied, 'approve');
      } else if (approval.state === 'expired') {
        await forgetApprovalSecrets(store, approveId);
        fail(APPROVE_FAILURE_COPY.expired, 'approve');
      }
    };
    const stop = pollApproval(check, APPROVE_POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, [approveId, approveShown]);

  const pair = async (input: PairInput) => {
    const retry = input.kind === 'typed' ? 'type' : 'scan';
    setNotice(undefined);
    setBusy(true);
    try {
      const result = await claimPairing(deps(), input);
      if (result.ok)
        setStep({ kind: 'compare', safety: result.safety, connector: result.connector });
      else fail(FAILURE_COPY[result.code], retry);
    } catch {
      fail(FAILURE_COPY.network, retry);
    } finally {
      setBusy(false);
    }
  };

  const onScanned = async (data: string) => {
    if (busy) return;
    const input = parsePairInput(data);
    if (input === undefined) {
      setNotice(NOT_A_CODE);
      setFailures((n) => n + 1);
      return;
    }
    await pair(input);
  };

  const onTyped = async () => {
    if (busy || typedInput === undefined) return;
    await pair(typedInput);
  };

  const onSame = async (connector: TrustedDevice) => {
    setBusy(true);
    try {
      const store = privateKeychain();
      // The first computer this phone trusts: the moment to offer a recovery key.
      const first = (await loadTrusted(store)).length === 0;
      await confirmPairing({ store }, connector);
      resetPrivateChats();
      playCallFeedback('connected');
      setStep({ kind: 'done', offerRecovery: first });
    } catch {
      fail('Twring could not save this pairing on your phone. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const heading = (text: string) => (
    <Text accessibilityRole="header" style={[styles.heading, { color: palette.textPrimary }]}>
      {text}
    </Text>
  );
  const support = (text: string) => (
    <Text style={[styles.support, { color: palette.textSecondary }]}>{text}</Text>
  );

  if (step.kind === 'compare') {
    return (
      <Screen
        title="Private chats"
        back
        footer={
          <View style={styles.actions}>
            <PrimaryButton
              label="Yes, same number"
              disabled={busy}
              onPress={() => void onSame(step.connector)}
            />
            <GhostButton label="No" disabled={busy} onPress={() => fail(STOPPED)} />
          </View>
        }
      >
        <View style={styles.step}>
          {heading(`Does your computer show ${step.safety}?`)}
          <Text
            accessible
            accessibilityLabel={spoken(step.safety)}
            style={[styles.code, { color: palette.textPrimary }]}
          >
            {step.safety}
          </Text>
          {support('Only say yes if the number on your computer is exactly the same.')}
          {busy && <ActivityIndicator accessibilityLabel="Saving" />}
        </View>
      </Screen>
    );
  }

  if (step.kind === 'done') {
    const finish = () =>
      agentId === undefined
        ? router.back()
        : router.dismissTo({
            pathname: '/agents/[id]',
            params: { id: agentId, private: 'ask' },
          });
    return (
      <Screen
        title="Private chats"
        footer={
          step.offerRecovery ? (
            <View style={styles.actions}>
              <PrimaryButton
                label="Save a recovery key"
                onPress={() =>
                  router.replace({
                    pathname: '/private/recovery',
                    params: { mode: 'create', ...(agentId !== undefined && { agentId }) },
                  })
                }
              />
              <GhostButton label="Not now" onPress={finish} />
            </View>
          ) : (
            <PrimaryButton label="Done" onPress={finish} />
          )
        }
      >
        <View style={styles.step}>
          {heading('Paired')}
          {support('Private: only your phone and your computer can read this')}
          {step.offerRecovery && support(RECOVERY_COPY.offer)}
        </View>
      </Screen>
    );
  }

  if (step.kind === 'approve') {
    return (
      <Screen
        title="Private chats"
        back
        footer={<GhostButton label="Cancel" onPress={() => setStep({ kind: 'start' })} />}
      >
        <View style={styles.step}>
          {step.shown === undefined ? (
            <>
              {heading(APPROVE_PATH)}
              {support(APPROVE_ASK)}
              <ActivityIndicator accessibilityLabel="Waiting for your other phone" />
            </>
          ) : (
            <>
              {heading(approveCheckCopy(step.shown.name, step.shown.code))}
              <Text
                accessible
                accessibilityLabel={spoken(step.shown.code)}
                style={[styles.code, { color: palette.textPrimary }]}
              >
                {step.shown.code}
              </Text>
            </>
          )}
        </View>
      </Screen>
    );
  }

  if (step.kind === 'approved') {
    return (
      <Screen
        title="Private chats"
        footer={<PrimaryButton label="Done" onPress={() => router.back()} />}
      >
        <View style={styles.step}>
          {heading('Approved')}
          {support(APPROVE_DONE)}
        </View>
      </Screen>
    );
  }

  if (step.kind === 'error') {
    return (
      <Screen
        title="Private chats"
        back
        footer={
          step.retry === 'approve' ? (
            <PrimaryButton label="Try again" disabled={busy} onPress={() => void startApprove()} />
          ) : step.retry === 'type' ? (
            <PrimaryButton label="Type the code again" onPress={() => setStep({ kind: 'type' })} />
          ) : (
            <PrimaryButton label="Scan again" onPress={() => setStep({ kind: 'scan' })} />
          )
        }
      >
        <View style={styles.step}>
          {heading('Not paired')}
          <ErrorNotice error={{ message: step.message, retryable: true }} />
        </View>
      </Screen>
    );
  }

  if (step.kind === 'type') {
    return (
      <Screen
        title="Private chats"
        back
        footer={
          <View style={styles.actions}>
            <PrimaryButton
              label="Continue"
              disabled={busy || typedInput === undefined}
              onPress={() => void onTyped()}
            />
            <GhostButton
              label="Scan instead"
              disabled={busy}
              onPress={() => setStep({ kind: 'scan' })}
            />
          </View>
        }
      >
        <View style={styles.step}>
          {heading('Type the code')}
          {support('Type the 16 characters your computer shows under the square code.')}
          <Field
            label="Code from your computer"
            hint="For example 7KQ2-M9XD-4HTP-W3RV"
            value={typed}
            onChangeText={setTyped}
            maxLength={24}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            autoFocus
            returnKeyType="go"
            onSubmitEditing={() => void onTyped()}
          />
          {busy && <ActivityIndicator accessibilityLabel="Checking" />}
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      title="Private chats"
      back
      footer={
        step.kind === 'start' ? (
          <View style={styles.actions}>
            {others.length > 0 && (
              <PrimaryButton
                label={APPROVE_PATH}
                disabled={busy}
                onPress={() => void startApprove()}
              />
            )}
            {others.length > 0 ? (
              <GhostButton
                label="Scan the code on your computer"
                accessibilityHint="Opens the camera"
                onPress={() => setStep({ kind: 'scan' })}
              />
            ) : (
              <PrimaryButton
                label="Scan the code on your computer"
                accessibilityHint="Opens the camera"
                onPress={() => setStep({ kind: 'scan' })}
              />
            )}
            <GhostButton label="Type the code instead" onPress={() => setStep({ kind: 'type' })} />
            {others.length === 0 && (
              <GhostButton
                label={APPROVE_PATH}
                disabled={busy}
                onPress={() => void startApprove()}
              />
            )}
            {backup === 'found' && (
              <GhostButton
                label="Use my recovery key"
                onPress={() =>
                  router.push({
                    pathname: '/private/recovery',
                    params: { mode: 'restore', ...(agentId !== undefined && { agentId }) },
                  })
                }
              />
            )}
          </View>
        ) : undefined
      }
    >
      <View style={styles.step}>
        {heading('Pair with your computer')}
        {others.length > 0 &&
          support(
            `You already have private chats on ${others.length === 1 ? others[0].name : 'your other phone'}. Approve this phone from there, so both phones can read the same chats.`,
          )}
        {support(HELP)}
        {backup === 'removed' && support(RECOVERY_COPY.removed)}
        {notice !== undefined && <ErrorNotice error={{ message: notice, retryable: true }} />}
        {step.kind === 'scan' && (
          <QrScanner
            copy={SCAN_COPY}
            busy={busy}
            attempt={failures}
            onScanned={(data) => void onScanned(data)}
            onTypeInstead={() => {
              setNotice(undefined);
              setStep({ kind: 'start' });
            }}
          />
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { gap: space.lg },
  actions: { gap: space.md },
  heading: { fontFamily: font.display, fontSize: type.screenTitle.fontSize, letterSpacing: -0.8 },
  support: { fontFamily: font.body, fontSize: type.body.fontSize },
  code: { fontFamily: font.display, fontSize: 40, letterSpacing: 4, textAlign: 'center' },
});
