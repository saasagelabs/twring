import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { font } from '@/theme/fonts';
import { usePalette, type } from '@/theme/tokens';
import { ACTION_LABELS, quoteLine, type MessageAction } from '@/threads/message-actions';

/** The long-press choices for one message. */
export function MessageActionSheet({
  target,
  onChoose,
  onClose,
}: {
  target?: { text: string; actions: MessageAction[] };
  onChoose: (action: MessageAction) => void;
  onClose: () => void;
}) {
  const palette = usePalette();
  return (
    <Sheet visible={!!target} onClose={onClose}>
      {target && (
        <View style={styles.list}>
          {!!target.text && (
            <Text numberOfLines={2} style={[styles.preview, { color: palette.textSecondary }]}>
              {quoteLine(target.text)}
            </Text>
          )}
          {target.actions.map((action) => (
            <Pressable
              key={action}
              accessibilityRole="button"
              accessibilityLabel={ACTION_LABELS[action]}
              onPress={() => onChoose(action)}
              style={styles.row}
            >
              <Text
                style={[
                  styles.label,
                  { color: action === 'delete' ? palette.danger : palette.textPrimary },
                ]}
              >
                {ACTION_LABELS[action]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </Sheet>
  );
}

/** Above the composer while a reply is being written. */
export function ReplyBar({
  from,
  text,
  onCancel,
}: {
  from: string;
  text: string;
  onCancel: () => void;
}) {
  const palette = usePalette();
  return (
    <View
      style={[styles.bar, { borderTopColor: palette.border, backgroundColor: palette.background }]}
    >
      <View
        accessible
        accessibilityLabel={`Replying to ${from}: ${quoteLine(text)}`}
        style={[styles.barQuote, { borderLeftColor: palette.accent }]}
      >
        <Text numberOfLines={1} style={[styles.barTitle, { color: palette.accent }]}>
          Replying to {from}
        </Text>
        <Text numberOfLines={1} style={[styles.barText, { color: palette.textSecondary }]}>
          {quoteLine(text)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel reply"
        hitSlop={4}
        onPress={onCancel}
        style={styles.close}
      >
        <Icon name="x" size={18} color={palette.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 4 },
  preview: { fontFamily: font.body, fontSize: type.caption.fontSize, marginBottom: 8 },
  row: { minHeight: 52, justifyContent: 'center' },
  label: { fontFamily: font.bodyEmphasis, fontSize: type.body.fontSize },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 18,
    paddingRight: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  barQuote: { flex: 1, borderLeftWidth: 3, paddingLeft: 8 },
  barTitle: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
  barText: { fontFamily: font.body, fontSize: type.caption.fontSize },
  close: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
