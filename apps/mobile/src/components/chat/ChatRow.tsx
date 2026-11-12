import type { Agent, ThreadSummary } from '@twring/contracts';
import { isAiApp } from '@/agents/ai-app';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { font } from '@/theme/fonts';
import { usePalette, radius, type } from '@/theme/tokens';
import { agentRowLine, rowLine, rowTime } from '@/threads/presentation';

export function ChatRow({
  agent,
  thread,
  chatsOff = false,
  onPress,
}: {
  agent: Agent;
  thread?: ThreadSummary;
  /** The server has chats off: the row is for calling, so it never offers a chat. */
  chatsOff?: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const offline = agent.connector_online === false || agent.connector_removed === true;
  const aiApp = isAiApp(agent);
  const { text: line, tone } = chatsOff
    ? { text: agentRowLine(offline), tone: 'normal' as const }
    : rowLine(thread?.last_message);
  const time = rowTime(thread?.last_message_at ?? agent.updated_at);
  const unread = thread?.unread ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}, ${aiApp ? 'AI app' : offline ? 'offline' : 'online'}, ${unread} unread, ${line}, ${time}`}
      onPress={onPress}
      style={[styles.row, { borderColor: palette.border }]}
    >
      <Avatar
        id={agent.id}
        name={agent.name}
        avatarVersion={agent.avatar_version}
        size={48}
        online={aiApp ? undefined : !offline}
      />
      <View style={styles.main}>
        <View style={styles.first}>
          <Text
            numberOfLines={1}
            style={[styles.name, { color: offline ? palette.textSecondary : palette.textPrimary }]}
          >
            {agent.name}
          </Text>
          <Text style={[styles.time, { color: unread ? palette.accent : palette.textTertiary }]}>
            {time}
          </Text>
        </View>
        <View style={styles.second}>
          <Text
            numberOfLines={1}
            style={[
              styles.preview,
              {
                color:
                  line === 'Working…'
                    ? palette.accent
                    : tone === 'accent'
                      ? palette.accent
                      : tone === 'danger'
                        ? palette.danger
                        : palette.textSecondary,
                fontStyle: line === 'Working…' ? 'italic' : 'normal',
              },
            ]}
          >
            {line}
          </Text>
          {unread > 0 && (
            <View style={[styles.badge, { backgroundColor: palette.accent }]}>
              <Text style={[styles.badgeText, { color: palette.onAccent }]}>{unread}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  row: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  main: { flex: 1, gap: 4 },
  first: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontFamily: font.interMedium, fontSize: type.body.fontSize },
  time: { fontFamily: font.body, fontSize: type.caption.fontSize },
  second: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  preview: { flex: 1, fontFamily: font.body, fontSize: type.body.fontSize },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { fontFamily: font.mono, fontSize: type.microLabel.fontSize },
});
