import type { ConnectedApp } from '@twring/contracts';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';

import { connectedAppsState } from '@/agents/connected-apps';
import { formatWhen } from '@/agents/labels';
import { removeAiAppCopy } from '@/agents/ai-app';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { useNow } from '@/hooks/useNow';
import { useResource } from '@/hooks/useResource';
import { space, type, usePalette, radius } from '@/theme/tokens';

export default function ConnectedAppsScreen() {
  const palette = usePalette();
  const now = useNow();
  const load = useCallback((signal: AbortSignal): Promise<ConnectedApp[]> => {
    const api = twringApi();
    return api ? api.listConnectedApps(signal) : Promise.reject(new Error('Not configured'));
  }, []);
  const apps = useResource(load);
  const [removing, setRemoving] = useState<ConnectedApp>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCopy>();
  const state = connectedAppsState(apps.data ?? []);

  async function update(app: ConnectedApp, action: 'block' | 'allow') {
    const api = twringApi();
    if (!api) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'block') await api.blockConnectedApp(app.client_id);
      else await api.allowConnectedApp(app.client_id);
      setRemoving(undefined);
      apps.reload();
    } catch (reason) {
      setError(apiErrorCopy(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      back
      title="Connected AI apps"
      refreshing={apps.refreshing}
      onRefresh={() => apps.reload({ refresh: true })}
    >
      {apps.loading && (
        <ActivityIndicator accessibilityLabel="Loading connected AI apps" color={palette.accent} />
      )}
      {apps.error && <ErrorNotice error={apps.error} onRetry={() => apps.reload()} />}
      {error && <ErrorNotice error={error} />}
      {!apps.loading && !apps.error && state.empty && (
        <View style={{ gap: space.md }}>
          <Text style={[type.body, { color: palette.textSecondary }]}>
            No AI apps yet. Add Twring in Claude, ChatGPT or another AI app.
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
      {state.rows.map((app) => (
        <View
          key={app.client_id}
          style={{
            borderColor: palette.border,
            borderWidth: 1,
            borderRadius: radius.sm,
            marginBottom: space.sm,
          }}
        >
          <Row
            label={app.name}
            value={
              app.blocked
                ? 'Blocked'
                : `Connected · Last used ${app.last_used_at ? formatWhen(app.last_used_at, now) : 'never'}`
            }
            divider={false}
          />
          <View style={{ paddingHorizontal: space.md, paddingBottom: space.sm }}>
            <GhostButton
              label={app.blocked ? 'Allow again' : 'Remove'}
              tone={app.blocked ? 'accent' : 'danger'}
              disabled={busy}
              onPress={() => (app.blocked ? void update(app, 'allow') : setRemoving(app))}
            />
          </View>
        </View>
      ))}
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
