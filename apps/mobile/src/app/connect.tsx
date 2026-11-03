import type { Agent, AgentProtocol, Voice } from '@twring/contracts';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Share, StyleSheet, Text, View } from 'react-native';
import { Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useReducedMotion } from 'react-native-reanimated';

import {
  computerAgentRequest,
  computerReducer,
  connectCommand,
  createComputerWizard,
  onPhoneClock,
  pairingTimedOut,
  readyCopy,
  timeLeft,
  validateComputerStep,
  waitForClaim,
} from '@/agents/computer';
import { checkLabel, orderedChecks, testResultCopy } from '@/agents/labels';
import {
  createWizard,
  editWizard,
  ENDPOINT_EXAMPLES,
  isFirstStep,
  isLastStep,
  saveAndTest,
  stepPosition,
  textEntryFor,
  validateStep,
  wizardReducer,
  type WizardState,
} from '@/agents/wizard';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { startCall } from '@/call/start';
import { AgentMessage } from '@/components/AgentMessage';
import { Choice } from '@/components/Choice';
import { activeServerUrl } from '@/servers/active';
import { ErrorNotice } from '@/components/ErrorNotice';
import { LinkComputer } from '@/components/LinkComputer';
import { Field } from '@/components/Field';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Icon } from '@/components/Icon';
import { Waveform } from '@/components/Waveform';
import { goBack, Screen } from '@/components/Screen';
import { TextButton } from '@/components/TextButton';
import { space, type, usePalette } from '@/theme/tokens';
import { font } from '@/theme/fonts';

const METHODS: { protocol: AgentProtocol; label: string; description: string }[] = [
  {
    protocol: 'cord-native',
    label: 'Twring Native',
    description: 'Best for voice. Your agent speaks the Twring connection over a live socket.',
  },
  {
    protocol: 'cord-rest',
    label: 'API endpoint',
    description: 'Your agent answers web requests and streams its reply.',
  },
  {
    protocol: 'openai-chat',
    label: 'Any OpenAI-compatible agent',
    description: 'OpenClaw and other agent servers with a /v1/chat/completions endpoint',
  },
];

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

/** The connection test, told only from checks the server performed (UX_UI_SPEC §7). */
function TestStep({ state }: { state: WizardState }) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const { test } = state;
  return (
    <>
      <Heading>Connection test</Heading>
      {test.kind === 'running' || test.kind === 'idle' ? (
        <View accessibilityLiveRegion="polite" style={styles.running}>
          <Waveform
            color={palette.accent}
            intensity={0.4}
            width={220}
            height={64}
            animated={!reduceMotion}
          />
          <Text style={[type.body, { color: palette.textPrimary }]}>
            Checking your agent. This can take up to 20 seconds.
          </Text>
          <Text style={[type.caption, { color: palette.textSecondary }]}>Testing…</Text>
        </View>
      ) : test.kind === 'error' ? (
        <ErrorNotice error={test.copy} />
      ) : (
        <View accessibilityLiveRegion="polite" style={styles.checks}>
          {test.result.ok && (
            <View style={[styles.successMark, { backgroundColor: palette.accent }]}>
              <Icon name="check" size={22} color={palette.onAccent} strokeWidth={2.5} />
            </View>
          )}
          {test.result.ok && (
            <Text style={[type.bodyEmphasis, { color: palette.textPrimary }]}>Connected</Text>
          )}
          {orderedChecks(test.result.checks).map((check) => {
            const passed = check.status === 'passed';
            return (
              <View key={check.name} accessible style={styles.check}>
                <Text
                  style={[
                    type.bodyEmphasis,
                    styles.mark,
                    { color: passed ? palette.success : palette.danger },
                  ]}
                >
                  {passed ? '✓' : '✕'}
                </Text>
                <Text style={[type.body, { color: palette.textPrimary }]}>{checkLabel(check)}</Text>
              </View>
            );
          })}
          {test.result.ok ? (
            <Text style={[type.bodyEmphasis, { color: palette.textPrimary }]}>
              {testResultCopy(test.result)}
            </Text>
          ) : (
            <ErrorNotice error={{ message: testResultCopy(test.result), retryable: false }} />
          )}
        </View>
      )}
    </>
  );
}

function VoiceStep({
  voiceId,
  voices,
  error,
  onRetry,
  onSelect,
}: {
  voiceId: string | undefined;
  voices: Voice[] | undefined;
  error: ErrorCopy | undefined;
  onRetry: () => void;
  onSelect: (id: string) => void;
}) {
  const palette = usePalette();
  return (
    <>
      <Heading>Choose a voice</Heading>
      <Support>This is how your agent will sound on calls. You can change it later.</Support>
      {error !== undefined && <ErrorNotice error={error} onRetry={onRetry} />}
      {voices === undefined && error === undefined && (
        <ActivityIndicator accessibilityLabel="Loading voices" color={palette.textSecondary} />
      )}
      <View accessibilityRole="radiogroup" style={styles.choices}>
        {voices?.map((voice) => (
          <Choice
            key={voice.id}
            label={voice.label}
            selected={voiceId === voice.id}
            onPress={() => onSelect(voice.id)}
          />
        ))}
      </View>
    </>
  );
}

/** Connect Agent (UX_UI_SPEC §6). With `agentId`, edits that agent's connection instead. */
export default function ConnectScreen() {
  const params = useLocalSearchParams<{ agentId?: string; where?: string }>();
  const editId = typeof params.agentId === 'string' ? params.agentId : undefined;
  const [loadError, setLoadError] = useState<ErrorCopy | undefined>(undefined);
  const [loaded, setLoaded] = useState<Agent | undefined>(undefined);
  const [where, setWhere] = useState<
    'computer' | 'computer-scan' | 'computer-code' | 'online' | undefined
  >(params.where === 'computer' && editId === undefined ? 'computer' : undefined);

  useEffect(() => {
    if (editId === undefined) return;
    const api = twringApi();
    const controller = new AbortController();
    api?.getAgent(editId, controller.signal).then(setLoaded, (reason: unknown) => {
      if (!controller.signal.aborted) setLoadError(apiErrorCopy(reason));
    });
    return () => controller.abort();
  }, [editId]);

  if (editId !== undefined && loaded === undefined) {
    return (
      <Screen back>
        {loadError !== undefined ? (
          <ErrorNotice error={loadError} />
        ) : (
          <ActivityIndicator accessibilityLabel="Loading agent" />
        )}
      </Screen>
    );
  }
  if (loaded !== undefined) return <Wizard initial={editWizard(loaded)} />;
  if (where === undefined) return <WhereStep onChoose={setWhere} />;
  switch (where) {
    case 'computer':
      // The agent sets itself up from a message (ADR-027); scanning (ADR-025) and the older
      // show-a-code flow stay one tap away.
      return (
        <AgentMessage
          onScan={() => setWhere('computer-scan')}
          onOtherWays={() => setWhere('computer-code')}
        />
      );
    case 'computer-scan':
      return <LinkComputer onOtherWays={() => setWhere('computer-code')} />;
    case 'computer-code':
      return <ComputerWizard />;
    case 'online':
      return <Wizard initial={createWizard()} />;
  }
}

/** Where the agent runs (ADR-023): on the user's computer via cord-connect, or at a web address. */
function WhereStep({ onChoose }: { onChoose: (where: 'computer' | 'online') => void }) {
  const [where, setWhere] = useState<'computer' | 'online'>('computer');
  return (
    <Screen back footer={<PrimaryButton label="Continue" onPress={() => onChoose(where)} />}>
      <View style={styles.step}>
        <Heading>Where does your agent run?</Heading>
        <View accessibilityRole="radiogroup" style={styles.choices}>
          <HeroChoice
            label="On my computer or server"
            description="Hermes, Claude Code, Codex, Gemini CLI, or another agent you run yourself."
            icon="computer"
            recommended
            selected={where === 'computer'}
            onPress={() => setWhere('computer')}
          />
          <HeroChoice
            label="Online (web address)"
            description="Your agent has its own https:// or wss:// address."
            icon="globe"
            selected={where === 'online'}
            onPress={() => setWhere('online')}
          />
        </View>
      </View>
    </Screen>
  );
}

function HeroChoice({
  label,
  description,
  icon,
  recommended,
  selected,
  onPress,
}: {
  label: string;
  description: string;
  icon: 'computer' | 'globe';
  recommended?: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${label}. ${description}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.hero,
        {
          borderColor: selected ? palette.borderAccent : palette.border,
          backgroundColor: selected ? 'transparent' : 'rgba(255,255,255,0.025)',
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      {selected && (
        <LinearGradient
          colors={['rgba(25,214,242,0.08)', 'rgba(25,214,242,0.01)']}
          style={StyleSheet.absoluteFill}
        />
      )}
      <View style={[styles.heroIcon, { borderColor: palette.borderAccent }]}>
        <Icon name={icon} size={20} color={palette.accent} />
      </View>
      <View style={styles.heroText}>
        <Text style={[styles.heroTitle, { color: palette.textPrimary }]}>{label}</Text>
        {recommended && (
          <Text
            style={[styles.badge, { color: palette.accent, borderColor: palette.borderAccent }]}
          >
            RECOMMENDED
          </Text>
        )}
        <Text style={[type.caption, styles.heroDescription, { color: palette.textSecondary }]}>
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

/** "On my computer": pair with cord-connect, pick an agent, name it, choose a voice. */
function ComputerWizard() {
  const palette = usePalette();
  const api = twringApi();
  const [state, dispatch] = useReducer(computerReducer, undefined, createComputerWizard);
  const [showErrors, setShowErrors] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [voices, setVoices] = useState<Voice[] | undefined>(undefined);
  const [voiceError, setVoiceError] = useState<ErrorCopy | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorCopy | undefined>(undefined);
  const server = activeServerUrl();
  const error = showErrors ? validateComputerStep(state) : undefined;

  // A fresh code whenever one is needed.
  useEffect(() => {
    if (api === undefined || state.pairing.kind !== 'loading') return;
    const controller = new AbortController();
    api.createPairing(controller.signal).then(
      (pairing) =>
        dispatch({ type: 'PAIRING_CREATED', pairing: onPhoneClock(pairing, Date.now()) }),
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'PAIRING_FAILED', copy: apiErrorCopy(reason) });
        }
      },
    );
    return () => controller.abort();
  }, [api, state.pairing.kind]);

  // Wait for the computer to claim the code.
  const waiting = state.pairing.kind === 'waiting' ? state.pairing.pairing : undefined;
  useEffect(() => {
    if (api === undefined || waiting === undefined || state.connector !== undefined) return;
    const controller = new AbortController();
    waitForClaim(api, waiting.pairing_id, controller.signal).then(
      (status) => {
        if (status.status === 'claimed' && status.connector !== undefined) {
          dispatch({ type: 'CLAIMED', connector: status.connector });
        } else {
          dispatch({ type: 'PAIRING_EXPIRED' });
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [api, waiting, state.connector]);

  // The countdown.
  useEffect(() => {
    if (waiting === undefined || state.connector !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting, state.connector]);
  const left = waiting === undefined ? undefined : timeLeft(waiting.expires_at, now);
  // The poll decides (a claim right at expiry still wins); the phone gives up on its own only
  // when the server stays silent past the grace.
  const timedOut = waiting !== undefined && pairingTimedOut(waiting.expires_at, now);
  useEffect(() => {
    if (timedOut) dispatch({ type: 'PAIRING_EXPIRED' });
  }, [timedOut]);

  function loadVoices() {
    if (api === undefined) return;
    setVoiceError(undefined);
    api.listVoices().then(
      (list) => {
        setVoices(list.voices);
        if (state.voiceId === undefined) {
          dispatch({ type: 'SET_VOICE', value: list.default_voice_id });
        }
      },
      (reason: unknown) => setVoiceError(apiErrorCopy(reason)),
    );
  }

  async function next() {
    if (validateComputerStep(state) !== undefined) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (state.step === 'voice') {
      const request = computerAgentRequest(state);
      if (api === undefined || request === undefined) return;
      setSaving(true);
      setSaveError(undefined);
      try {
        const agent = await api.createAgent(request);
        dispatch({
          type: 'SAVED',
          agentId: agent.id,
          name: agent.name,
          ...(agent.relinked === true && { relinked: true }),
        });
      } catch (reason) {
        setSaveError(apiErrorCopy(reason));
      } finally {
        setSaving(false);
      }
      return;
    }
    if (state.step === 'name' && voices === undefined) loadVoices();
    dispatch({ type: 'NEXT' });
  }

  function back() {
    if (state.step === 'pair' || state.step === 'agent' || state.step === 'ready') {
      goBack();
      return;
    }
    setShowErrors(false);
    dispatch({ type: 'BACK' });
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => subscription.remove();
  });

  function content() {
    switch (state.step) {
      case 'pair': {
        const pairing = state.pairing;
        const command =
          pairing.kind === 'waiting' ? connectCommand(pairing.pairing.code, server) : '';
        return (
          <>
            <Heading>Connect your computer</Heading>
            <Support>
              On the computer where your agent runs, open a terminal in your project folder and run
              this command. It needs Node.js.
            </Support>
            {pairing.kind === 'loading' && (
              <ActivityIndicator accessibilityLabel="Getting a code" />
            )}
            {pairing.kind === 'error' && (
              <ErrorNotice
                error={pairing.copy}
                onRetry={() => dispatch({ type: 'PAIRING_STARTED' })}
              />
            )}
            {pairing.kind === 'expired' && (
              <Support>That code expired. Get a new one and run the new command.</Support>
            )}
            {pairing.kind === 'waiting' && (
              <>
                <Text
                  selectable
                  style={[
                    type.bodyEmphasis,
                    styles.command,
                    { color: palette.textPrimary, borderColor: palette.border },
                  ]}
                >
                  {command}
                </Text>
                <View style={styles.inline}>
                  <TextButton
                    label="Copy or share the command"
                    onPress={() => void Share.share({ message: command })}
                  />
                </View>
                <View accessibilityLiveRegion="polite" style={styles.running}>
                  <ActivityIndicator color={palette.textSecondary} />
                  <Text style={[type.body, { color: palette.textSecondary }]}>
                    {`Waiting for your computer. The code works for ${left ?? '0:00'}.`}
                  </Text>
                </View>
              </>
            )}
          </>
        );
      }
      case 'agent':
        return (
          <>
            <Heading>{`Connected to ${state.connector?.name ?? 'your computer'}`}</Heading>
            <Support>Which agent do you want to call?</Support>
            {error !== undefined && <ErrorNotice error={{ message: error, retryable: false }} />}
            <View accessibilityRole="radiogroup" style={styles.choices}>
              {state.connector?.agents.map((agent) => (
                <Choice
                  key={agent.id}
                  label={agent.label}
                  selected={state.localAgent?.id === agent.id}
                  onPress={() => dispatch({ type: 'PICK_AGENT', agent })}
                />
              ))}
            </View>
          </>
        );
      case 'name':
        return (
          <>
            <Heading>Name your agent</Heading>
            <Support>This is the name you&apos;ll see when you call it.</Support>
            <Field
              label="Agent name"
              value={state.name}
              autoCapitalize="words"
              autoFocus
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => void next()}
              error={error}
              onChangeText={(value) => dispatch({ type: 'SET_NAME', value })}
            />
          </>
        );
      case 'voice':
        return (
          <>
            <VoiceStep
              voiceId={state.voiceId}
              voices={voices}
              error={voiceError}
              onRetry={loadVoices}
              onSelect={(value) => dispatch({ type: 'SET_VOICE', value })}
            />
            {saveError !== undefined && <ErrorNotice error={saveError} />}
          </>
        );
      case 'ready':
        return (
          <View style={styles.ready}>
            <Heading>{readyCopy(state).heading}</Heading>
            <Support>{readyCopy(state).support}</Support>
          </View>
        );
    }
  }

  function footer() {
    switch (state.step) {
      case 'pair':
        return state.pairing.kind === 'expired' ? (
          <PrimaryButton
            label="Get a new code"
            onPress={() => dispatch({ type: 'PAIRING_STARTED' })}
          />
        ) : undefined;
      case 'ready':
        return (
          <>
            <PrimaryButton
              label="Call now"
              onPress={() => {
                if (state.agentId === undefined) return;
                router.replace({ pathname: '/agents/[id]', params: { id: state.agentId } });
                startCall({ agentId: state.agentId, name: state.name.trim() });
              }}
            />
            <PrimaryButton label="Later" tone="neutral" onPress={() => router.replace('/')} />
          </>
        );
      case 'agent':
      case 'name':
      case 'voice':
        return (
          <PrimaryButton
            label={state.step === 'voice' ? 'Save' : 'Continue'}
            disabled={saving || (state.step === 'voice' && voices === undefined)}
            onPress={() => void next()}
          />
        );
    }
  }

  return (
    <Screen back={state.step === 'ready' ? undefined : back} footer={footer()}>
      <View key={state.step} style={styles.step}>
        {content()}
      </View>
    </Screen>
  );
}

function Wizard({ initial }: { initial: WizardState }) {
  const palette = usePalette();
  const [state, dispatch] = useReducer(wizardReducer, initial);
  const [showErrors, setShowErrors] = useState(false);
  const [voices, setVoices] = useState<Voice[] | undefined>(undefined);
  const [voiceError, setVoiceError] = useState<ErrorCopy | undefined>(undefined);
  const [savingVoice, setSavingVoice] = useState(false);
  const [voiceSaveError, setVoiceSaveError] = useState<ErrorCopy | undefined>(undefined);
  const inflight = useRef<AbortController | undefined>(undefined);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Leaving the wizard cancels any save or test in flight.
  useEffect(() => () => inflight.current?.abort(), []);

  const api = twringApi();
  const error = showErrors ? validateStep(state) : undefined;
  const { index, total } = stepPosition(state);

  function runTest(current: WizardState) {
    if (api === undefined) return;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    dispatch({ type: 'TEST_STARTED' });
    saveAndTest(
      api,
      current,
      (agent) => dispatch({ type: 'SAVED', agent }),
      controller.signal,
    ).then(
      ({ agent, result }) => {
        if (!controller.signal.aborted) dispatch({ type: 'TEST_FINISHED', agent, result });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'TEST_FAILED', copy: apiErrorCopy(reason) });
        }
      },
    );
  }

  function loadVoices() {
    if (api === undefined) return;
    setVoiceError(undefined);
    api.listVoices().then(
      (list) => {
        setVoices(list.voices);
        if (stateRef.current.voiceId === undefined) {
          dispatch({ type: 'SET_VOICE', value: list.default_voice_id });
        }
      },
      (reason: unknown) => setVoiceError(apiErrorCopy(reason)),
    );
  }

  function back() {
    if (state.test.kind === 'running') inflight.current?.abort();
    if (isFirstStep(state) || state.step === 'ready') {
      goBack();
      return;
    }
    setShowErrors(false);
    dispatch({ type: 'BACK' });
  }

  // Android back steps back through the wizard instead of dropping it.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => subscription.remove();
  });

  async function next() {
    if (validateStep(state) !== undefined) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (state.step === 'test' && isLastStep(state)) {
      // Editing ends at a passing test.
      goBack();
      return;
    }
    if (state.step === 'voice' && state.agentId !== undefined && state.voiceId !== undefined) {
      setSavingVoice(true);
      setVoiceSaveError(undefined);
      try {
        await api?.updateAgent(state.agentId, { voice_id: state.voiceId });
      } catch (reason) {
        setVoiceSaveError(apiErrorCopy(reason));
        return;
      } finally {
        setSavingVoice(false);
      }
    }
    dispatch({ type: 'NEXT' });
    if (state.step === 'credential' && state.protocol !== 'openai-chat')
      runTest({ ...state, step: 'test' });
    if (state.step === 'model') runTest({ ...state, step: 'test' });
    if (state.step === 'test' && voices === undefined) loadVoices();
  }

  // Every text step focuses its field on arrival; return runs the step's primary action and
  // keeps the keyboard up so the next step's field can take focus without it bouncing.
  const textEntry = textEntryFor(state.step);
  const entry = {
    autoFocus: textEntry !== undefined,
    returnKeyType: textEntry?.returnKeyType,
    submitBehavior: 'submit' as const,
    onSubmitEditing: () => void next(),
  };

  function content() {
    switch (state.step) {
      case 'name':
        return (
          <>
            <Heading>Name your agent</Heading>
            <Support>This is the name you&apos;ll see when you call it.</Support>
            <Field
              label="Agent name"
              value={state.name}
              placeholder="Operator"
              autoCapitalize="words"
              error={error}
              onChangeText={(value) => dispatch({ type: 'SET_NAME', value })}
              {...entry}
            />
          </>
        );
      case 'method':
        return (
          <>
            <Heading>How does Twring reach it?</Heading>
            <Support>Pick what your agent supports. Its docs or builder will say.</Support>
            <View accessibilityRole="radiogroup" style={styles.choices}>
              {METHODS.map((method) => (
                <Choice
                  key={method.protocol}
                  label={method.label}
                  description={method.description}
                  example={ENDPOINT_EXAMPLES[method.protocol]}
                  selected={state.protocol === method.protocol}
                  onPress={() => dispatch({ type: 'SET_PROTOCOL', value: method.protocol })}
                />
              ))}
            </View>
          </>
        );
      case 'endpoint':
        return (
          <>
            <Heading>Agent address</Heading>
            <Support>The web address your agent listens on.</Support>
            <Field
              label="Endpoint"
              value={state.endpoint}
              placeholder={ENDPOINT_EXAMPLES[state.protocol]}
              hint={`For example: ${ENDPOINT_EXAMPLES[state.protocol]}`}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              error={error}
              onChangeText={(value) => dispatch({ type: 'SET_ENDPOINT', value })}
              {...entry}
            />
          </>
        );
      case 'credential':
        return (
          <>
            <Heading>API key</Heading>
            <Support>
              {state.hasSavedCredential
                ? 'A key is saved. Leave this blank to keep it, or enter a new one to replace it.'
                : "Leave blank if your agent doesn't need a key."}
            </Support>
            <Field
              label="API key (optional)"
              value={state.credential}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              hint="Twring stores it encrypted on its server and never shows it again."
              error={error}
              onChangeText={(value) => dispatch({ type: 'SET_CREDENTIAL', value })}
              {...entry}
            />
            {state.hasSavedCredential && (
              <View style={styles.inline}>
                <TextButton
                  label={state.removeCredential ? 'Keep the saved key' : 'Remove the saved key'}
                  tone={state.removeCredential ? 'accent' : 'danger'}
                  onPress={() =>
                    dispatch({ type: 'SET_REMOVE_CREDENTIAL', value: !state.removeCredential })
                  }
                />
              </View>
            )}
            {state.removeCredential && (
              <Text style={[type.caption, { color: palette.textSecondary }]}>
                The saved key will be removed when you continue.
              </Text>
            )}
          </>
        );
      case 'model':
        return (
          <>
            <Heading>Model</Heading>
            <Field
              label="Model (optional)"
              value={state.model}
              hint="Leave empty unless your agent server asks for one, for example openclaw:main"
              autoCapitalize="none"
              autoCorrect={false}
              error={error}
              onChangeText={(value) => dispatch({ type: 'SET_MODEL', value })}
              {...entry}
            />
          </>
        );
      case 'test':
        return <TestStep state={state} />;
      case 'voice':
        return (
          <>
            <VoiceStep
              voiceId={state.voiceId}
              voices={voices}
              error={voiceError}
              onRetry={loadVoices}
              onSelect={(value) => dispatch({ type: 'SET_VOICE', value })}
            />
            {voiceSaveError !== undefined && <ErrorNotice error={voiceSaveError} />}
          </>
        );
      case 'ready':
        return (
          <View style={styles.ready}>
            <Heading>{`${state.name.trim()} is ready`}</Heading>
            <Support>Your agent is ready to call.</Support>
          </View>
        );
    }
  }

  function footer() {
    const test = state.test;
    switch (state.step) {
      case 'test':
        if (test.kind === 'running' || test.kind === 'idle') {
          return <PrimaryButton label="Testing…" disabled onPress={() => undefined} />;
        }
        if (test.kind === 'finished' && test.result.ok) {
          return (
            <PrimaryButton
              label={isLastStep(state) ? 'Done' : 'Continue'}
              onPress={() => void next()}
            />
          );
        }
        return (
          <>
            <PrimaryButton label="Try again" onPress={() => runTest(state)} />
            <PrimaryButton label="Edit connection" tone="neutral" onPress={back} />
          </>
        );
      case 'ready':
        return (
          <>
            <PrimaryButton
              label="Call now"
              onPress={() => {
                if (state.agentId === undefined) return;
                const target = { agentId: state.agentId, name: state.name.trim() };
                router.replace({ pathname: '/agents/[id]', params: { id: state.agentId } });
                startCall(target);
              }}
            />
            <PrimaryButton label="Later" tone="neutral" onPress={() => router.replace('/')} />
          </>
        );
      case 'name':
      case 'method':
      case 'endpoint':
      case 'credential':
      case 'model':
      case 'voice':
        return (
          <PrimaryButton
            label={
              state.step === 'model' ||
              (state.step === 'credential' && state.protocol !== 'openai-chat')
                ? 'Save and test'
                : 'Continue'
            }
            disabled={savingVoice || (state.step === 'voice' && voices === undefined)}
            onPress={() => void next()}
          />
        );
    }
  }

  return (
    <Screen
      back={state.step === 'ready' ? undefined : back}
      headerRight={
        <View style={styles.position}>
          <View accessible={false} style={styles.stepDots}>
            {Array.from({ length: total }, (_, dot) => (
              <View
                key={dot}
                style={[
                  styles.stepDot,
                  dot + 1 === index
                    ? {
                        width: 28,
                        backgroundColor: palette.accent,
                        boxShadow: '0 0 9px rgba(25,214,242,0.65)',
                      }
                    : { width: 8, backgroundColor: 'rgba(255,255,255,0.2)' },
                ]}
              />
            ))}
          </View>
          <Text
            accessibilityLabel={`Step ${index} of ${total}`}
            style={[type.caption, { color: palette.textSecondary }]}
          >{`${index} / ${total}`}</Text>
        </View>
      }
      footer={footer()}
    >
      {/* Keyed by step so each step's field mounts fresh and its autoFocus fires. */}
      <View key={state.step} style={styles.step}>
        {content()}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { gap: space.lg },
  choices: { gap: space.md },
  running: { alignItems: 'center', gap: space.md },
  checks: { gap: space.md },
  check: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  mark: { minWidth: 20, textAlign: 'center' },
  inline: { flexDirection: 'row' },
  ready: { gap: space.lg, paddingTop: space.xxxl },
  position: { paddingHorizontal: space.sm, alignItems: 'flex-end', gap: 6 },
  command: { borderWidth: 1, borderRadius: 8, padding: space.md },
  heading: { fontFamily: font.display, fontSize: 30, letterSpacing: -0.8 },
  support: { fontFamily: font.body, fontSize: 15, lineHeight: 22.5 },
  stepDots: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stepDot: { height: 3, borderRadius: 2 },
  hero: {
    minHeight: 104,
    flexDirection: 'row',
    gap: 14,
    borderRadius: 22,
    borderWidth: 1,
    padding: 18,
    overflow: 'hidden',
  },
  heroIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: 'rgba(25,214,242,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: { flex: 1, gap: 6 },
  heroTitle: { fontFamily: font.title, fontSize: 20, letterSpacing: -0.3 },
  badge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontFamily: font.microLabel,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  heroDescription: { lineHeight: 19.5 },
  successMark: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
