import Constants from 'expo-constants';
import { router } from 'expo-router';
import type { MeUsageResponse } from '@twring/contracts';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { authController, deleteSignInAccount, useAuth } from '@/auth';
import { appleAuthorizationCode } from '@/auth/apple-sign-in';
import { startCall } from '@/call/start';
import { ErrorNotice } from '@/components/ErrorNotice';
import { RingSettings } from '@/components/RingSettings';
import { Screen } from '@/components/Screen';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { TextButton } from '@/components/TextButton';
import { mobileEnv } from '@/config/env';
import { activeServerUrl, useActiveServer } from '@/servers/active';
import { leaveServer } from '@/servers/switching';
import { YourServer } from '@/servers/your-server';
import {
  ACCOUNT_NOT_DELETED,
  accountToDeleteLabel,
  deleteAccount,
  endAppleSignIn,
  type AccountDeletionStart,
} from '@/privacy/account-deletion';
import { deletionSummary } from '@/privacy/deletion';
import { pushRegistration } from '@/ring/service';
import { useChatList } from '@/threads/chats';
import { type, usePalette } from '@/theme/tokens';
import { usageResetLine, usageSummary } from '@/usage/copy';

type Deletion =
  | { state: 'idle' }
  | { state: 'deleting' }
  | { state: 'done'; summary: string }
  | { state: 'failed'; error: ErrorCopy };

type AccountDeletion =
  | { state: 'idle' }
  | { state: 'deleting' }
  | { state: 'failed'; error: ErrorCopy; retryFrom: AccountDeletionStart };

type Usage =
  { state: 'loading' } | { state: 'loaded'; usage: MeUsageResponse } | { state: 'unavailable' };

/** Settings and privacy (UX_UI_SPEC §18). */
export default function SettingsScreen() {
  const palette = usePalette();
  const devBuild = __DEV__ || (mobileEnv.ok && mobileEnv.env.CORD_ENV === 'development');
  const version = Constants.expoConfig?.version ?? 'unknown';
  const [deletion, setDeletion] = useState<Deletion>({ state: 'idle' });
  const auth = useAuth();
  const server = useActiveServer();
  const selfhosted = server.kind === 'selfhost';
  const signedIn = auth.status === 'signed_in';
  const chatsAvailable = useChatList().available;
  const [accountDeletion, setAccountDeletion] = useState<AccountDeletion>({ state: 'idle' });
  const [usage, setUsage] = useState<Usage>({ state: 'loading' });
  // Shown only when the server has the feature on (a 404 or any failure hides the row).
  const [voiceAccounts, setVoiceAccounts] = useState(false);

  useEffect(() => {
    const api = twringApi();
    // Without a configured server, the section simply stays hidden.
    if (api === undefined) return;
    const controller = new AbortController();
    api.usage(controller.signal).then(
      (result) => setUsage({ state: 'loaded', usage: result }),
      () => {
        if (!controller.signal.aborted) setUsage({ state: 'unavailable' });
      },
    );
    api.listSpeechKeys(controller.signal).then(
      () => setVoiceAccounts(true),
      () => setVoiceAccounts(false),
    );
    return () => controller.abort();
  }, []);

  function signOut() {
    void authController()?.signOut();
  }

  function confirmSignOut() {
    Alert.alert('Sign out?', 'Any call in progress ends. Your agents stay saved for next time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  }

  function deleteMyData() {
    const api = twringApi();
    if (api === undefined) return;
    setDeletion({ state: 'deleting' });
    api.deleteMyData().then(
      (result) => {
        // The server removed this phone's push registration too: register again on next start.
        // On your own server the phone then leaves it, the way Leave this server does.
        // Leaving removes the profile here whatever the server says; nothing is left to report.
        if (selfhosted) void leaveServer().catch(() => undefined);
        else pushRegistration.forget();
        setDeletion({ state: 'done', summary: deletionSummary(result) });
      },
      (reason: unknown) => setDeletion({ state: 'failed', error: apiErrorCopy(reason) }),
    );
  }

  function confirmDelete() {
    Alert.alert(
      'Delete my data?',
      'Twring deletes all your agents, their saved keys, and your call history, and ends any call ' +
        'in progress. Your agents themselves are not changed. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: deleteMyData },
      ],
    );
  }

  function runAccountDeletion(from: AccountDeletionStart) {
    const api = twringApi();
    if (api === undefined) return;
    setAccountDeletion({ state: 'deleting' });
    void deleteAccount(
      {
        // An Apple account: Apple confirms, then Twring's Sign in with Apple is ended (S3).
        ...(auth.status === 'signed_in' &&
          auth.apple === true &&
          api.revokeAppleSignIn !== undefined && {
            endAppleSignIn: () =>
              endAppleSignIn(appleAuthorizationCode, (code) =>
                api.revokeAppleSignIn ? api.revokeAppleSignIn(code) : Promise.resolve(),
              ),
          }),
        // This phone stops ringing for the account first, while the session still works.
        deleteData: async () => {
          await pushRegistration.signedOut();
          return api.deleteMyData();
        },
        deleteAccount: deleteSignInAccount,
        signOut: () => authController()?.signOut() ?? Promise.resolve(),
      },
      from,
    ).then((result) => {
      switch (result.status) {
        case 'done':
          // Signed out: the app is on Sign in now.
          setAccountDeletion({ state: 'idle' });
          return;
        case 'cancelled':
          // Apple's confirmation was closed: nothing was deleted.
          setAccountDeletion({ state: 'idle' });
          return;
        case 'data_failed':
          setAccountDeletion({
            state: 'failed',
            error: apiErrorCopy(result.error),
            retryFrom: 'data',
          });
          return;
        case 'account_failed':
          setAccountDeletion({
            state: 'failed',
            error: { message: ACCOUNT_NOT_DELETED, retryable: true },
            retryFrom: 'account',
          });
          return;
      }
    });
  }

  function confirmDeleteAccount() {
    const account = accountToDeleteLabel(auth.status === 'signed_in' ? auth : {});
    Alert.alert(
      `Delete ${account}?`,
      `Twring deletes everything it keeps for ${account}: its agents, their saved keys, its call ` +
        'history, and the sign-in account. Any call in progress ends and you are signed out. ' +
        'Your agents themselves are not changed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () =>
            Alert.alert('This cannot be undone', `Delete ${account} and all its data now?`, [
              { text: 'Keep my account', style: 'cancel' },
              {
                text: 'Delete account',
                style: 'destructive',
                onPress: () => runAccountDeletion('data'),
              },
            ]),
        },
      ],
    );
  }

  const busy = deletion.state === 'deleting' || accountDeletion.state === 'deleting';
  const usageReset = usage.state === 'loaded' ? usageResetLine(usage.usage) : undefined;
  const usageContent =
    usage.state === 'loaded' ? (
      <SettingsRow
        label="Today's calling"
        value={
          usageReset !== undefined
            ? `${usageSummary(usage.usage)}
${usageReset}`
            : usageSummary(usage.usage)
        }
        divider={false}
      />
    ) : undefined;

  return (
    <Screen wordmark title="Settings">
      {selfhosted && <YourServer profile={server} />}

      {signedIn && !selfhosted && (
        <SettingsGroup title="Account">
          <SettingsRow label="Signed in as" value={auth.email ?? 'Google account'} />
          <SettingsRow
            label="Sign out"
            value="Ends any call in progress"
            accessibilityHint="Asks before signing out"
            onPress={confirmSignOut}
            divider={false}
          />
          {accountDeletion.state === 'deleting' && (
            <ActivityIndicator
              accessibilityLabel="Deleting your account"
              color={palette.textSecondary}
            />
          )}
          {accountDeletion.state === 'failed' && (
            <ErrorNotice
              error={accountDeletion.error}
              onRetry={() => runAccountDeletion(accountDeletion.retryFrom)}
            />
          )}
        </SettingsGroup>
      )}

      {signedIn ? (
        <RingSettings footer={usageContent} chatsAvailable={chatsAvailable} />
      ) : usageContent !== undefined ? (
        <SettingsGroup title="Calls">{usageContent}</SettingsGroup>
      ) : null}

      {signedIn && !selfhosted && (
        <SettingsGroup title="AI apps">
          <SettingsRow
            label="Connected AI apps"
            value="Manage apps that can ring and message you"
            onPress={() => router.push('/settings/connected-apps')}
            divider={voiceAccounts}
          />
          {voiceAccounts && (
            <SettingsRow
              label="Your own voice accounts"
              value="Use your own Deepgram, Cartesia or xAI"
              onPress={() => router.push('/settings/voice-accounts')}
              divider={false}
            />
          )}
        </SettingsGroup>
      )}

      {signedIn && !selfhosted && (
        <SettingsGroup title="Help">
          <SettingsRow
            label="Send feedback"
            value="Tell us what works and what doesn't"
            onPress={() => router.push('/settings/feedback')}
            divider={false}
          />
        </SettingsGroup>
      )}

      <SettingsGroup title="Privacy & data">
        <Text style={[type.caption, styles.intro, { color: palette.textSecondary }]}>
          Twring does not record calls or keep call transcripts. Your chats are kept until you clear
          them.
        </Text>
        <SettingsRow
          label="Privacy"
          value="What Twring keeps, who processes it, and for how long"
          icon="globe"
          onPress={() => router.push('/privacy')}
        />
        <SettingsRow
          label="Delete my data"
          value="Your agents, saved keys, and call history. Keeps your account."
          accessibilityHint="Asks before deleting anything"
          onPress={busy ? undefined : confirmDelete}
          danger
          divider={signedIn && !selfhosted}
        />
        {signedIn && !selfhosted && (
          <SettingsRow
            label="Delete account"
            value="Deletes everything Twring keeps and signs you out"
            accessibilityHint="Asks twice before deleting anything"
            onPress={busy ? undefined : confirmDeleteAccount}
            danger
            divider={false}
          />
        )}
        {deletion.state === 'deleting' && (
          <ActivityIndicator
            accessibilityLabel="Deleting your data"
            color={palette.textSecondary}
          />
        )}
        {deletion.state === 'done' && (
          <>
            <Text accessibilityRole="alert" style={[type.body, { color: palette.textPrimary }]}>
              {deletion.summary}
            </Text>
            {signedIn && (
              <View style={styles.actions}>
                <TextButton label="Sign out now" onPress={signOut} />
              </View>
            )}
          </>
        )}
        {deletion.state === 'failed' && (
          <ErrorNotice error={deletion.error} onRetry={deleteMyData} />
        )}
      </SettingsGroup>

      <SettingsGroup title="About">
        <SettingsRow label="App version" value={version} mono divider={false} />
      </SettingsGroup>

      {devBuild && (
        <SettingsGroup title="Developer">
          {mobileEnv.ok && (
            <>
              <SettingsRow label="Server address" value={activeServerUrl()} />
              <SettingsRow label="Environment" value={mobileEnv.env.CORD_ENV} />
            </>
          )}
          <SettingsRow
            label="Call test line"
            value="Development builds only. Twring says back what it heard."
            onPress={() => startCall()}
          />
          <SettingsRow
            label="Component gallery"
            value="Preview shared components"
            onPress={() => router.push('/dev-components')}
            divider={false}
          />
        </SettingsGroup>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  actions: { flexDirection: 'row' },
});
