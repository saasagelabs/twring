import { Fragment, useEffect } from 'react';
import Svg, { Line, Path } from 'react-native-svg';
import Animated, {
  useAnimatedProps,
  useAnimatedReaction,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { wavePath } from '@/theme/wave';

const AnimatedPath = Animated.createAnimatedComponent(Path);

interface Props {
  color: string;
  intensity: SharedValue<number> | number;
  width: number;
  height: number;
  layers?: number;
  animated?: boolean;
  mode?: 'live' | 'frozen' | 'flat';
}

interface LayerProps {
  width: number;
  height: number;
  phase: number;
  ampMul: number;
  freqMul: number;
  color: string;
  opacity: number;
  strokeWidth: number;
  time: SharedValue<number>;
  level: SharedValue<number>;
  target: SharedValue<number> | number;
  moving: boolean;
  flat: boolean;
}

function WaveLayer({
  width,
  height,
  phase,
  ampMul,
  freqMul,
  color,
  opacity,
  strokeWidth,
  time,
  level,
  target,
  moving,
  flat,
}: LayerProps) {
  const animatedProps = useAnimatedProps(() => ({
    d: wavePath({
      width,
      height,
      time: time.value,
      intensity: flat
        ? 0
        : moving
          ? level.value
          : typeof target === 'number'
            ? target
            : target.value,
      phase,
      ampMul,
      freqMul,
    }),
  }));
  return (
    <AnimatedPath
      animatedProps={animatedProps}
      fill="none"
      stroke={color}
      strokeOpacity={opacity}
      strokeWidth={strokeWidth}
    />
  );
}

/** Layered Voca waveform. Frame updates and path construction stay on the UI thread. */
export function Waveform({
  color,
  intensity,
  width,
  height,
  layers = 5,
  animated = true,
  mode = 'live',
}: Props) {
  const reducedMotion = useReducedMotion();
  const moving = animated && !reducedMotion && mode === 'live';
  const time = useSharedValue(0);
  const level = useSharedValue(typeof intensity === 'number' ? intensity : 0);

  const frameCallback = useFrameCallback((frame) => {
    time.value += (frame.timeSincePreviousFrame ?? 0) / 1000;
  }, false);

  useEffect(() => {
    frameCallback.setActive(moving);
  }, [frameCallback, moving]);

  useAnimatedReaction(
    () => (typeof intensity === 'number' ? intensity : intensity.value),
    (target) => {
      level.value = moving ? withTiming(target, { duration: 120 }) : target;
    },
    [intensity, moving],
  );

  const count = Math.max(1, Math.min(5, Math.floor(layers)));
  return (
    <Svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      opacity={mode === 'frozen' && !reducedMotion ? 0.45 : 1}
      accessible={false}
    >
      <Line
        x1={0}
        x2={width}
        y1={height / 2}
        y2={height / 2}
        stroke={color}
        strokeOpacity={0.12}
        strokeWidth={4}
      />
      <Line
        x1={0}
        x2={width}
        y1={height / 2}
        y2={height / 2}
        stroke={color}
        strokeOpacity={0.4}
        strokeWidth={1}
      />
      {Array.from({ length: count }, (_, i) => {
        const last = i === count - 1;
        const shared = {
          width,
          height,
          phase: i * 0.7,
          ampMul: 0.5 + (i / count) * 0.6,
          freqMul: 0.7 + i * 0.18,
          color,
          time,
          level,
          target: intensity,
          moving,
          flat: mode === 'flat',
        };
        return (
          <Fragment key={i}>
            {last && <WaveLayer {...shared} opacity={0.18} strokeWidth={6} />}
            <WaveLayer {...shared} opacity={last ? 0.6 : 0.28} strokeWidth={last ? 1.6 : 1} />
          </Fragment>
        );
      })}
      <WaveLayer
        width={width}
        height={height}
        phase={0}
        ampMul={1}
        freqMul={1}
        color="#FFFFFF"
        opacity={0.92}
        strokeWidth={1.4}
        time={time}
        level={level}
        target={intensity}
        moving={moving}
        flat={mode === 'flat'}
      />
    </Svg>
  );
}
