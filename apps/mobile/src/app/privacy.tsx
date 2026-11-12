import { StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { SUPPORT_EMAIL } from '@/privacy/account-deletion';
import { font } from '@/theme/fonts';
import { space, type, usePalette } from '@/theme/tokens';

/** Each block: a question a user would ask, answered in plain words (docs/PRIVACY.md). */
const SECTIONS: readonly { title: string; body: readonly string[] }[] = [
  {
    title: 'Your voice',
    body: [
      'While you are on a call, your voice streams to our speech provider (Deepgram) to turn it into text, and the reply streams back as speech.',
      'Twring never records or stores call audio.',
      'Voice-note audio is sent to Deepgram for transcription and is not kept by Twring. The transcript is kept as a chat message until you clear it.',
    ],
  },
  {
    title: 'Does Twring keep my chats?',
    body: [
      "Yes. The messages you type to an agent and its written replies are kept, encrypted, so you can read them later. Calls appear in a chat only as a card with their length; Twring keeps no call audio or transcript. Clear a chat from the agent's page, or delete all your data in Settings.",
    ],
  },
  {
    title: 'What you say',
    body: [
      'The text of what you say goes to your own agent, the one you connected, so it can answer. What your agent does with it is up to that agent.',
      'Twring does not keep call transcripts. Messages you type in a chat are kept (see “Does Twring keep my chats?”).',
    ],
  },
  {
    title: 'What Twring keeps',
    body: [
      'Your account: you sign in with Google, and our sign-in service (Supabase) keeps your email address and the name and picture Google shares. Twring never sees your Google password.',
      "Your agents' settings: name, address, voice, and the words to listen for.",
      "Each agent's key, encrypted. Twring shows it to no one, including you.",
      'For each computer you link: its name, the agents it found, and whether it is online.',
      'A short summary of each call: which agent, when, how long, how it ended, and usage counts. Only your last 200 calls are kept.',
    ],
  },
  {
    title: 'The camera',
    body: [
      'Twring uses the camera only to scan the code your computer shows when you link it. The picture stays on your phone and is never stored or sent.',
    ],
  },
  {
    title: 'Who processes it',
    body: [
      'Supabase handles sign-in. LiveKit carries the call audio. Deepgram turns speech into text. Deepgram or Cartesia, depending on the voice you pick, turns text into speech. Your own agent gets the text of what you say.',
    ],
  },
  {
    title: 'Deleting it',
    body: [
      'Delete an agent to remove its settings and key. Use Delete my data in Settings to remove everything Twring keeps for you at once.',
      'Use Delete account in Settings to delete your data and your sign-in account, then sign out.',
    ],
  },
  {
    title: 'Questions',
    body: ['Twring is run by Gowrishankar Sivasankaran.', `Write to ${SUPPORT_EMAIL}.`],
  },
];

/** Settings → Privacy: what Twring processes and keeps, in plain words. */
export default function PrivacyScreen() {
  const palette = usePalette();
  return (
    <Screen back title="Privacy">
      {SECTIONS.map((section, index) => (
        <View
          key={section.title}
          style={[
            styles.section,
            index > 0 && { borderColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth },
          ]}
        >
          <Text accessibilityRole="header" style={[styles.heading, { color: palette.textPrimary }]}>
            {section.title}
          </Text>
          {section.body.map((line) => (
            <Text key={line} style={[styles.body, { color: palette.textSecondary }]}>
              {line}
            </Text>
          ))}
        </View>
      ))}
      <Text style={[type.caption, { color: palette.textSecondary }]}>
        The full privacy notice is in the Twring privacy policy.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md, paddingVertical: space.lg },
  heading: { fontFamily: font.title, fontSize: type.title.fontSize, letterSpacing: -0.4 },
  body: { fontFamily: font.body, fontSize: type.body.fontSize, lineHeight: 24 },
});
