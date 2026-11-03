import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
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
                ▤ {file.name}
              </Text>
              <Text style={[styles.size, { color: palette.textSecondary }]}>
                {humanSize(file.sizeBytes)}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${file.name}`}
            hitSlop={8}
            onPress={() => onRemove(file.clientId)}
            style={[styles.remove, { backgroundColor: palette.surfaceRaised }]}
          >
            <Text style={[styles.x, { color: palette.textPrimary }]}>×</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  tray: { gap: 12, paddingHorizontal: 16, paddingTop: 10 },
  item: {
    height: 72,
    minWidth: 72,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 4,
    paddingRight: 28,
  },
  image: { width: 64, height: 64, borderRadius: 8 },
  document: { maxWidth: 160, paddingHorizontal: 8 },
  name: { fontFamily: font.bodyEmphasis, fontSize: 13 },
  size: { fontFamily: font.caption, fontSize: 11 },
  remove: {
    position: 'absolute',
    right: -7,
    top: -7,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  x: { fontFamily: font.body, fontSize: 22 },
});
