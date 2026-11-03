import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { approvalCountdown, approvalPhrase } from '../call/approval';
import type { CallView } from '../call/controller';
import { playApprovalFeedback } from '../platform/haptics';
import { callPalette as palette, radius, space, type } from '../theme/tokens';

import { GhostButton } from './GhostButton';
import { PrimaryButton } from './PrimaryButton';
import { Sheet } from './Sheet';
import { StatusDot } from './StatusDot';

/** Keep the text intact for the details sheet even when the card preview is clipped. */
export function approvalDetails(approval: NonNullable<CallView['approval']>) {
  return {
    title: approval.title,
    description: approval.description,
    showDetails: approval.title !== '' || approval.description !== undefined,
  };
}

export function ApprovalCard({
  approval,
  error,
  onDecision,
}: {
  approval: NonNullable<CallView['approval']>;
  error?: boolean;
  onDecision: (decision: 'approve' | 'deny') => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    playApprovalFeedback();
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [approval.id]);

  const phrase = approvalPhrase(approval.action);
  const details = approvalDetails(approval);
  const decide = (decision: 'approve' | 'deny') => {
    setDetailsOpen(false);
    onDecision(decision);
  };
  const actions = () => (
    <View style={styles.buttons}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`Allow ${phrase}`}
        onAccessibilityTap={() => decide('approve')}
        style={styles.button}
      >
        <PrimaryButton label="Allow" onPress={() => decide('approve')} />
      </View>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`Deny ${phrase}`}
        onAccessibilityTap={() => decide('deny')}
        style={styles.button}
      >
        <GhostButton label="Deny" onPress={() => decide('deny')} />
      </View>
    </View>
  );
  const countdown = () => (
    <Text style={[type.mono, styles.footer]}>
      {`Say yes or no, or tap · ${approvalCountdown(approval.expiresAt, now)} left`}
    </Text>
  );
  return (
    <>
      <View accessibilityLiveRegion="polite" style={styles.card}>
        <View style={styles.eyebrow}>
          <StatusDot color={palette.accent} pulse />
          <Text style={[type.microLabel, styles.eyebrowText]}>NEEDS YOUR OK</Text>
        </View>
        <Text style={[type.title, styles.title]}>
          {approval.agentName} wants to {phrase}
        </Text>
        <Text
          numberOfLines={3}
          ellipsizeMode="tail"
          style={[type.body, { color: palette.textSecondary }]}
        >
          {details.title}
        </Text>
        {details.description !== undefined && (
          <Text
            numberOfLines={3}
            ellipsizeMode="tail"
            style={[type.body, { color: palette.textSecondary }]}
          >
            {details.description}
          </Text>
        )}
        {details.showDetails && (
          <GhostButton label="View details" onPress={() => setDetailsOpen(true)} />
        )}
        {actions()}
        {countdown()}
        {error && (
          <Text accessibilityRole="alert" style={[type.caption, { color: palette.danger }]}>
            Couldn't send. Try again or say yes or no.
          </Text>
        )}
      </View>
      <Sheet visible={detailsOpen} title="Approval details" onClose={() => setDetailsOpen(false)}>
        <View style={styles.details}>
          <Text accessibilityRole="header" style={[type.title, styles.title]}>
            {approval.agentName} wants to {phrase}
          </Text>
          <Text selectable style={[type.body, styles.detailText]}>
            {details.title}
          </Text>
          {details.description !== undefined && (
            <Text selectable style={[type.mono, styles.detailText]}>
              {details.description}
            </Text>
          )}
          {actions()}
          {countdown()}
          {error && (
            <Text accessibilityRole="alert" style={[type.caption, { color: palette.danger }]}>
              Couldn't send. Try again or say yes or no.
            </Text>
          )}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    gap: space.md,
    padding: 20,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: palette.borderAccent,
    backgroundColor: 'rgba(10,12,16,0.82)',
    boxShadow: '0 0 32px rgba(25,214,242,0.2)',
  },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eyebrowText: { color: palette.accent, letterSpacing: 1.6 },
  title: { color: palette.textPrimary, fontSize: 22 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  button: { flexGrow: 1, minWidth: 120 },
  footer: { color: palette.textTertiary, fontSize: 12, textAlign: 'center' },
  details: { gap: space.md, paddingBottom: space.lg },
  detailText: { color: palette.textSecondary, flexShrink: 1, flexWrap: 'wrap' },
});
