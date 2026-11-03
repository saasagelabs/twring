import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
import { shouldFold } from '@/threads/presentation';
import { MessageText } from './MessageText';
import { Icon } from '@/components/Icon';
import { callDuration } from '@/threads/presentation';
import type { Attachment } from '@twring/contracts';
import type { PreparedFile } from '@/threads/files';
import { Attachments } from './Attachments';

export function Bubble({
  text,
  time,
  sender,
  own,
  onLink,
  caption,
  voiceDuration,
  agentId,
  attachments,
  pendingFiles,
}: {
  text: string;
  time: string;
  sender: string;
  own: boolean;
  onLink: (url: string) => void;
  caption?: string;
  voiceDuration?: number;
  agentId?: string;
  attachments?: Attachment[];
  pendingFiles?: PreparedFile[];
}) {
  const palette = usePalette();
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const folded = shouldFold(text) && !all;
  return (
    <View style={[styles.wrap, { alignItems: own ? 'flex-end' : 'flex-start' }]}>
      <Pressable
        accessible={!attachments?.length && !pendingFiles?.length}
        accessibilityLabel={`${sender}, ${time}: ${text}`}
        onLongPress={() => {
          void Clipboard.setStringAsync(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        style={[
          styles.bubble,
          {
            backgroundColor: own ? 'rgba(25,214,242,0.14)' : palette.surface,
            borderColor: own ? 'rgba(25,214,242,0.4)' : palette.border,
            borderBottomRightRadius: own ? 6 : 18,
            borderBottomLeftRadius: own ? 18 : 6,
          },
        ]}
      >
        {voiceDuration !== undefined && (
          <View style={styles.voice}>
            <Icon name="mic" size={15} color={palette.textSecondary} />
            <Text style={[styles.voiceTime, { color: palette.textSecondary }]}>
              {callDuration(voiceDuration)}
            </Text>
          </View>
        )}
        {agentId && ((attachments?.length ?? 0) > 0 || (pendingFiles?.length ?? 0) > 0) && (
          <Attachments
            agentId={agentId}
            files={pendingFiles ?? attachments ?? []}
            pending={!!pendingFiles}
          />
        )}
        {!!text && (
          <View style={folded ? styles.fold : undefined}>
            <MessageText text={text} onLink={onLink} />
            {folded && (
              <LinearGradient
                pointerEvents="none"
                colors={['transparent', own ? '#07303A' : '#0A0C10']}
                style={styles.fade}
              />
            )}
          </View>
        )}
        {folded && (
          <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={styles.showAll}>
            <Text style={{ color: palette.accent, fontFamily: font.body }}>Show all</Text>
          </Pressable>
        )}
        <Text style={[styles.time, { color: palette.textTertiary }]}>{time}</Text>
      </Pressable>
      {caption && <Text style={[styles.caption, { color: palette.textTertiary }]}>{caption}</Text>}
      {copied && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: palette.accent, fontFamily: font.body }}
        >
          Copied
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { width: '100%', marginVertical: 3 },
  bubble: {
    maxWidth: '82%',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
  },
  fold: { maxHeight: 40 * 23, overflow: 'hidden' },
  fade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 56 },
  showAll: { minHeight: 48, justifyContent: 'center' },
  time: { fontFamily: font.mono, fontSize: 11, alignSelf: 'flex-end', marginTop: 5 },
  caption: { fontFamily: font.mono, fontSize: 11, marginTop: 3 },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 },
  voiceTime: { fontFamily: font.mono, fontSize: 12 },
});
