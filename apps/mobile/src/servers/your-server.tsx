import { buildPairLink, type ServerInfo } from '@twring/contracts';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Share, StyleSheet, Text, View } from 'react-native';

import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import type { MemberCode, PeopleList } from '@/api/client';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { space, type, usePalette } from '@/theme/tokens';

import type { SelfhostProfile } from './profiles';
import { leaveServer, switchToHosted } from './switching';

export const OWN_AUDIO_LINE = "Calls use your server's audio";
export const TWRING_AUDIO_LINE = "Calls on this server use Twring's audio service";
export const UNVERIFIED_REMINDER =
  'Confirm the email Twring sent you within 7 days, or rings pause.';

/** The ring service line, and for admins of an unverified server the reminder beneath it. */
export function ringServiceLines(
  ring: ServerInfo['ring_service'] | undefined,
  admin: boolean,
): { line: string; reminder?: string } {
  switch (ring?.state) {
    case 'active':
      return { line: 'Ring service: free while we launch' };
    case 'unverified':
      return {
        line: 'Ring service: free while we launch',
        ...(admin && { reminder: UNVERIFIED_REMINDER }),
      };
    case 'paused':
      return { line: "Ring service: paused until your server's email address is confirmed" };
    case 'expired':
      return { line: 'Ring service: ended. Ask your admin.' };
    case 'unregistered':
      return { line: 'Ring service: not set up. On the server, run twring register.' };
    case 'unknown':
    case undefined:
      return { line: 'Ring service: checking' };
  }
}

type Busy = 'leaving' | 'switching' | 'code' | undefined;

/** Settings for a self-hosted server: its address, audio, ring service, people and leaving it. */
export function YourServer({ profile }: { profile: SelfhostProfile }) {
  const palette = usePalette();
  const admin = profile.person.role === 'admin';
  const [info, setInfo] = useState<ServerInfo | undefined>();
  const [people, setPeople] = useState<PeopleList | undefined>();
  const [code, setCode] = useState<MemberCode | undefined>();
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<ErrorCopy | undefined>();

  useEffect(() => {
    const api = twringApi();
    if (api === undefined) return;
    const controller = new AbortController();
    // A server that does not answer leaves the ring line on "checking".
    api.serverInfo(controller.signal).then(setInfo, () => undefined);
    if (admin) api.listPeople(controller.signal).then(setPeople, () => undefined);
    return () => controller.abort();
  }, [admin, profile.serverId]);

  const ring = ringServiceLines(info?.ring_service, admin);

  function addTeammate() {
    const api = twringApi();
    if (api === undefined || busy !== undefined) return;
    setBusy('code');
    setError(undefined);
    api.createMemberCode().then(
      (result) => {
        setCode(result);
        setBusy(undefined);
      },
      (reason: unknown) => {
        setError(apiErrorCopy(reason));
        setBusy(undefined);
      },
    );
  }

  function share(minted: MemberCode) {
    const link = buildPairLink({
      server: profile.address,
      code: minted.code,
      serverId: profile.serverId,
    });
    void Share.share({ message: link }).catch(() => undefined);
  }

  function remove(id: string) {
    const api = twringApi();
    if (api === undefined) return;
    setError(undefined);
    api.removePerson(id).then(
      () => setPeople((current) => current?.filter((person) => person.id !== id)),
      (reason: unknown) => setError(apiErrorCopy(reason)),
    );
  }

  function confirmRemove(id: string, name: string) {
    Alert.alert(`Remove ${name}?`, `${name} will no longer be able to use this server.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => remove(id) },
    ]);
  }

  function confirmLeave() {
    Alert.alert(
      `Leave ${profile.name}?`,
      'This phone stops ringing for it. Your chats stay on the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => {
            setBusy('leaving');
            void leaveServer().finally(() => setBusy(undefined));
          },
        },
      ],
    );
  }

  function useTwring() {
    if (busy !== undefined) return;
    setBusy('switching');
    void switchToHosted().finally(() => setBusy(undefined));
  }

  return (
    <SettingsGroup title="Your server">
      <SettingsRow label="Address" value={profile.address} />
      <SettingsRow label={profile.audio === 'own' ? OWN_AUDIO_LINE : TWRING_AUDIO_LINE} />
      <SettingsRow
        label={ring.line}
        {...(ring.reminder !== undefined && { value: ring.reminder })}
      />
      {admin && (
        <>
          <SettingsRow label="People" />
          {people?.map((person) => {
            const you = person.id === profile.person.id;
            const role = person.role === 'admin' ? 'Admin' : 'Member';
            return (
              <SettingsRow
                key={person.id}
                label={person.display_name}
                value={you ? `${role}, you` : `${role}. Tap to remove.`}
                {...(!you && {
                  accessibilityHint: 'Asks before removing this person',
                  onPress: () => confirmRemove(person.id, person.display_name),
                })}
              />
            );
          })}
          <SettingsRow
            label="Add a teammate"
            accessibilityHint="Makes a code your teammate enters in Twring"
            onPress={busy === undefined ? addTeammate : undefined}
          />
          {busy === 'code' && (
            <ActivityIndicator accessibilityLabel="Making a code" color={palette.textSecondary} />
          )}
          {code !== undefined && (
            <View style={styles.code} accessibilityLiveRegion="polite">
              <Text style={[type.display, { color: palette.textPrimary }]}>{profile.address}</Text>
              <Text style={[type.display, { color: palette.textPrimary }]}>{code.code}</Text>
              <Text style={[type.caption, { color: palette.textSecondary }]}>
                Valid for 10 minutes
              </Text>
              <GhostButton label="Share" tone="accent" onPress={() => share(code)} />
            </View>
          )}
        </>
      )}
      {error !== undefined && <ErrorNotice error={error} />}
      <SettingsRow
        label="Leave this server"
        accessibilityHint="Asks before leaving"
        onPress={busy === undefined ? confirmLeave : undefined}
        danger
      />
      <SettingsRow
        label="Use Twring's service instead"
        onPress={busy === undefined ? useTwring : undefined}
        divider={false}
      />
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  code: { gap: space.sm, padding: 14 },
});
