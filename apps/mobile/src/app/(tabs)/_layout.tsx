import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';

import { totalUnread } from '@/agents/order';
import { Icon, type IconName } from '@/components/Icon';
import { useChatList } from '@/threads/chats';
import { usePalette } from '@/theme/tokens';

export default function TabsLayout() {
  const palette = usePalette();
  const { threads } = useChatList();
  const unread = totalUnread(threads);
  const icon = (name: IconName) =>
    function TabIcon({ color, size }: { color: ColorValue; size: number }) {
      return <Icon name={name} color={String(color)} size={size} />;
    };

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: true,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textSecondary,
        tabBarStyle: { backgroundColor: palette.background, borderTopColor: palette.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Agents', tabBarIcon: icon('agents') }} />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chats',
          tabBarIcon: icon('chat'),
          tabBarBadge: unread > 0 ? unread : undefined,
        }}
      />
      <Tabs.Screen name="history" options={{ title: 'Recents', tabBarIcon: icon('history') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings') }} />
    </Tabs>
  );
}
