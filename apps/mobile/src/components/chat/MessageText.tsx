import { Text, View } from 'react-native';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
import { segmentText, type TextSegment } from '@/threads/presentation';

export function MessageText({ text, onLink }: { text: string; onLink: (url: string) => void }) {
  const palette = usePalette();
  const blocks: TextSegment[][] = [];
  for (const part of segmentText(text)) {
    if (part.kind === 'code' || blocks.length === 0 || blocks.at(-1)?.[0]?.kind === 'code')
      blocks.push([part]);
    else blocks[blocks.length - 1].push(part);
  }
  return (
    <View>
      {blocks.map((parts, index) =>
        parts[0].kind === 'code' ? (
          // Wrapped, not a horizontal ScrollView: an unbounded line grows the Text past
          // Android's max texture size, which draws nothing (blank bubble, 2026-11-11).
          <View
            key={index}
            style={{ backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 8, marginVertical: 4 }}
          >
            <Text
              selectable
              style={{
                color: palette.textPrimary,
                fontFamily: font.mono,
                fontSize: 12,
                lineHeight: 17,
                padding: 10,
              }}
            >
              {parts[0].value}
            </Text>
          </View>
        ) : (
          <Text
            key={index}
            style={{
              color: palette.textPrimary,
              fontFamily: font.body,
              fontSize: 15,
              lineHeight: 23,
            }}
          >
            {parts.map((part, partIndex) => (
              <Text
                key={partIndex}
                accessibilityRole={part.kind === 'link' ? 'link' : undefined}
                onPress={part.kind === 'link' ? () => onLink(part.value) : undefined}
                style={{
                  color: part.kind === 'link' ? palette.accent : palette.textPrimary,
                  textDecorationLine: part.kind === 'link' ? 'underline' : 'none',
                  fontFamily: part.kind === 'bold' ? font.bodyEmphasis : font.body,
                }}
              >
                {part.kind === 'link' ? (part.label ?? part.value) : part.value}
              </Text>
            ))}
          </Text>
        ),
      )}
    </View>
  );
}
