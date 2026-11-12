import { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
} from 'react-native';

import { radius, space, type, usePalette } from '@/theme/tokens';

type InputProps = Pick<
  TextInputProps,
  | 'value'
  | 'maxLength'
  | 'onChangeText'
  | 'placeholder'
  | 'secureTextEntry'
  | 'autoCapitalize'
  | 'autoCorrect'
  | 'keyboardType'
  | 'onSubmitEditing'
  | 'autoFocus'
  | 'textContentType'
  | 'autoComplete'
  | 'returnKeyType'
  | 'submitBehavior'
  | 'multiline'
>;

interface Props extends InputProps {
  label: string;
  hint?: string;
  error?: string;
  inputStyle?: StyleProp<TextStyle>;
}

/** Labelled text input; its hint or error is announced with it. */
export function Field({ label, hint, error, inputStyle, ...input }: Props) {
  const palette = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={[type.microLabel, styles.label, { color: palette.textTertiary }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor={palette.textTertiary}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          type.body,
          styles.input,
          {
            color: palette.textPrimary,
            backgroundColor: palette.surface,
            borderColor:
              error !== undefined
                ? palette.danger
                : focused
                  ? palette.borderAccent
                  : palette.border,
            boxShadow: focused && error === undefined ? '0 0 14px rgba(25,214,242,0.2)' : undefined,
          },
          inputStyle,
        ]}
        {...input}
      />
      {hint !== undefined && (
        <Text style={[type.caption, { color: palette.textTertiary }]}>{hint}</Text>
      )}
      {error !== undefined && (
        <Text accessibilityLiveRegion="polite" style={[type.caption, { color: palette.danger }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.sm },
  label: { textTransform: 'uppercase' },
  input: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 14,
  },
});
