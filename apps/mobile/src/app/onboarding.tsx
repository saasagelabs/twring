import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { TwringLockup } from '@/components/Brand';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Waveform } from '@/components/Waveform';
import { markOnboardingSeen } from '@/onboarding/state';
import { microphonePermission } from '@/platform/microphone';
import { radius, space, type, usePalette } from '@/theme/tokens';

type Page = 0 | 1 | 2;

const HOW_IT_WORKS = [
  'Twring turns your speech into text.',
  'Your connected agent receives that text, just like a chat message.',
  "Anything the agent does stays under its own system's control. Twring never runs its tools.",
  "Twring speaks the agent's reply back to you.",
];

/** First run (UX_UI_SPEC §4): three short pages, then Connect Agent. */
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
      {...(page > 0 && { back: () => setPage(page === 1 ? 0 : 1) })}
      footer={
        <View style={styles.footer}>
          <View accessible accessibilityLabel={`Page ${page + 1} of 3`} style={styles.pagination}>
            {[0, 1, 2].map((index) => (
              <View
                key={index}
                style={[
                  styles.bar,
                  {
                    width: index === page ? 28 : 8,
                    backgroundColor: index === page ? palette.accent : 'rgba(255,255,255,0.2)',
                    boxShadow: index === page ? `0 0 8px ${palette.accent}` : undefined,
                  },
                ]}
              />
            ))}
          </View>
          {page === 0 ? (
            <PrimaryButton label="Connect my agent" onPress={() => setPage(1)} />
          ) : page === 1 ? (
            <PrimaryButton label="Continue" onPress={() => setPage(2)} />
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
          height={page === 1 ? 90 : 140}
          color={palette.accent}
          intensity={0.6}
        />
      </View>
      <View style={styles.copy}>
        <Text style={[type.microLabel, { color: palette.accent }]}>{`STEP ${page + 1} OF 3`}</Text>
        <Text
          accessibilityRole="header"
          style={[type.display, styles.title, { color: palette.textPrimary }]}
        >
          {page === 0
            ? 'Call the agent you already use.'
            : page === 1
              ? 'Your agent stays in charge'
              : 'Twring needs your microphone'}
        </Text>
        {page === 0 && (
          <Text style={[type.body, styles.body, { color: palette.textSecondary }]}>
            Twring adds realtime voice without replacing your agent&apos;s brain, tools, or memory.
          </Text>
        )}
        {page === 1 && (
          <View
            style={[
              styles.points,
              { borderColor: palette.border, backgroundColor: 'rgba(255,255,255,0.03)' },
            ]}
          >
            {HOW_IT_WORKS.map((line, index) => (
              <View
                key={line}
                style={[
                  styles.point,
                  index < 3 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderColor: palette.border,
                  },
                ]}
              >
                <Text
                  importantForAccessibility="no"
                  style={[type.mono, styles.number, { color: palette.accent }]}
                >
                  {index + 1}
                </Text>
                <Text style={[type.body, styles.pointText, { color: palette.textSecondary }]}>
                  {line}
                </Text>
              </View>
            ))}
          </View>
        )}
        {page === 2 && (
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
  points: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  point: { flexDirection: 'row', gap: space.md, padding: space.lg },
  number: { minWidth: 20 },
  pointText: { flex: 1 },
  footer: { gap: space.xl },
  pagination: { flexDirection: 'row', gap: 6 },
  bar: { height: 3, borderRadius: 2 },
});
