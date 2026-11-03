import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';

export const iconNames = [
  'back',
  'chev',
  'chevDown',
  'check',
  'x',
  'add',
  'history',
  'agents',
  'chat',
  'settings',
  'sliders',
  'mic',
  'micOff',
  'volume',
  'phone',
  'phoneDown',
  'phoneMissed',
  'headset',
  'bluetooth',
  'computer',
  'globe',
  'copy',
  'share',
  'play',
  'stop',
  'send',
  'info',
  'pencil',
] as const;

export type IconName = (typeof iconNames)[number];

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 24, color = '#FFFFFF', strokeWidth = 1.6 }: Props) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
    >
      {name === 'back' && <Path d="M19 12H5m7 7-7-7 7-7" />}
      {name === 'chev' && <Path d="m9 18 6-6-6-6" />}
      {name === 'chevDown' && <Path d="m6 9 6 6 6-6" />}
      {name === 'check' && <Path d="m5 12 4 4L19 6" />}
      {name === 'x' && <Path d="M18 6 6 18M6 6l12 12" />}
      {name === 'add' && <Path d="M12 5v14M5 12h14" />}
      {name === 'history' && (
        <>
          <Path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
          <Path d="M3 3v5h5M12 7v5l3 2" />
        </>
      )}
      {name === 'agents' && (
        <>
          <Circle cx="9" cy="8" r="3" />
          <Path d="M3 20v-2a6 6 0 0 1 12 0v2H3Zm13-15a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5h-4" />
        </>
      )}
      {name === 'chat' && (
        <Path d="M20 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.5-.7L3 21l1.7-5A8.5 8.5 0 1 1 20 11.5Z" />
      )}
      {name === 'settings' && (
        <>
          <Path d="M10.3 2h3.4l.6 2.1a8 8 0 0 1 1.7.7l1.9-1 2.4 2.4-1 1.9a8 8 0 0 1 .7 1.7l2 .6v3.4l-2 .6a8 8 0 0 1-.7 1.7l1 1.9-2.4 2.4-1.9-1a8 8 0 0 1-1.7.7l-.6 2.1h-3.4l-.6-2.1a8 8 0 0 1-1.7-.7l-1.9 1-2.4-2.4 1-1.9a8 8 0 0 1-.7-1.7l-2-.6v-3.4l2-.6a8 8 0 0 1 .7-1.7l-1-1.9 2.4-2.4 1.9 1a8 8 0 0 1 1.7-.7z" />
          <Circle cx="12" cy="12" r="3" />
        </>
      )}
      {name === 'sliders' && (
        <>
          <Line x1="4" y1="7" x2="20" y2="7" />
          <Line x1="4" y1="17" x2="20" y2="17" />
          <Circle cx="9" cy="7" r="2" fill="#000000" />
          <Circle cx="16" cy="17" r="2" fill="#000000" />
        </>
      )}
      {name === 'mic' && (
        <>
          <Rect x="9" y="2" width="6" height="12" rx="3" />
          <Path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" />
        </>
      )}
      {name === 'micOff' && (
        <>
          <Path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-6-.1M5 10a7 7 0 0 0 12 5M19 10a7 7 0 0 1-.7 3.1M12 17v5m-4 0h8M3 3l18 18" />
        </>
      )}
      {name === 'volume' && (
        <>
          <Path d="M11 5 6 9H3v6h3l5 4V5ZM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" />
        </>
      )}
      {name === 'phone' && (
        <Path d="M5 3h4l1.5 4-2 2a16 16 0 0 0 6.5 6.5l2-2L21 15v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z" />
      )}
      {name === 'phoneDown' && (
        <Path d="M3 15a15 15 0 0 1 18 0l-2 4-4-1-.5-3a13 13 0 0 0-5 0L9 18l-4 1-2-4Z" />
      )}
      {name === 'phoneMissed' && (
        <Path d="M3 3h6v6M9 3 3 9m2 3 3 1-1 3a13 13 0 0 0 5 5l3-1 1 3a2 2 0 0 0 2 1h2a2 2 0 0 0 2-2 16 16 0 0 0-2-7" />
      )}
      {name === 'headset' && (
        <Path d="M3 13v-2a9 9 0 0 1 18 0v6a4 4 0 0 1-4 4h-4M3 13h4v7H5a2 2 0 0 1-2-2v-5Zm18 0h-4v7h2a2 2 0 0 0 2-2v-5Z" />
      )}
      {name === 'bluetooth' && <Path d="m7 7 10 10-5 4V3l5 4L7 17" />}
      {name === 'computer' && (
        <>
          <Rect x="3" y="4" width="18" height="14" rx="2" />
          <Path d="M8 22h8m-4-4v4" />
        </>
      )}
      {name === 'globe' && (
        <>
          <Circle cx="12" cy="12" r="9" />
          <Path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
        </>
      )}
      {name === 'copy' && (
        <>
          <Rect x="8" y="8" width="13" height="13" rx="2" />
          <Path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </>
      )}
      {name === 'share' && (
        <>
          <Path d="M12 16V3m-5 5 5-5 5 5M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
        </>
      )}
      {name === 'play' && <Polyline points="8,5 19,12 8,19 8,5" fill={color} stroke="none" />}
      {name === 'stop' && <Rect x="6" y="6" width="12" height="12" rx="2" />}
      {name === 'send' && <Path d="m3 20 18-8L3 4l2 7 9 1-9 1-2 7Z" />}
      {name === 'info' && (
        <>
          <Circle cx="12" cy="12" r="9" />
          <Path d="M12 11v5m0-8h.01" />
        </>
      )}
      {name === 'pencil' && <Path d="m15 5 4 4M4 20l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Z" />}
    </Svg>
  );
}
