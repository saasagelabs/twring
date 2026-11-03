import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Choice } from '@/components/Choice';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { Sheet } from '@/components/Sheet';
import { StatusDot } from '@/components/StatusDot';
import { TextButton } from '@/components/TextButton';
import { Toggle } from '@/components/Toggle';
import { ringPlatform, type RingPermissions } from '@/platform/ring';
import type { RingSettings as Settings } from '@/ring/protocol';
import {
  deviceTimeZone,
  formFromSettings,
  persistRingSettings,
  ringSummary,
  settingsFromForm,
  type RingSettingsForm,
} from '@/ring/settings';
import { font } from '@/theme/fonts';
import { radius, space, type, usePalette } from '@/theme/tokens';

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; settings: Settings }
  | { state: 'failed'; error: ErrorCopy };

/** Whether this phone can ring right now, and what to fix when it cannot. */
function usePermissions(): RingPermissions {
  const [permissions, setPermissions] = useState(() => ringPlatform.permissions());
  useEffect(() => {
    // Coming back from system settings re-reads them.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setPermissions(ringPlatform.permissions());
    });
    return () => subscription.remove();
  }, []);
  return permissions;
}

function LabeledSwitch({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const palette = usePalette();
  return (
    <View
      accessible
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={() => {
        if (!disabled) onChange(!value);
      }}
      style={[styles.switchRow, { borderColor: palette.border }]}
    >
      <View style={styles.flex}>
        <Text style={[type.body, { color: palette.textPrimary }]}>{label}</Text>
        <Text style={[type.caption, { color: palette.textSecondary }]}>{hint}</Text>
      </View>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Toggle
          accessibilityLabel={label}
          value={value}
          disabled={disabled}
          onValueChange={onChange}
        />
      </View>
    </View>
  );
}

/** Settings → Incoming calls: can agents ring me, Do not disturb, and quiet hours. */
export function RingSettings({
  footer,
  chatsAvailable = false,
}: {
  footer?: ReactNode;
  chatsAvailable?: boolean;
}) {
  const palette = usePalette();
  const permissions = usePermissions();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [form, setForm] = useState<RingSettingsForm | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ error: ErrorCopy; next: RingSettingsForm }>();
  const [resultSheet, setResultSheet] = useState(false);
  const [invalid, setInvalid] = useState<'start' | 'end' | undefined>(undefined);

  // Fetches settings; the initial state is already 'loading', so the effect sets no state itself.
  function fetchSettings() {
    const api = twringApi();
    if (api === undefined) return () => undefined;
    const controller = new AbortController();
    api.ringSettings(controller.signal).then(
      (settings) => {
        setLoad({ state: 'loaded', settings });
        setForm(formFromSettings(settings));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoad({ state: 'failed', error: apiErrorCopy(error) });
      },
    );
    return () => controller.abort();
  }
  useEffect(fetchSettings, []);
  function reload() {
    setLoad({ state: 'loading' });
    fetchSettings();
  }

  if (!ringPlatform.supported && !chatsAvailable)
    return footer === undefined ? null : <SettingsGroup title="Calls">{footer}</SettingsGroup>;

  function save(next: RingSettingsForm) {
    const api = twringApi();
    if (api === undefined) return;
    setForm(next);
    const previous = load.state === 'loaded' ? load.settings : undefined;
    const check = settingsFromForm(next, deviceTimeZone(), previous, chatsAvailable);
    if (!check.ok) {
      setInvalid(check.field);
      return;
    }
    setInvalid(undefined);
    setSaving(true);
    setSaveError(undefined);
    void persistRingSettings(check.settings, previous ?? check.settings, (request) =>
      api.updateRingSettings(request),
    ).then((result) => {
      setSaving(false);
      setForm(result.form);
      if (result.ok) setLoad({ state: 'loaded', settings: result.settings });
      else setSaveError({ error: apiErrorCopy(result.error), next });
    });
  }

  const ready = permissions.notifications && permissions.fullScreen && permissions.channel;
  const inputStyle = (field: 'start' | 'end') => [
    type.body,
    styles.time,
    {
      color: palette.textPrimary,
      backgroundColor: palette.surface,
      borderColor: invalid === field ? palette.danger : palette.border,
    },
  ];

  return (
    <SettingsGroup title="Calls">
      {ringPlatform.supported && (
        <View accessible style={[styles.readiness, { borderColor: palette.border }]}>
          <StatusDot color={ready ? palette.accent : palette.warning} />
          <View style={styles.flex}>
            <Text style={[type.body, { color: palette.textPrimary }]}>Let agents ring me</Text>
            <Text style={[type.caption, { color: ready ? palette.accent : palette.warning }]}>
              {ready
                ? 'Ready. Your agents can ring this phone, even when it is locked.'
                : 'Not ready yet. Fix the items below so you hear your agents call.'}
            </Text>
          </View>
        </View>
      )}
      {ringPlatform.supported && !permissions.notifications && (
        <SettingsRow
          label="Notifications are off"
          value="Turn them on, or agents' calls cannot ring."
          accessibilityHint="Asks for permission or opens system settings"
          onPress={() => {
            void ringPlatform.requestNotifications().then((granted) => {
              if (!granted) ringPlatform.openNotificationSettings();
            });
          }}
        />
      )}
      {ringPlatform.supported && permissions.notifications && !permissions.channel && (
        <SettingsRow
          label="“Incoming agent calls” is muted"
          value="Turn that notification category back on."
          accessibilityHint="Opens system notification settings"
          onPress={() => ringPlatform.openNotificationSettings()}
        />
      )}
      {ringPlatform.supported && !permissions.fullScreen && (
        <SettingsRow
          label="Full-screen calls are off"
          value="Allow full-screen notifications so a call shows over the lock screen."
          accessibilityHint="Opens system settings"
          onPress={() => ringPlatform.openFullScreenIntentSettings()}
        />
      )}

      {load.state === 'loading' && (
        <ActivityIndicator
          accessibilityLabel="Loading call settings"
          color={palette.textSecondary}
        />
      )}
      {load.state === 'failed' && <ErrorNotice error={load.error} onRetry={reload} />}
      {load.state === 'loaded' && form !== undefined && (
        <>
          {ringPlatform.supported && (
            <Text style={[type.caption, styles.summary, { color: palette.textSecondary }]}>
              {ringSummary(load.settings)}
            </Text>
          )}
          {chatsAvailable && ringPlatform.supported && (
            <>
              <SettingsRow
                label="When work finishes after a call"
                value={form.afterCallResult === 'message' ? 'Send a message' : 'Ring me'}
                onPress={saving ? undefined : () => setResultSheet(true)}
              />
              <Text style={[type.caption, styles.explainer, { color: palette.textSecondary }]}>
                Your agent's answer is always saved in the chat.
              </Text>
              <Sheet
                visible={resultSheet}
                title="When work finishes after a call"
                onClose={() => setResultSheet(false)}
              >
                <View style={styles.choices}>
                  <Choice
                    label="Ring me"
                    selected={form.afterCallResult === 'ring'}
                    onPress={() => {
                      setResultSheet(false);
                      if (form.afterCallResult !== 'ring')
                        save({ ...form, afterCallResult: 'ring' });
                    }}
                  />
                  <Choice
                    label="Send a message"
                    selected={form.afterCallResult === 'message'}
                    onPress={() => {
                      setResultSheet(false);
                      if (form.afterCallResult !== 'message')
                        save({ ...form, afterCallResult: 'message' });
                    }}
                  />
                  <Text style={[type.caption, { color: palette.textSecondary }]}>
                    Your agent's answer is always saved in the chat.
                  </Text>
                </View>
              </Sheet>
            </>
          )}
          {chatsAvailable && !ringPlatform.supported && (
            <Text style={[type.caption, styles.explainer, { color: palette.textSecondary }]}>
              Agents can't ring this phone. Their answers are saved in the chat.
            </Text>
          )}
          {ringPlatform.supported && (
            <LabeledSwitch
              label="Do not disturb"
              hint="Agents cannot ring you. You can still call them."
              value={form.dnd}
              disabled={saving}
              onChange={(dnd) => save({ ...form, dnd })}
            />
          )}
          {ringPlatform.supported && (
            <LabeledSwitch
              label="Quiet hours"
              hint={`No rings between these times (${deviceTimeZone()}).`}
              value={form.quietEnabled}
              disabled={saving}
              onChange={(quietEnabled) => save({ ...form, quietEnabled })}
            />
          )}
          {ringPlatform.supported && form.quietEnabled && (
            <View style={styles.times}>
              <TextInput
                accessibilityLabel="Quiet hours start, 24-hour time"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                value={form.start}
                onChangeText={(start) => setForm({ ...form, start })}
                onEndEditing={() => save(form)}
                style={inputStyle('start')}
              />
              <Text style={[type.body, { color: palette.textSecondary }]}>to</Text>
              <TextInput
                accessibilityLabel="Quiet hours end, 24-hour time"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                value={form.end}
                onChangeText={(end) => setForm({ ...form, end })}
                onEndEditing={() => save(form)}
                style={inputStyle('end')}
              />
              <TextButton label="Save" onPress={() => save(form)} />
            </View>
          )}
          {invalid !== undefined && (
            <Text accessibilityRole="alert" style={[type.caption, { color: palette.danger }]}>
              Use 24-hour time, like 22:00 or 07:30.
            </Text>
          )}
          {saving && (
            <ActivityIndicator accessibilityLabel="Saving" color={palette.textSecondary} />
          )}
          {saveError !== undefined && (
            <ErrorNotice error={saveError.error} onRetry={() => save(saveError.next)} />
          )}
        </>
      )}
      {footer}
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  readiness: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  summary: { paddingHorizontal: 14, paddingTop: 12 },
  explainer: { paddingHorizontal: 14, paddingVertical: 8 },
  choices: { gap: space.md },
  flex: { flex: 1, gap: space.xs },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  times: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  time: {
    minWidth: 84,
    minHeight: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: space.md,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    fontFamily: font.mono,
  },
});
