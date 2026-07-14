# Demo videos

Three renders of the Predikt Oracle demo. **Every value on screen is real** — each
generator boots the actual server, runs the genuine API flow (signup → create market →
quote → buy → resolve → payout → leaderboard) capturing live responses, and screenshots
the live dashboard at `/app` with headless Chrome. All are under the hackathon's 90-second limit.

### Demo cut (the ≤90s submission video)
| File | Length | What it is |
|---|---|---|
| **`predikt-oracle-voiced.mp4`** | ~76s | 🎙️ **Voiced + subtitled** — narrated walkthrough (TTS), slide timing driven by the narration. Ships with `predikt-oracle-voiced.srt`. **Use this as the submission demo.** |
| `predikt-oracle-demo.mp4` | ~57s | Captioned slide reel (no audio) — the same story, silent. |
| `predikt-oracle-terminal.mp4` | ~23s | Asciinema-style live terminal recording with a typing effect. |
| `predikt-oracle-terminal.cast` | — | Native asciinema v2 cast (`asciinema play …` or upload to asciinema.org). |

### Launch pack (viral, text-first, silent — built for the X post)
X autoplays muted, so these are big-type, fast-cut, silent — post them as the hook, then link the
full voiced demo.
| File | Length | What it is |
|---|---|---|
| `predikt-launch-hype.mp4` | ~22s | The "we shipped it" launch cut — hook, capability flashes, CTA. |
| `predikt-use-case.mp4` | ~21s | A concrete two-agent scenario: disagree → price it → the calibrated one profits. |
| `predikt-build-story.mp4` | ~23s | The build process — agent-native rebuild, 2 adversarial reviews, 294 tests. |

Generate the launch pack with `node submission/make-launch-videos.mjs`.

## Storyboard (voiced & silent reels)

1. Title · **Predikt Oracle**, #OKXAI
2. Hook · "Agents shouldn't argue about the future — they should price it."
3. Live dashboard (real markets, probabilities, activity feed)
4. Sign up → starter credits
5. Create a market (earn 1% of every trade)
6. A second agent buys YES → the price moves (0.40 → 0.65)
7. Resolve → winner paid out 1:1
8. Reputation leaderboard (Brier / profit / volume)
9. Capabilities (x402, MCP, webhooks, AI tools, search, limit orders)
10. "294 tests, 2 review passes"
11. Close · Live on OKX.AI · #OKXAI

## Regenerate

```bash
# needs: ffmpeg, Google Chrome, macOS `say` (for the voiced build), asp deps (npm i in ../../asp)
node submission/make-voiced-demo.mjs      # voiced + subtitled
node submission/make-demo.mjs             # silent captioned reel
node submission/make-terminal-cast.mjs    # terminal cast (.mp4 + .cast)
```

The voiced build uses macOS `say` (voice: Samantha). Slide durations are computed from the
narration length so the audio and visuals stay in sync; the `.srt` cues are generated from the
same timeline. To swap in a human voiceover instead, mux your own track:

```bash
ffmpeg -i predikt-oracle-demo.mp4 -i voiceover.m4a -c:v copy -c:a aac -shortest out.mp4
```
