import * as Clipboard from 'expo-clipboard';
import { Text, View } from 'react-native';
import { GhostButton } from '@/components/GhostButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
import { Linking } from 'react-native';
export function LinkSheet({ url, onClose }: { url?: string; onClose: () => void }) {
  const palette = usePalette();
  return (
    <Sheet visible={!!url} title="Open link?" onClose={onClose}>
      <View style={{ gap: 12 }}>
        <Text
          selectable
          style={{ color: palette.textPrimary, fontFamily: font.mono, fontSize: 12 }}
        >
          {url}
        </Text>
        <PrimaryButton
          label="Open link"
          onPress={() => {
            if (url) void Linking.openURL(url);
            onClose();
          }}
        />
        <GhostButton
          label="Copy link"
          onPress={() => {
            if (url) void Clipboard.setStringAsync(url);
            onClose();
          }}
        />
        <GhostButton label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}
