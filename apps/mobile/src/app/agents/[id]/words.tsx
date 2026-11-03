import type { Agent } from '@twring/contracts';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { canEditAgent, VIEW_ONLY_AGENT_NOTE } from '@/agents/shared';
import { addKeyterm, removeKeyterm, sameKeyterms, splitKeyterms } from '@/agents/keyterms';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { GhostButton } from '@/components/GhostButton';
import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/PrimaryButton';
import { goBack, Screen } from '@/components/Screen';
import { useResource } from '@/hooks/useResource';
import { font } from '@/theme/fonts';
import { radius, space, type, usePalette } from '@/theme/tokens';

/** Words to recognise: names and places speech recognition should listen for. Saves via PATCH. */
export default function WordsScreen() {
  const palette = usePalette();
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const [edited, setEdited] = useState<string[] | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [inputError, setInputError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorCopy | undefined>(undefined);

  const load = useCallback(
    async (signal: AbortSignal): Promise<Agent> => {
      const api = twringApi();
      if (api === undefined) throw new Error('not configured');
      return api.getAgent(id, signal);
    },
    [id],
  );
  const data = useResource(load);
  const saved = data.data?.keyterms ?? [];
  // A list saved as one comma-separated entry opens as separate words, ready to save.
  const terms = edited ?? splitKeyterms(saved);

  function add() {
    const result = addKeyterm(terms, draft);
    if (!result.ok) {
      setInputError(result.error);
      return;
    }
    setEdited(result.terms);
    setDraft('');
    setInputError(undefined);
  }

  function save() {
    setSaving(true);
    setSaveError(undefined);
    twringApi()
      ?.updateAgent(id, { keyterms: terms })
      .then(goBack, (reason: unknown) => setSaveError(apiErrorCopy(reason)))
      .finally(() => setSaving(false));
  }

  if (data.data !== undefined && !canEditAgent(data.data)) {
    return (
      <Screen back title="Words to recognise">
        <Text style={[type.body, { color: palette.textSecondary }]}>{VIEW_ONLY_AGENT_NOTE}</Text>
      </Screen>
    );
  }

  return (
    <Screen
      back
      title="Words to recognise"
      footer={
        <PrimaryButton
          label="Save words"
          disabled={saving || data.data === undefined || sameKeyterms(terms, saved)}
          onPress={save}
        />
      }
    >
      <Text style={[type.body, { color: palette.textSecondary }]}>
        Names and places Twring should listen for, like Chennai or Priya. Changes apply from your
        next call or voice note.
      </Text>
      {data.loading && (
        <ActivityIndicator accessibilityLabel="Loading words" color={palette.textSecondary} />
      )}
      {data.error !== undefined && <ErrorNotice error={data.error} onRetry={() => data.reload()} />}
      {saveError !== undefined && <ErrorNotice error={saveError} />}
      <View style={styles.inputRow}>
        <View style={styles.field}>
          <Field
            label="Add a word"
            placeholder="Coimbatore, Madurai"
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              setInputError(undefined);
            }}
            autoCorrect={false}
            autoCapitalize="words"
            returnKeyType="done"
            submitBehavior="submit"
            onSubmitEditing={add}
            {...(inputError !== undefined && { error: inputError })}
          />
        </View>
        <GhostButton
          label="Add"
          tone="accent"
          accessibilityHint="Adds the word to the list"
          onPress={add}
        />
      </View>
      {terms.length === 0 ? (
        <Text style={[type.body, { color: palette.textTertiary }]}>No words yet.</Text>
      ) : (
        <View style={styles.list}>
          {terms.map((term) => (
            <View key={term} style={[styles.chip, { borderColor: palette.borderAccent }]}>
              <Text style={[styles.term, { color: palette.accent }]}>{term}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove"
                accessibilityHint={`Removes ${term} from the list`}
                onPress={() => setEdited(removeKeyterm(terms, term))}
                style={styles.remove}
              >
                <Icon name="x" size={13} color={palette.accent} strokeWidth={2} />
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  inputRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: space.sm },
  field: { flexGrow: 1, flexBasis: 220 },
  list: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(25,214,242,0.06)',
    paddingLeft: 14,
  },
  term: { fontFamily: font.interMedium, fontSize: 14, paddingVertical: 8 },
  remove: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
