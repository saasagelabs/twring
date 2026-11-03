import { useId, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import Svg, { Defs, FeGaussianBlur, Filter, G, Path } from 'react-native-svg';

import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

const MARK_PATH = 'M 50 33 L 68 15 L 86 33 L 68 51 L 50 33 L 32 15 L 14 33 L 32 51 Z';

/**
 * Voca's neon glow (CSS drop-shadows of 4/10/20px at 100/60/33%) as blurred copies of the
 * strokes. Blur sizes are screen pixels, so the glow looks the same at every size; the extra
 * room it needs sits outside the layout box (negative margin), so a glowing mark takes the same
 * space as a plain one.
 */
const GLOW_LAYERS = [
  { blurPx: 2, opacity: 0.9, widen: 1 },
  { blurPx: 5, opacity: 0.7, widen: 1.6 },
  { blurPx: 10, opacity: 0.45, widen: 2.2 },
] as const;
const GLOW_PAD_PX = 30;

function Glowing({
  width,
  height,
  unitsPerPx,
  glow,
  draw,
  label,
}: {
  /** Visual size in pixels, without the glow. */
  width: number;
  height: number;
  /** viewBox units per screen pixel. */
  unitsPerPx: number;
  glow: boolean;
  /** Draws the strokes; for a glow copy, `opacity` and `widen` are set and the caller blurs it. */
  draw: (glowLayer?: { opacity: number; widen: number }) => ReactNode;
  label?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const pad = glow ? GLOW_PAD_PX : 0;
  const padUnits = pad * unitsPerPx;
  const a11y = label
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label }
    : { accessible: false };
  return (
    <View style={{ width, height }} {...a11y}>
      <Svg
        width={width + pad * 2}
        height={height + pad * 2}
        style={{ margin: -pad }}
        viewBox={`${-padUnits} ${-padUnits} ${width * unitsPerPx + padUnits * 2} ${height * unitsPerPx + padUnits * 2}`}
      >
        {glow && (
          <Defs>
            {GLOW_LAYERS.map((layer, index) => (
              <Filter
                key={index}
                id={`${id}g${index}`}
                // Android ignores userSpaceOnUse regions; a generous bounding-box region
                // keeps the blur from being cut at the default 10% margin.
                x="-100%"
                y="-200%"
                width="300%"
                height="500%"
              >
                <FeGaussianBlur stdDeviation={layer.blurPx * unitsPerPx} />
              </Filter>
            ))}
          </Defs>
        )}
        {glow &&
          GLOW_LAYERS.map((layer, index) => (
            <G key={index} filter={`url(#${id}g${index})`}>
              {draw({ opacity: layer.opacity, widen: layer.widen })}
            </G>
          ))}
        {draw()}
      </Svg>
    </View>
  );
}

export function TwringMark({
  size = 32,
  color,
  glow = true,
  stroke = 3,
}: {
  size?: number;
  color?: string;
  glow?: boolean;
  stroke?: number;
}) {
  const palette = usePalette();
  const ink = color ?? palette.accent;
  return (
    <Glowing
      width={size}
      height={size * 0.66}
      unitsPerPx={100 / size}
      glow={glow}
      draw={(layer) => (
        <Path
          d={MARK_PATH}
          fill="none"
          stroke={ink}
          strokeWidth={stroke * (layer?.widen ?? 1)}
          strokeOpacity={layer?.opacity ?? 1}
          strokeLinecap="square"
          strokeLinejoin="miter"
          strokeMiterlimit={10}
        />
      )}
    />
  );
}

/**
 * The wordmark: "twring" set in Manrope ExtraLight, Voca's wordmark face (weight 200, -0.02em),
 * so every letter comes from one typeface. `glow` adds Voca's cyan neon as a text shadow.
 */
export function TwringWordmark({
  size = 28,
  color = '#fff',
  glow = false,
}: {
  size?: number;
  color?: string;
  glow?: boolean;
}) {
  const palette = usePalette();
  const glowRadius = Math.max(6, size * 0.45);
  return (
    <Text
      accessibilityRole="image"
      accessibilityLabel="Twring"
      allowFontScaling={false}
      style={{
        // Android clips a text shadow to the text's box: give the glow room to bleed, then
        // take that room back so the layout size is unchanged.
        ...(glow && { padding: glowRadius, margin: -glowRadius }),
        fontFamily: font.display,
        fontSize: size,
        lineHeight: Math.round(size * 1.25),
        letterSpacing: -0.02 * size,
        color,
        includeFontPadding: false,
        ...(glow && {
          textShadowColor: palette.accent,
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: glowRadius,
        }),
      }}
    >
      twring
    </Text>
  );
}

export function TwringLockup({ size = 28 }: { size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 0.4 * size }}>
      <TwringMark size={size * 1.25} stroke={3.2} />
      <TwringWordmark size={size} />
    </View>
  );
}
