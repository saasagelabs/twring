import type { AgentProtocol } from '@twring/contracts';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OFFLINE_HELP_TITLE, offlineHelpSteps } from '@/agents/offline-help';
import { TextButton } from '@/components/TextButton';
import { space, type } from '@/theme/tokens';

interface Props {
  protocol: AgentProtocol;
  /** The steps' color: the call screen is always dark, other screens follow the theme. */
  color: string;
  align?: 'left' | 'center';
}

/** "How to bring it back", closed by default so an offline screen stays calm. */
export function OfflineHelp({ protocol, color, align = 'left' }: Props) {
  const [open, setOpen] = useState(false);
  const steps = offlineHelpSteps(protocol);
  return (
    <View style={[styles.container, align === 'center' && styles.center]}>
      <TextButton label={OFFLINE_HELP_TITLE} expanded={open} onPress={() => setOpen(!open)} />
      {open && (
        <View style={styles.steps}>
          {steps.map((step, index) => (
            <Text
              key={step}
              accessibilityLabel={`Step ${index + 1} of ${steps.length}: ${step}`}
              style={[type.body, { color, textAlign: align }]}
            >{`${index + 1}. ${step}`}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  center: { alignItems: 'center' },
  steps: { gap: space.xs, paddingHorizontal: space.sm },
});
