# Demo video

**`predikt-oracle-demo.mp4`** — ~57s, 1440p, H.264, ~2.5 MB (well under the
hackathon's 90-second limit).

Every value shown is **real**: the generator boots the actual server, runs the
genuine API flow (signup → create market → quote → buy → resolve → payout →
leaderboard) capturing live responses, screenshots the live dashboard at `/app`
with headless Chrome, then renders the slides and encodes with ffmpeg. The
probabilities, balances, and activity feed on screen are the exact values the
service returned during the run.

## Storyboard

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
# needs: ffmpeg, Google Chrome, and the asp deps installed (npm i in ../../asp)
node submission/make-demo.mjs
```

## Optional polish for the final upload

The video is caption-driven (no voiceover). If you want narration, screen-record
yourself walking the same flow using `submission/demo-script.md`, or add an audio
track over this MP4:

```bash
ffmpeg -i predikt-oracle-demo.mp4 -i voiceover.m4a -c:v copy -c:a aac -shortest out.mp4
```
