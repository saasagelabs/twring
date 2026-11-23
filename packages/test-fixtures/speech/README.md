# Call proof speech corpus

`corpus.json` holds the lines the call proof (`pnpm --filter @twring/gateway call:proof`) says into a
real call, with the words that must come through (`keyTerms`). The proof plays each line in real
time through LiveKit to a gateway running real speech recognition and the `repeat` test agent, then
scores what the gateway heard: word error rate, key terms, turns committed per line, timings and one
barge-in. Each line is also played as a Bluetooth headset line, a noisy headset line and a quiet
caller.

## Audio

1. **Your own recordings** (preferred): set `CALL_PROOF_AUDIO_DIR` to a folder **outside this public
   repository** (for example in the private repo). Recordings are personal voice data: never commit
   them here.
2. **Synthesized voices** otherwise: lines with no recording are voiced by three Deepgram voices
   (`CALL_PROOF_VOICES` to change them) and cached in `apps/gateway/.call-proof/cache/`
   (git-ignored), so a rerun costs no synthesis.

## Recording the set

- One WAV file per line, named by the line's `id`: `u01-twring-hello.wav`, `u02-saasage.wav`, ...
- Mono (stereo is mixed down), 16-bit PCM, 48 kHz or 16 kHz (8, 12 and 24 kHz also work).
- Say the `text` naturally, as you would on a call, in a quiet room with your usual phone or
  headset microphone. Leading and trailing silence is trimmed.
- For `u28-long-pause`, pause for about a second after "and", as if thinking.
- Files directly in the folder are voice `owner`. To add other speakers, put their files in a
  subfolder each: `CALL_PROOF_AUDIO_DIR/ana/u01-twring-hello.wav` is voice `ana`.

## Running

```sh
pnpm --filter @twring/gateway build          # the proof starts dist/main.js
pnpm --filter @twring/gateway call:proof -- --estimate   # cost only
pnpm --filter @twring/gateway call:proof -- --quick      # 6 lines, one voice: after a deploy
pnpm --filter @twring/gateway call:proof                 # all lines, all voices, all conditions
```

It needs `DEEPGRAM_API_KEY` and LiveKit settings in `apps/gateway/.env` (or `--settings FILE`). It
refuses production settings. `CALL_PROOF_GATEWAY_URL` points it at a staging server running
`AUTH_MODE=dev` and `GATEWAY_AUDIO_TEST_MODE=repeat` instead of a local one.

The first run writes the baseline (`apps/gateway/.call-proof/baseline-full.json` or
`baseline-quick.json`); later runs fail (exit 1) when below the fixed limits (key-term recall 95%
clean, 85% narrowband; WER 8% clean, 15% narrowband; barge-in stop within 400 ms) or more than 3
points worse than the baseline. `--thresholds FILE` overrides limits, `--update-baseline` rewrites
the baseline. Every run's full results go to `apps/gateway/.call-proof/report-*.json`.

It never runs in pull-request CI: it needs provider keys and this repository is public. The
`Call proof` workflow (`.github/workflows/call-proof.yml`) is manual only.
