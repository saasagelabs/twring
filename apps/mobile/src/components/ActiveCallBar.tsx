import { router, usePathname } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { shouldShowCallBar } from '@/call/call-bar';
import { useCallView } from '@/call/session';
import { OnCallBanner } from '@/components/OnCallBanner';

export function ActiveCallBar() {
  const pathname = usePathname();
  const view = useCallView();
  if (!shouldShowCallBar(pathname, view.call)) return null;
  return (
    <SafeAreaView edges={['top']}>
      <OnCallBanner startedAt={view.connectedAt} onPress={() => router.push('/call')} />
    </SafeAreaView>
  );
}
