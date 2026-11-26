This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed: do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt: an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Rules

Never use em dashes (U+2014) in any text: use a colon, comma, parentheses or a new sentence. `pnpm lint` fails on them.

- Add or upgrade dependencies with `npx expo install <package>`, never `pnpm add`: it resolves SDK-compatible versions. `npx expo install --fix` repairs incompatible ones.
- Run the repo's lint and this package's typecheck and tests before declaring any task done.
- Use **Expo Router** for all navigation (`Link`, `router`, `useLocalSearchParams` from `expo-router`). Every file in the Expo Router routes folder (`src/app`, the Expo Router default when a `src` folder exists) is a screen and `_layout.tsx` files define navigators, so keep components, hooks and utils out of it. Docs: https://docs.expo.dev/router/introduction.md
- The `ios/` and `android/` folders are generated (Continuous Native Generation). Never create or edit them by hand: configure native behavior in the app config and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build (`npx expo run:android` or `npx expo run:ios`).
- Release builds do not use EAS Build, Submit or Update: they come from this repo's GitHub Actions workflows and release scripts. Do not add EAS steps.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
