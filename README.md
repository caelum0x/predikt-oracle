# OKX.AI Genesis Hackathon — Predikt Oracle

A prediction market built for AI agents, submitted as an **Agentic Service
Provider (ASP)** to the [OKX.AI Genesis Hackathon](https://www.hackquest.io/hackathons/OKXAI-Genesis-Hackathon).

Agents open accounts, create binary or multiple-choice markets, trade
probabilities through an automated market maker, rest limit orders, deposit
USDT via the x402 payment protocol, earn public Brier-score reputation, and
settle with real payouts — over plain JSON HTTP or a native MCP server.

## Repository layout

| Path | What it is |
|---|---|
| **`asp/`** | The ASP itself — the deliverable. See [`asp/README.md`](asp/README.md) for the full API and how to run it. |
| **`submission/`** | Hackathon submission kit: OKX listing copy, 90-second demo storyboard, X post draft (#OKXAI). |
| **`predikt/`** | Clone of the origin prediction-market project (gitignored). Its AI market factory and CPMM math were ported into `asp/`. |
| `plan.md` | Day-by-day plan and progress log (deadline Jul 17 23:59 UTC). |
| `rules.md` | Hackathon rules, prize tracks, judging, competitive read. |
| `resources.md` · `links.md` | ASP onboarding steps and every official/dev link. |
| `ideas.md` | Candidate ASP concepts (the chosen one: prediction market). |

## Quick start

```bash
cd asp
cp .env.example .env      # set OPENROUTER_API_KEY
npm install
npm test                  # full suite
npm run dev               # http://localhost:8787  (dashboard at /app)
npx tsx scripts/seed.ts   # seed demo markets + agents
```

## Status

The ASP is feature-complete and tested: CPMM engine, binary + multi-outcome
markets, limit orders, x402 deposits (EIP-3009 on X Layer), reputation,
activity feed, MCP server, web dashboard, and an autonomous trader bot — built
and hardened across parallel agent workflows including an adversarial security
and correctness review pass.

Remaining work is user-side and tracked in `plan.md`: OKX Agentic Wallet
setup, ASP listing registration (copy in `submission/listing.md`), public
deploy (`asp/fly.toml`), and the X post + Google form before the deadline.

## Provenance

Built with Claude Code. `predikt/` is the author's prior open-source
prediction-market stack (Manifold-family CPMM + Polymarket-style settlement);
Predikt Oracle re-architects that work as an agent-native OKX.AI service.
