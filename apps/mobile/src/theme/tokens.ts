import { font } from './fonts';

/** Design tokens (docs/DESIGN_SYSTEM.md §3–4). Feature code uses these, never raw values. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { xs: 10, sm: 12, md: 14, lg: 18, xl: 22, xxl: 28, pill: 999 } as const;

export const type = {
  display: { fontFamily: font.display, fontSize: 34, letterSpacing: -1.2 },
  title: { fontFamily: font.title, fontSize: 24, letterSpacing: -0.6 },
  headline: { fontFamily: font.headline, fontSize: 19, letterSpacing: -0.3 },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 22 },
  bodyEmphasis: { fontFamily: font.bodyEmphasis, fontSize: 15, lineHeight: 22 },
  caption: { fontFamily: font.caption, fontSize: 13 },
  mono: { fontFamily: font.mono, fontSize: 13, letterSpacing: 0.5 },
  microLabel: { fontFamily: font.microLabel, fontSize: 11, letterSpacing: 1.4 },
} as const;

export interface Palette {
  background: string;
  surface: string;
  /** Cards and controls that sit on a surface (call controls, grouped rows). */
  surfaceRaised: string;
  /** Dark sheet behind raised content. */
  sheet: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  /** Higher-contrast hairline for emphasized edges. */
  borderStrong: string;
  /** Cyan hairline for active edges. */
  borderAccent: string;
  accent: string;
  /** Brighter cyan for glow highlights. */
  accentBright: string;
  /** Dimmer cyan for subdued accents. */
  accentDim: string;
  /** Low-emphasis supporting text. */
  textTertiary: string;
  /** Faint text for the quietest labels. */
  textMuted: string;
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
  onDanger: string;
  listening: string;
  reconnecting: string;
  /** The caller has the floor. */
  userSpeaking: string;
  /** The agent's voice: distinct from accent so "who is talking" reads at a glance. */
  speaking: string;
  /** The agent is thinking or acting: quiet, never mistaken for speech. */
  working: string;
}

const dark: Palette = {
  background: '#000000',
  surface: 'rgba(255,255,255,0.04)',
  surfaceRaised: 'rgba(255,255,255,0.07)',
  sheet: '#0A0C10',
  textPrimary: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.62)',
  textTertiary: 'rgba(255,255,255,0.42)',
  textMuted: 'rgba(255,255,255,0.28)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.14)',
  borderAccent: 'rgba(25,214,242,0.35)',
  accent: '#19D6F2',
  accentBright: '#5FF2FF',
  accentDim: '#0A8AAA',
  onAccent: '#001620',
  success: '#19D6F2',
  warning: '#FFB547',
  danger: '#FF4D5E',
  onDanger: '#FFFFFF',
  listening: '#19D6F2',
  reconnecting: '#FFB547',
  userSpeaking: '#19D6F2',
  speaking: '#E8EAEE',
  working: 'rgba(255,255,255,0.42)',
};

/** The call screen shares the app's dark palette. */
export const callPalette: Palette = dark;

export function usePalette(): Palette {
  return dark;
}
