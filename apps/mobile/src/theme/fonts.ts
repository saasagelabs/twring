import {
  Manrope_200ExtraLight,
  Manrope_300Light,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
} from '@expo-google-fonts/manrope';
import {
  Inter_300Light,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';

export const FONT_ASSETS = {
  Manrope_200ExtraLight,
  Manrope_300Light,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Inter_300Light,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} as const;

export const font = {
  display: 'Manrope_200ExtraLight',
  title: 'Manrope_300Light',
  headline: 'Manrope_400Regular',
  body: 'Inter_400Regular',
  bodyEmphasis: 'Inter_600SemiBold',
  caption: 'Inter_400Regular',
  mono: 'JetBrainsMono_500Medium',
  microLabel: 'Inter_600SemiBold',
  manropeMedium: 'Manrope_500Medium',
  manropeSemiBold: 'Manrope_600SemiBold',
  interLight: 'Inter_300Light',
  interMedium: 'Inter_500Medium',
  monoRegular: 'JetBrainsMono_400Regular',
} as const;
