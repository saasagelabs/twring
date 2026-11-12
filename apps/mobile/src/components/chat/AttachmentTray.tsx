import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { font } from '@/theme/fonts';
import { usePalette, radius, type } from '@/theme/tokens';
import { humanSize, type PreparedFile } from '@/threads/files';

export function AttachmentTray({
  files,
  onRemove,
}: {
  files: PreparedFile[];
  onRemove: (clientId: string) => void;
}) {
  const palette = usePalette();
  if (!files.length) return null;
  return (
    <ScrollView horizontal contentContainerStyle={styles.tray} accessibilityLabel="Attachments">
      {files.map((file) => (
        <View
          key={file.clientId}
          style={[styles.item, { backgroundColor: palette.surface, borderColor: palette.border }]}
        >
          {file.mimeType.startsWith('image/') ? (
            <Image source={{ uri: file.uri }} style={styles.image} contentFit="cover" />
          ) : (
            <View style={styles.document}>
              <Text style={[styles.name, { color: palette.textPrimary }]} numberOfLines={1}>
                {file.name}
              </Text>
              <Text style={[styles.size, { color: palette.textSecondary }]}>
                {humanSize(file.sizeBytes)}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${file.name}`}
            hitSlop={REMOVE_HIT_SLOP}
            onPress={() => onRemove(file.clientId)}
            style={[styles.remove, { backgroundColor: palette.surfaceRaised }]}
          >
            <Icon name="x" size={14} color={palette.textPrimary} strokeWidth={2} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/** The visible remove button is 24 px; the slop brings its hit target to 44 x 44. */
const REMOVE_SIZE = 24;
export const REMOVE_HIT_SLOP = (44 - REMOVE_SIZE) / 2;

const styles = StyleSheet.create({
  tray: { gap: 12, paddingHorizontal: 16, paddingTop: 10 },
  item: {
    height: 72,
    minWidth: 72,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 4,
    paddingRight: 32,
  },
  image: { width: 64, height: 64, borderRadius: radius.xs },
  document: { maxWidth: 160, paddingHorizontal: 8 },
  name: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
  size: { fontFamily: font.caption, fontSize: type.microLabel.fontSize },
  remove: {
    position: 'absolute',
    right: 4,
    top: 4,
    width: REMOVE_SIZE,
    height: REMOVE_SIZE,
    borderRadius: REMOVE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
