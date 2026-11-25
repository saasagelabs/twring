import { StyleSheet, Text, View } from 'react-native';

import { GhostButton } from '@/components/GhostButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SPEECH_NOTE, VOICE_WARNING } from '@/e2e/private-state';
import { font } from '@/theme/fonts';
import { type, usePalette } from '@/theme/tokens';

/** Under a private chat's header: the label (`labelFor`) and the note that speech is not private. */
export function PrivateBanner({ label }: { label: string }) {
  const palette = usePalette();
  return (
    <View accessible accessibilityLabel={`${label}. ${SPEECH_NOTE}`} style={styles.banner}>
      <Text style={[styles.label, { color: palette.accent }]}>{label}</Text>
      <Text style={[styles.note, { color: palette.textSecondary }]}>{SPEECH_NOTE}</Text>
    </View>
  );
}

/** Before a voice note goes out in a private chat: it is transcribed on the server. */
export function VoiceNoteWarning({
  onSend,
  onCancel,
}: {
  onSend: () => void;
  onCancel: () => void;
}) {
  const palette = usePalette();
  return (
    <View style={styles.warning}>
      <Text accessibilityLiveRegion="polite" style={[styles.body, { color: palette.textPrimary }]}>
        {VOICE_WARNING}
      </Text>
      <View style={styles.buttons}>
        <GhostButton label="Don't send" onPress={onCancel} />
        <PrimaryButton label="Send anyway" onPress={onSend} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { paddingHorizontal: 18, paddingBottom: 6, gap: 2 },
  label: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
  note: { fontFamily: font.body, fontSize: type.caption.fontSize },
  warning: { paddingHorizontal: 18, paddingVertical: 10, gap: 10 },
  body: { fontFamily: font.body, fontSize: type.body.fontSize },
  buttons: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
});
