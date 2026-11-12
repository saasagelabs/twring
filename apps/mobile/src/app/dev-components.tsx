import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { TwringLockup, TwringMark, TwringWordmark } from '@/components/Brand';
import { CallControl } from '@/components/CallControl';
import { CallPill } from '@/components/CallPill';
import { ConnectionPill } from '@/components/ConnectionPill';
import { GhostButton } from '@/components/GhostButton';
import { Icon, iconNames } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { MiniWave } from '@/components/MiniWave';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { Skeleton } from '@/components/Skeleton';
import { StatusDot } from '@/components/StatusDot';
import { StatusPill } from '@/components/StatusPill';
import { Toggle } from '@/components/Toggle';
import { Waveform } from '@/components/Waveform';
import { font } from '@/theme/fonts';
import { usePalette, type } from '@/theme/tokens';

const levels = [0.18, 0.6, 1] as const;
const tones = ['you', 'agent', 'warning', 'neutral'] as const;

export default function ComponentsGallery() {
  const palette = usePalette();
  const [levelIndex, setLevelIndex] = useState(0);
  const [toggle, setToggle] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const level = levels[levelIndex];
  const noop = () => undefined;
  return (
    <Screen back title="Components">
      <Text style={styles.heading}>Brand</Text>
      <View style={styles.row}>
        <TwringMark size={120} />
        <TwringMark size={120} glow={false} />
        <TwringMark size={20} />
        <TwringMark size={20} glow={false} />
      </View>
      <View style={styles.stack}>
        <TwringWordmark size={36} />
        <TwringWordmark size={20} glow />
        <TwringLockup />
      </View>

      <Text style={styles.heading}>Icons</Text>
      <View style={styles.iconGrid}>
        {iconNames.map((name) => (
          <View key={name} style={styles.iconCell}>
            <Icon name={name} />
            <Text style={styles.caption}>{name}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.heading}>Waveforms</Text>
      <GhostButton
        label={`Cycle intensity · ${level}`}
        onPress={() => setLevelIndex((levelIndex + 1) % levels.length)}
      />
      {[palette.accent, palette.speaking].map((color) => (
        <View key={color} style={styles.stack}>
          <Text style={styles.caption}>{color === palette.accent ? 'Cyan' : 'Agent white'}</Text>
          {levels.map((intensity) => (
            <View key={intensity} style={styles.waveRow}>
              <Text style={styles.caption}>{intensity}</Text>
              <Waveform
                color={color}
                intensity={intensity}
                width={240}
                height={72}
                animated={false}
              />
            </View>
          ))}
          <Text style={styles.caption}>Cycling intensity: {level}</Text>
          <Waveform color={color} intensity={level} width={280} height={72} />
        </View>
      ))}
      <Text style={styles.caption}>Frozen</Text>
      <Waveform color={palette.accent} intensity={0.8} width={280} height={72} mode="frozen" />
      <Text style={styles.caption}>Flat</Text>
      <Waveform color={palette.accent} intensity={0.8} width={280} height={72} mode="flat" />

      <Text style={styles.heading}>MiniWave</Text>
      <View style={styles.row}>
        <MiniWave size={30} color={palette.accent} active />
        <MiniWave size={30} color={palette.speaking} active={false} />
      </View>

      <Text style={styles.heading}>StatusDot</Text>
      <View style={styles.row}>
        <StatusDot color={palette.accent} pulse />
        <StatusDot color={palette.warning} />
      </View>

      <Text style={styles.heading}>IconButton</Text>
      <View style={styles.row}>
        <IconButton icon="settings" accessibilityLabel="Settings example" onPress={noop} />
        <IconButton
          icon="mic"
          accessibilityLabel="Active microphone example"
          active
          onPress={noop}
        />
      </View>

      <Text style={styles.heading}>PrimaryButton</Text>
      <PrimaryButton label="Accent" onPress={noop} />
      <PrimaryButton label="Neutral" tone="neutral" onPress={noop} />
      <PrimaryButton label="Disabled" disabled onPress={noop} />

      <Text style={styles.heading}>GhostButton</Text>
      <GhostButton label="Normal" onPress={noop} />
      <GhostButton label="Accent" tone="accent" onPress={noop} />
      <GhostButton label="Danger" tone="danger" onPress={noop} />

      <Text style={styles.heading}>CallPill</Text>
      <View style={styles.row}>
        <CallPill onPress={noop} accessibilityLabel="Call example agent" />
        <CallPill onPress={noop} accessibilityLabel="Call offline agent" disabled />
      </View>

      <Text style={styles.heading}>CallControl</Text>
      <View style={styles.row}>
        <CallControl icon="mic" label="Mute" accessibilityLabel="Mute" onPress={noop} />
        <CallControl
          icon="micOff"
          label="Muted"
          accessibilityLabel="Unmute"
          variant="active"
          onPress={noop}
        />
        <CallControl icon="volume" label="Audio" accessibilityLabel="Audio output" onPress={noop} />
        <CallControl
          icon="phoneDown"
          label="End"
          accessibilityLabel="End call"
          variant="danger"
          onPress={noop}
        />
      </View>

      <Text style={styles.heading}>ConnectionPill</Text>
      <View style={styles.row}>
        <ConnectionPill tone="connecting" label="Connecting…" />
        <ConnectionPill tone="connected" label="Connected" />
        <ConnectionPill tone="reconnecting" label="Reconnecting…" />
      </View>

      <Text style={styles.heading}>StatusPill</Text>
      {tones.map((tone) => (
        <View key={tone} style={styles.row}>
          <StatusPill label={`${tone} active`} tone={tone} active />
          <StatusPill label={`${tone} idle`} tone={tone} active={false} />
        </View>
      ))}
      <StatusPill label="Working…" detail="Checking calendar…" tone="agent" active />
      <StatusPill label="You are muted" tone="muted" active={false} />

      <Text style={styles.heading}>Sheet</Text>
      <GhostButton label="Open sheet" onPress={() => setSheetVisible(true)} />
      <Sheet visible={sheetVisible} title="Audio output" onClose={() => setSheetVisible(false)}>
        <Text style={styles.caption}>Choose where to hear your agent.</Text>
      </Sheet>

      <Text style={styles.heading}>Skeleton</Text>
      <Skeleton height={64} />
      <Skeleton height={40} width={180} />

      <Text style={styles.heading}>Toggle</Text>
      <Toggle value={toggle} onValueChange={setToggle} accessibilityLabel="Gallery toggle" />

      <Text style={styles.heading}>Avatar</Text>
      <View style={styles.row}>
        <Avatar id="online" name="Online" online />
        <Avatar id="offline" name="Offline" online={false} />
        <Avatar id="unknown" name="Unknown" />
        <Avatar id="ringing" name="Ringing" size={96} ringing />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontFamily: font.headline,
    fontSize: type.headline.fontSize,
    color: '#FFFFFF',
    marginTop: 12,
  },
  caption: {
    fontFamily: font.caption,
    fontSize: type.caption.fontSize,
    color: 'rgba(255,255,255,0.62)',
  },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  iconCell: { width: 70, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 5 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16 },
  waveRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stack: { gap: 8 },
});
