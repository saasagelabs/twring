import type { ConnectedApp } from '@twring/contracts';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth';
import { connectedAppsState, type AppGroup } from '@/agents/connected-apps';
import { formatWhen } from '@/agents/labels';
import { removeAiAppCopy } from '@/agents/ai-app';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Screen } from '@/components/Screen';
import { SettingsGroup } from '@/components/SettingsGroup';
import { Sheet } from '@/components/Sheet';
import { TextButton } from '@/components/TextButton';
import { useNow } from '@/hooks/useNow';
import { useResource } from '@/hooks/useResource';
import { space, type, usePalette } from '@/theme/tokens';

export default function ConnectedAppsScreen() {
  const palette = usePalette();
  const auth = useAuth();
  const now = useNow();
  const load = useCallback((signal: AbortSignal): Promise<ConnectedApp[]> => {
    const api = twringApi();
    return api ? api.listConnectedApps(signal) : Promise.reject(new Error('Not configured'));
  }, []);
  const apps = useResource(load);
  const [removing, setRemoving] = useState<AppGroup>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCopy>();
  const state = connectedAppsState(apps.data ?? []);
  const email = auth.status === 'signed_in' ? auth.email : undefined;

  async function update(app: AppGroup, action: 'block' | 'allow') {
    const api = twringApi();
    if (!api) return;
    setBusy(true);
    setError(undefined);
    try {
      // One row can stand for several connections of the same app: act on all of them.
      for (const clientId of app.clientIds) {
        if (action === 'block') await api.blockConnectedApp(clientId);
        else await api.allowConnectedApp(clientId);
      }
      setRemoving(undefined);
    } catch (reason) {
      setError(apiErrorCopy(reason));
    } finally {
      setBusy(false);
      apps.reload();
    }
  }

  const loaded = !apps.loading && !apps.error;
  return (
    <Screen
      back
      title="Connected AI apps"
      refreshing={apps.refreshing}
      onRefresh={() => apps.reload({ refresh: true })}
    >
      <Text style={[type.body, { color: palette.textSecondary }]}>
        {email !== undefined
          ? `AI apps that can ring and message you as ${email}.`
          : 'AI apps that can ring and message you.'}
      </Text>
      {apps.loading && (
        <ActivityIndicator accessibilityLabel="Loading connected AI apps" color={palette.accent} />
      )}
      {apps.error && <ErrorNotice error={apps.error} onRetry={() => apps.reload()} />}
      {error && <ErrorNotice error={error} />}
      {loaded && state.connected.length === 0 && (
        <View style={{ gap: space.md }}>
          <Text style={[type.body, { color: palette.textSecondary }]}>
            {state.empty
              ? 'No AI apps yet. Add Twring in Claude, ChatGPT or another AI app.'
              : 'No AI apps connected right now. Add Twring in Claude, ChatGPT or another AI app, or allow a removed one again below.'}
          </Text>
          <GhostButton
            label="See how"
            onPress={() =>
              void Linking.openURL('https://twring.com/connector').catch((reason: unknown) =>
                setError(apiErrorCopy(reason)),
              )
            }
          />
        </View>
      )}
      {loaded && state.connected.length > 0 && (
        <SettingsGroup title="Connected">
          {state.connected.map((app, index) => (
            <AppRow
              key={app.key}
              name={app.name}
              detail={
                app.lastUsedAt !== undefined
                  ? `Last used ${formatWhen(app.lastUsedAt, now)}`
                  : 'Not used yet'
              }
              action="Remove"
              tone="danger"
              disabled={busy}
              divider={index < state.connected.length - 1}
              onPress={() => setRemoving(app)}
            />
          ))}
        </SettingsGroup>
      )}
      {loaded && state.removed.length > 0 && (
        <SettingsGroup title="Removed">
          {state.removed.map((app, index) => (
            <AppRow
              key={app.key}
              name={app.name}
              detail="Can't ring or message you"
              action="Allow again"
              tone="accent"
              disabled={busy}
              divider={index < state.removed.length - 1}
              onPress={() => void update(app, 'allow')}
            />
          ))}
        </SettingsGroup>
      )}
      <Sheet
        visible={removing !== undefined}
        title="Remove AI app"
        onClose={() => {
          if (!busy) setRemoving(undefined);
        }}
      >
        <View style={{ gap: space.md }}>
          {removing && (
            <Text style={[type.body, { color: palette.textSecondary }]}>
              {removeAiAppCopy(removing.name)}
            </Text>
          )}
          <GhostButton
            label="Remove"
            tone="danger"
            disabled={busy}
            onPress={() => {
              if (removing) void update(removing, 'block');
            }}
          />
          <GhostButton label="Cancel" disabled={busy} onPress={() => setRemoving(undefined)} />
        </View>
      </Sheet>
    </Screen>
  );
}

/** An app's name and one line about it, with its one action on the right. */
function AppRow({
  name,
  detail,
  action,
  tone,
  disabled,
  divider,
  onPress,
}: {
  name: string;
  detail: string;
  action: string;
  tone: 'accent' | 'danger';
  disabled: boolean;
  divider: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <View
      style={[
        styles.row,
        {
          borderColor: palette.border,
          borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0,
        },
      ]}
    >
      <View accessible style={styles.text}>
        <Text style={[type.body, { color: palette.textPrimary }]}>{name}</Text>
        <Text style={[type.caption, { color: palette.textTertiary }]}>{detail}</Text>
      </View>
      <TextButton
        label={action}
        tone={tone}
        disabled={disabled}
        accessibilityLabel={`${action}, ${name}`}
        onPress={onPress}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingLeft: 14,
    paddingRight: space.xs,
  },
  text: { flex: 1, gap: 2 },
});
