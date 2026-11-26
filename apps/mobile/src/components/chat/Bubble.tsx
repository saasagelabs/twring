import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { font } from '@/theme/fonts';
import { usePalette, radius, type } from '@/theme/tokens';
import { FOLD_HEIGHT, shouldFold } from '@/threads/presentation';
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
  quote,
  copied,
  actions,
  onAction,
  onLongPress,
  muted,
  children,
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
  /** The message this one answers: who wrote it ("You" or the agent's name) and its text. */
  quote?: { from: string; text: string };
  /** Shows a short "Copied" note under the bubble. */
  copied?: boolean;
  /** The long-press choices, offered to screen readers as actions too. */
  actions?: { name: string; label: string }[];
  onAction?: (name: string) => void;
  onLongPress?: () => void;
  /** A private message this phone could not open: a plain line, never rendered as markdown. */
  muted?: boolean;
  /** A private message's photos and files, drawn above the text (`SealedAttachments`). */
  children?: ReactNode;
}) {
  const palette = usePalette();
  const [all, setAll] = useState(false);
  const [height, setHeight] = useState(0);
  const folded = shouldFold(height) && !all;
  return (
    <View style={[styles.wrap, { alignItems: own ? 'flex-end' : 'flex-start' }]}>
      <Pressable
        accessible={!attachments?.length && !pendingFiles?.length && !children}
        accessibilityLabel={`${sender}, ${time}: ${quote ? `replying to ${quote.from}, ` : ''}${text}`}
        accessibilityActions={actions}
        onAccessibilityAction={(event) => onAction?.(event.nativeEvent.actionName)}
        onLongPress={onLongPress}
        style={[
          styles.bubble,
          {
            backgroundColor: own ? palette.accentTintStrong : palette.surface,
            borderColor: own ? palette.borderAccent : palette.border,
            borderBottomRightRadius: own ? 6 : 18,
            borderBottomLeftRadius: own ? 18 : 6,
          },
        ]}
      >
        {quote && (
          <View
            testID="bubble-quote"
            style={[styles.quote, { borderLeftColor: palette.accent }]}
            importantForAccessibility="no-hide-descendants"
          >
            <Text numberOfLines={1} style={[styles.quoteFrom, { color: palette.accent }]}>
              {quote.from}
            </Text>
            <Text numberOfLines={2} style={[styles.quoteText, { color: palette.textSecondary }]}>
              {quote.text}
            </Text>
          </View>
        )}
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
        {children}
        {!!text && muted && (
          <Text style={[styles.muted, { color: palette.textSecondary, fontStyle: 'italic' }]}>
            {text}
          </Text>
        )}
        {!!text && !muted && (
          // Clipped until Show all, so a tall message never flashes full height before it is
          // measured; the inner view keeps its full height, which decides the fold.
          <View style={all ? undefined : styles.fold}>
            <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
              <MessageText text={text} onLink={onLink} />
            </View>
            {folded && (
              <LinearGradient
                pointerEvents="none"
                colors={['transparent', own ? '#07303A' : palette.sheet]}
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
    borderRadius: radius.lg,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
  },
  fold: { maxHeight: FOLD_HEIGHT, overflow: 'hidden' },
  fade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 56 },
  showAll: { minHeight: 48, justifyContent: 'center' },
  time: {
    fontFamily: font.mono,
    fontSize: type.microLabel.fontSize,
    alignSelf: 'flex-end',
    marginTop: 5,
  },
  caption: { fontFamily: font.mono, fontSize: type.microLabel.fontSize, marginTop: 3 },
  quote: { borderLeftWidth: 3, paddingLeft: 8, marginBottom: 6 },
  quoteFrom: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
  quoteText: { fontFamily: font.body, fontSize: type.caption.fontSize },
  muted: { fontFamily: font.body, fontSize: type.body.fontSize },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 },
  voiceTime: { fontFamily: font.mono, fontSize: type.caption.fontSize },
});
