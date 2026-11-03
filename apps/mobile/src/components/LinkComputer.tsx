import { router } from 'expo-router';
import { useEffect, useReducer, useRef } from 'react';
import {
  cancelAnimation,
  useReducedMotion,
  useSharedValue,
  withTiming,
  withSequence,
} from 'react-native-reanimated';
import { BackHandler, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import {
  agentDescription,
  confirmTitle,
  createLinkWizard,
  doneCopy,
  linkCommand,
  linkBackAction,
  linkErrorCopy,
  linkReducer,
  pendingAgentRequests,
  pickLabel,
  readLinkInput,
  stepNeedsLinkCode,
  type LinkState,
} from '@/agents/link';
import type { LinkApproveResponse } from '@twring/contracts';
import { twringApi } from '@/api';
import { Avatar } from '@/components/Avatar';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { Icon } from '@/components/Icon';
import { QrScanner } from '@/components/QrScanner';
import { PrimaryButton } from '@/components/PrimaryButton';
import { goBack, Screen } from '@/components/Screen';
import { TextButton } from '@/components/TextButton';
import { Waveform } from '@/components/Waveform';
import { activeServerUrl, downloadsServerUrl } from '@/servers/active';
import { radius, space, type, usePalette } from '@/theme/tokens';
import { font } from '@/theme/fonts';

const SCAN_COPY = {
  needCamera: 'Twring needs the camera to scan the code on your computer.',
  cameraOff:
    'Camera access is off for Twring. Turn it on in your phone settings, or type the code instead.',
  viewfinder: 'Camera viewfinder. Point it at the code on your computer.',
  typeInstead: 'Type the code instead',
};

function Heading({ children }: { children: string }) {
  const palette = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.heading, { color: palette.textPrimary }]}>
      {children}
    </Text>
  );
}

function Support({ children }: { children: string }) {
  const palette = usePalette();
  return <Text style={[styles.support, { color: palette.textSecondary }]}>{children}</Text>;
}

function SuccessWave({ color }: { color: string }) {
  const reduceMotion = useReducedMotion();
  const level = useSharedValue(reduceMotion ? 0.3 : 0.18);
  useEffect(() => {
    if (!reduceMotion)
      level.value = withSequence(
        withTiming(0.6, { duration: 600 }),
        withTiming(0.3, { duration: 600 }),
      );
    return () => cancelAnimation(level);
  }, [level, reduceMotion]);
  return (
    <Waveform color={color} intensity={level} width={280} height={90} animated={!reduceMotion} />
  );
}

/** One agent the computer found, as a big checkable row. Selection is not color-only. */
function AgentRow({
  id,
  label,
  description,
  selected,
  disabled,
  onPress,
}: {
  id: string;
  label: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={`${label}. ${description}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.agent,
        {
          backgroundColor: palette.surface,
          borderColor: selected ? palette.borderAccent : palette.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Avatar id={id} name={label} size={44} />
      <View style={styles.agentText}>
        <Text style={[type.bodyEmphasis, { color: palette.textPrimary }]}>{label}</Text>
        <Text
          style={[
            type.caption,
            {
              color:
                description === 'Already on your phone'
                  ? palette.textTertiary
                  : palette.textSecondary,
            },
          ]}
        >
          {description}
        </Text>
      </View>
      <View
        style={[
          styles.mark,
          {
            borderColor: selected ? palette.accent : palette.borderStrong,
            backgroundColor: selected ? palette.accent : 'transparent',
            opacity: disabled && !selected ? 0.45 : 1,
          },
        ]}
      >
        {selected && <Icon name="check" size={15} color={palette.onAccent} strokeWidth={2.5} />}
      </View>
    </Pressable>
  );
}

/**
 * "On my computer", computer first (ADR-025): run the downloaded connector, scan its code, confirm the
 * computer by name, and add the agents it found. `onOtherWays` opens the older show-a-code flow.
 * With `linked` (a computer the agent linked itself, ADR-027) it opens on the agent picker.
 */
export function LinkComputer({
  onOtherWays,
  linked,
  alreadyAdded,
}: {
  onOtherWays: () => void;
  linked?: LinkApproveResponse;
  /** Local agents of `linked` already on this phone: shown checked, locked. */
  alreadyAdded?: readonly string[];
}) {
  const palette = usePalette();
  const api = twringApi();
  const [state, dispatch] = useReducer(linkReducer, linked, (start) =>
    start === undefined
      ? createLinkWizard()
      : linkReducer(createLinkWizard(), { type: 'APPROVED', linked: start, alreadyAdded }),
  );
  const server = activeServerUrl();
  const command = linkCommand(server, downloadsServerUrl());
  const stateRef = useRef<LinkState>(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // The request each busy step needs. Leaving the step (Back, a failure, unmounting) aborts it.
  useEffect(() => {
    const code = state.code;
    if (api === undefined || !state.busy) return;
    // A computer linked by an agent message starts at the picker with no code; its save still runs.
    if (code === undefined && stepNeedsLinkCode(state.step)) return;
    const controller = new AbortController();
    const { signal } = controller;
    const failed = (reason: unknown) => {
      if (!signal.aborted) dispatch({ type: 'FAILED', copy: linkErrorCopy(reason) });
    };
    switch (state.step) {
      case 'scan':
      case 'type':
        if (code === undefined) break;
        api.getLinkRequest(code, signal).then((details) => {
          if (!signal.aborted) dispatch({ type: 'FOUND', details });
        }, failed);
        break;
      case 'confirm':
        if (code === undefined) break;
        api.approveLink(code, signal).then((linked) => {
          if (!signal.aborted) dispatch({ type: 'APPROVED', linked });
        }, failed);
        break;
      case 'pick':
        void (async () => {
          // One at a time, so a failure part-way leaves the rest to retry, none twice.
          for (const { localAgent, request } of pendingAgentRequests(stateRef.current)) {
            const saved = await api.createAgent(request, signal);
            if (signal.aborted) return;
            dispatch({
              type: 'AGENT_SAVED',
              localAgent,
              ...(saved.relinked === true && { relinkedAs: saved.name }),
            });
          }
          if (!signal.aborted) dispatch({ type: 'ALL_SAVED' });
        })().catch(failed);
        break;
      case 'start':
      case 'done':
        break;
    }
    return () => controller.abort();
  }, [api, state.busy, state.step, state.code]);

  function lookUp(input: string) {
    const read = readLinkInput(input, server);
    if (!read.ok) {
      dispatch({ type: 'FAILED', copy: { message: read.message, retryable: false } });
      return;
    }
    dispatch({ type: 'LOOKUP_STARTED', code: read.code });
  }

  /** Cancel on the confirm step tells the computer, then leaves. */
  function cancel() {
    const code = state.code;
    if (api !== undefined && code !== undefined && state.step === 'confirm') {
      void api.rejectLink(code).catch(() => undefined);
    }
    goBack();
  }

  function back() {
    switch (linkBackAction(state)) {
      case 'step-back':
        dispatch({ type: 'BACK' });
        return;
      case 'cancel':
        cancel();
        return;
      case 'leave':
        goBack();
        return;
      case 'stay':
        // Linking or adding agents is under way; the screen moves on by itself.
        return;
    }
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => subscription.remove();
  });

  const errorNotice = state.error !== undefined ? <ErrorNotice error={state.error} /> : undefined;

  function content() {
    switch (state.step) {
      case 'start':
        return (
          <>
            <Heading>Connect your computer</Heading>
            <Support>
              On your computer, open a terminal (for example Terminal on a Mac, or PowerShell on
              Windows) and run this. It shows a code to scan.
            </Support>
            {command === undefined ? (
              <Support>This app can't make a command for its server. Check the app setup.</Support>
            ) : (
              <>
                <Text
                  selectable
                  accessibilityLabel={`Command: ${command}`}
                  style={[
                    type.bodyEmphasis,
                    styles.command,
                    { color: palette.textPrimary, borderColor: palette.border },
                  ]}
                >
                  {command}
                </Text>
                <Support>
                  Needs Node.js 20 or newer. On Windows PowerShell, use curl.exe and run the two
                  parts one after the other.
                </Support>
                <View style={styles.inline}>
                  <TextButton
                    label="Copy the command"
                    onPress={() => {
                      void import('expo-clipboard')
                        .then((clipboard) => clipboard.setStringAsync(command))
                        .catch(() => Share.share({ message: command }).catch(() => undefined));
                    }}
                  />
                  <TextButton
                    label="Share the command"
                    accessibilityHint="Send it to yourself to open on your computer"
                    onPress={() => void Share.share({ message: command })}
                  />
                </View>
              </>
            )}
          </>
        );
      case 'scan':
        return (
          <>
            <Heading>Scan the code</Heading>
            <Support>Point your camera at the code on your computer.</Support>
            {errorNotice}
            <QrScanner
              copy={SCAN_COPY}
              busy={state.busy}
              attempt={state.error}
              onScanned={lookUp}
              onTypeInstead={() => dispatch({ type: 'TYPE_INSTEAD' })}
            />
          </>
        );
      case 'type':
        return (
          <>
            <Heading>Type the code</Heading>
            <Support>Enter the 8 letters and numbers your computer shows.</Support>
            <Field
              label="Code"
              inputStyle={styles.codeInput}
              value={state.typed}
              placeholder="ABCD-EFGH"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              autoFocus
              returnKeyType="done"
              submitBehavior="submit"
              onSubmitEditing={() => lookUp(state.typed)}
              onChangeText={(value) => dispatch({ type: 'SET_TYPED', value })}
            />
            {errorNotice}
          </>
        );
      case 'confirm': {
        const details = state.details;
        if (details === undefined) return null;
        return (
          <>
            <Heading>{confirmTitle(details)}</Heading>
            <Support>Only link it if this is your computer. It found these agents:</Support>
            <View style={styles.list}>
              {details.agents.map((agent) => (
                <Text key={agent.local_agent} style={[type.body, { color: palette.textPrimary }]}>
                  {`• ${agent.label}`}
                </Text>
              ))}
            </View>
            {errorNotice}
          </>
        );
      }
      case 'pick':
        return (
          <>
            <Heading>Choose your agents</Heading>
            <Support>
              {state.linked !== undefined
                ? `Linked to ${state.linked.computer_name}. You can call each one from Home.`
                : 'You can call each one from Home.'}
            </Support>
            <View style={styles.list}>
              {state.linked?.agents.map((agent) => (
                <AgentRow
                  key={agent.local_agent}
                  id={agent.local_agent}
                  label={agent.label}
                  description={
                    alreadyAdded?.includes(agent.local_agent) === true
                      ? 'Already on your phone'
                      : agentDescription(agent)
                  }
                  selected={state.selected.includes(agent.local_agent)}
                  disabled={state.busy || state.saved.includes(agent.local_agent)}
                  onPress={() => dispatch({ type: 'TOGGLE', localAgent: agent.local_agent })}
                />
              ))}
            </View>
            {errorNotice}
          </>
        );
      case 'done':
        return (
          <View style={styles.ready}>
            <Heading>{doneCopy(state).heading}</Heading>
            <SuccessWave color={palette.accent} />
            <Support>{doneCopy(state).support}</Support>
            <View style={styles.list}>
              {state.linked?.agents
                .filter((agent) => state.saved.includes(agent.local_agent))
                .map((agent) => (
                  <View key={agent.local_agent} style={styles.doneAgent}>
                    <Avatar id={agent.local_agent} name={agent.label} size={44} online />
                    <View>
                      <Text style={[type.body, { color: palette.textPrimary }]}>
                        {doneCopy(state).reconnected[agent.local_agent] ?? agent.label}
                      </Text>
                      {doneCopy(state).reconnected[agent.local_agent] !== undefined && (
                        <Text style={[type.caption, { color: palette.textSecondary }]}>
                          Reconnected, chats kept
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
            </View>
          </View>
        );
    }
  }

  function footer() {
    switch (state.step) {
      case 'start':
        return (
          <>
            <PrimaryButton
              label="Scan the code"
              onPress={() => dispatch({ type: 'OPEN_SCANNER' })}
            />
            <View style={styles.centered}>
              <TextButton
                label="Type the code instead"
                onPress={() => dispatch({ type: 'TYPE_INSTEAD' })}
              />
              <TextButton label="Other ways to connect" onPress={onOtherWays} />
            </View>
          </>
        );
      case 'scan':
        return undefined;
      case 'type':
        return (
          <PrimaryButton
            label={state.busy ? 'Checking…' : 'Continue'}
            disabled={state.busy}
            onPress={() => lookUp(state.typed)}
          />
        );
      case 'confirm':
        return (
          <>
            <PrimaryButton
              label={state.busy ? 'Linking…' : 'Link'}
              disabled={state.busy}
              onPress={() => dispatch({ type: 'APPROVE_STARTED' })}
            />
            <PrimaryButton label="Cancel" tone="neutral" disabled={state.busy} onPress={cancel} />
          </>
        );
      case 'pick':
        return (
          <PrimaryButton
            label={state.busy ? 'Adding…' : pickLabel(state)}
            disabled={state.busy || state.selected.length === 0}
            onPress={() => dispatch({ type: 'SAVE_STARTED' })}
          />
        );
      case 'done':
        return <PrimaryButton label="Go to Home" onPress={() => router.replace('/')} />;
    }
  }

  return (
    <Screen back={state.step === 'done' ? undefined : back} footer={footer()}>
      <View key={state.step} style={styles.step}>
        {content()}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { gap: space.lg },
  block: { gap: space.lg },
  inline: { flexDirection: 'row' },
  centered: { alignItems: 'center' },
  list: { gap: space.md },
  ready: { gap: space.lg, paddingTop: space.xxxl },
  command: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: 14,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  agent: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
  },
  agentText: { flex: 1, gap: space.xs },
  mark: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: { fontFamily: font.display, fontSize: 30, letterSpacing: -0.8 },
  support: { fontFamily: font.body, fontSize: 15, lineHeight: 22.5 },
  codeInput: {
    fontFamily: font.mono,
    fontSize: 22,
    lineHeight: 30,
    letterSpacing: 4,
    textAlign: 'center',
  },
  doneAgent: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
