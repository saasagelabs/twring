import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, Text } from 'react-native';

import { font } from '@/theme/fonts';
import { type, usePalette } from '@/theme/tokens';

const CONFIRM_MS = 1_500;

/** "Copy" on a code block: copies the block, then shows "Copied" briefly. */
export function CopyCodeButton({ code }: { code: string }) {
  const palette = usePalette();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(code);
    } catch {
      return;
    }
    setCopied(true);
    void Haptics.selectionAsync().catch(() => undefined);
    AccessibilityInfo.announceForAccessibility('Code copied');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Copy code"
      hitSlop={8}
      onPress={() => void copy()}
      style={({ pressed }) => ({
        alignSelf: 'flex-end',
        minWidth: 44,
        minHeight: 36,
        paddingHorizontal: 10,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          color: copied ? palette.textSecondary : palette.accent,
          fontFamily: font.bodyEmphasis,
          fontSize: type.caption.fontSize,
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Text>
    </Pressable>
  );
}
