import type { CallTranscript as Transcript } from '@twring/contracts';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { TextButton } from '@/components/TextButton';
import { font } from '@/theme/fonts';
import { radius, type, usePalette } from '@/theme/tokens';

/** Lines a collapsed transcript shows. */
export const COLLAPSED_LINES = 2;

export interface TranscriptRow {
  key: string;
  who: string;
  text: string;
}

/** The lines to show, labelled "You" or the agent's name; a cut answer says it was interrupted. */
export function transcriptRows(
  transcript: Transcript,
  agentName: string,
  expanded: boolean,
): TranscriptRow[] {
  const lines = expanded ? transcript.lines : transcript.lines.slice(0, COLLAPSED_LINES);
  return lines.map((line, index) => ({
    key: String(index),
    who: line.who === 'you' ? 'You' : agentName,
    text: line.cut === true ? `${line.text} (interrupted)` : line.text,
  }));
}

/** A call's transcript under its card; the toggle is the parent's. */
export function CallTranscriptView({
  transcript,
  name,
  expanded,
  onToggle,
}: {
  transcript: Transcript;
  name: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const palette = usePalette();
  const rows = transcriptRows(transcript, name, expanded);
  const more = transcript.lines.length > COLLAPSED_LINES || transcript.truncated === true;
  return (
    <View style={[styles.box, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      {rows.map((row) => (
        <View key={row.key} accessible accessibilityLabel={`${row.who}: ${row.text}`}>
          <Text style={[styles.who, { color: palette.textTertiary }]}>{row.who}</Text>
          <Text selectable style={[type.body, { color: palette.textPrimary }]}>
            {row.text}
          </Text>
        </View>
      ))}
      {expanded && transcript.truncated === true && (
        <Text style={[type.caption, { color: palette.textSecondary }]}>
          The rest of this call is not in the transcript.
        </Text>
      )}
      {more && (
        <View style={styles.toggle}>
          <TextButton
            label={expanded ? 'Hide transcript' : 'Show transcript'}
            expanded={expanded}
            onPress={onToggle}
          />
        </View>
      )}
    </View>
  );
}

/** A call's transcript under its card: the first lines, with "Show transcript" for the rest. */
export function CallTranscript({ transcript, name }: { transcript: Transcript; name: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <CallTranscriptView
      transcript={transcript}
      name={name}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}

const styles = StyleSheet.create({
  box: {
    alignSelf: 'stretch',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
    marginHorizontal: 8,
    marginBottom: 4,
  },
  who: { fontFamily: font.interMedium, fontSize: type.microLabel.fontSize, marginBottom: 2 },
  toggle: { alignItems: 'flex-start' },
});
