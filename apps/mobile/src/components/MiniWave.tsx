import { useEffect } from 'react';
import Svg, { Rect } from 'react-native-svg';
import Animated, {
  useAnimatedProps,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

const AnimatedRect = Animated.createAnimatedComponent(Rect);

interface Props {
  size: number;
  color: string;
  active: boolean;
}

function Bar({
  index,
  color,
  time,
  moving,
}: {
  index: number;
  color: string;
  time: SharedValue<number>;
  moving: boolean;
}) {
  const animatedProps = useAnimatedProps(() => {
    const height = moving
      ? 6 + Math.abs(Math.sin(time.value * 6 + index)) * 14
      : 6 + Math.abs(Math.sin(index)) * 6;
    return { y: (26 - height) / 2, height };
  });
  return (
    <AnimatedRect x={index * 6 + 1} width={3} rx={1.5} fill={color} animatedProps={animatedProps} />
  );
}

export function MiniWave({ size, color, active }: Props) {
  const reducedMotion = useReducedMotion();
  const moving = active && !reducedMotion;
  const time = useSharedValue(0);
  const frameCallback = useFrameCallback((frame) => {
    time.value = (frame.timeSinceFirstFrame ?? 0) / 1000;
  }, false);
  useEffect(() => {
    frameCallback.setActive(moving);
  }, [frameCallback, moving]);
  return (
    <Svg width={size} height={(size * 26) / 30} viewBox="0 0 30 26" accessible={false}>
      {Array.from({ length: 5 }, (_, index) => (
        <Bar key={index} index={index} color={color} time={time} moving={moving} />
      ))}
    </Svg>
  );
}
