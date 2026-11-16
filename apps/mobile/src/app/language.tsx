import type { SpeakerLanguage } from '@twring/contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import {
  ALL_LANGUAGES,
  LANGUAGE_EXPLANATION,
  languageAccessibilityLabel,
  languageName,
} from '@/language/language';
import { languageStore, useLanguageState } from '@/language/store';
import { playCallFeedback } from '@/platform/haptics';
import { radius, space, type, usePalette } from '@/theme/tokens';

/** Settings, Language you speak: tapping a language saves it at once. */
export default function LanguageScreen() {
  const palette = usePalette();
  const current = useLanguageState();
  const [saving, setSaving] = useState<SpeakerLanguage | undefined>(undefined);
  const [error, setError] = useState<{ copy: ErrorCopy; language: SpeakerLanguage }>();
  const selected = current.status === 'loaded' ? current.language : undefined;

  function choose(language: SpeakerLanguage) {
    const api = twringApi();
    if (api?.setLanguage === undefined || saving !== undefined || language === selected) return;
    setSaving(language);
    setError(undefined);
    api
      .setLanguage(language)
      .then(
        (saved) => {
          languageStore.set(saved);
          playCallFeedback('connected');
        },
        (reason: unknown) => {
          const copy = apiErrorCopy(reason);
          setError({
            language,
            copy: {
              ...copy,
              message: `${languageName(language)} was not saved. ${copy.message}`,
            },
          });
          playCallFeedback('error');
        },
      )
      .finally(() => setSaving(undefined));
  }

  return (
    <Screen back title="Language you speak">
      <Text style={[type.body, { color: palette.textSecondary }]}>{LANGUAGE_EXPLANATION}</Text>
      {error !== undefined && (
        <ErrorNotice error={error.copy} onRetry={() => choose(error.language)} />
      )}
      <View accessibilityRole="radiogroup" accessibilityLabel="Languages" style={styles.choices}>
        {ALL_LANGUAGES.map((language) => {
          const chosen = (saving ?? selected) === language;
          return (
            <Pressable
              key={language}
              accessibilityRole="radio"
              accessibilityLabel={languageAccessibilityLabel(language)}
              accessibilityState={{ checked: chosen, busy: saving === language }}
              onPress={() => choose(language)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: chosen ? palette.accentTint : palette.surface,
                  borderColor: chosen ? palette.borderAccent : palette.border,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text style={[type.body, styles.label, { color: palette.textPrimary }]}>
                {languageName(language)}
              </Text>
              {chosen && <Icon name="check" size={18} color={palette.accent} />}
            </Pressable>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  choices: { gap: space.sm },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
  },
  label: { flex: 1 },
});
