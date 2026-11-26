---
name: twring-patched-deps
description: The pnpm patches Twring carries on livekit-client and react-native-reanimated. Use when upgrading, debugging or editing either package, or when adding, changing or removing a pnpm patch.
---

# Patched dependencies

`patchedDependencies` in the pnpm workspace config lists each patch and the exact version it applies to. Each patch has a test among the mobile app's scripts: `git ls-files '*patch.test.mjs'`.

- **livekit-client:** Metro bundles only its ESM build, so patch only that file. Upgrading livekit-client means checking upstream for each fix and remaking the patch.
- **react-native-reanimated:** patched for software-mansion/react-native-reanimated#10435 until the app is on 4.8 or newer. An upgrade means checking upstream and remaking or dropping the patch.
