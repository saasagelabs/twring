import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { TwringLockup } from '@/components/Brand';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Waveform } from '@/components/Waveform';
import { markOnboardingSeen } from '@/onboarding/state';
import { microphonePermission } from '@/platform/microphone';
import { space, type, usePalette } from '@/theme/tokens';

type Page = 0 | 1;

/** First run (UX_UI_SPEC §4): one short page, the microphone, then Connect Agent. */
export default function OnboardingScreen() {
  const palette = usePalette();
  const [page, setPage] = useState<Page>(0);
  const [asking, setAsking] = useState(false);

  async function finish() {
    setAsking(true);
    // Asked here, after the explanation, never cold. A denial is handled again at call time.
    await microphonePermission.request().catch(() => undefined);
    markOnboardingSeen();
    router.replace('/connect');
  }

  return (
    <Screen
      {...(page > 0 && { back: () => setPage(0) })}
      footer={
        <View style={styles.footer}>
          <View accessible accessibilityLabel={`Page ${page + 1} of 2`} style={styles.pagination}>
            {[0, 1].map((index) => (
              <View
                key={index}
                style={[
                  styles.bar,
                  {
                    width: index === page ? 28 : 8,
                    backgroundColor: index === page ? palette.accent : palette.inactive,
                  },
                ]}
              />
            ))}
          </View>
          {page === 0 ? (
            <PrimaryButton label="Connect my agent" onPress={() => setPage(1)} />
          ) : (
            <PrimaryButton
              label="Allow microphone"
              disabled={asking}
              accessibilityHint="Shows the system microphone prompt, then continues to connect your agent"
              onPress={() => void finish()}
            />
          )}
        </View>
      }
    >
      {page === 0 && (
        <View style={styles.lockup}>
          <TwringLockup size={20} />
        </View>
      )}
      <View style={styles.wave}>
        <Waveform
          width={300}
          height={140}
          color={palette.accent}
          intensity={0.6}
          animated={false}
        />
      </View>
      <View style={styles.copy}>
        <Text
          accessibilityRole="header"
          style={[type.display, styles.title, { color: palette.textPrimary }]}
        >
          {page === 0 ? 'Call the agent you already use.' : 'Twring needs your microphone'}
        </Text>
        {page === 0 && (
          <Text style={[type.body, styles.body, { color: palette.textSecondary }]}>
            Talk to it the way you would on a phone call.
          </Text>
        )}
        {page === 1 && (
          <>
            <Text style={[type.body, styles.body, { color: palette.textSecondary }]}>
              So your agent can hear you during a call. Twring listens only while a call is on, and
              never records or keeps your audio.
            </Text>
            <Text style={[type.caption, { color: palette.textTertiary }]}>
              Your phone will ask next. You can change this later in your phone&apos;s settings.
            </Text>
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lockup: { alignItems: 'flex-start' },
  wave: { minHeight: 170, alignItems: 'center', justifyContent: 'center' },
  copy: { gap: space.md },
  title: { fontSize: 38, letterSpacing: -1.3 },
  body: { lineHeight: 22.5 },
  footer: { gap: space.xl },
  pagination: { flexDirection: 'row', gap: 6 },
  bar: { height: 3, borderRadius: 2 },
});
