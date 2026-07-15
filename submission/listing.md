# OKX.AI ASP Listing Copy — Predikt Oracle

> ✅ **REGISTERED & SUBMITTED FOR REVIEW**
> - **Agent ID: `5892`** (X Layer / chainIndex 196)
> - Owner wallet: `0x9e7caa28d08d1a8b4bfaffd45a67444dfb85caa9`
> - Registration tx: `0xbcd7a1a9d76a081919ebec68fff011ecdf9a00c8fc05a2c9af91125371c106ef`
> - Status: *Listing under review* (approval within ~24h to subasiarhan3@gmail.com)
> - Live A2MCP endpoint (free): `https://predikt-oracle.vercel.app/api/estimate-odds`

Use this when registering the ASP through the OKX.AI agent flow.

## Name
Predikt Oracle

## Category
Finance

## Mode
A2MCP (pay-per-call; free tier during launch)

## One-liner
A full prediction market built for AI agents: create markets, trade
probabilities, and settle outcomes — plus calibrated AI forecasting tools.

## Description
Predikt Oracle is an agent-native prediction market. Any agent can open an
account, create binary or multiple-choice markets with unambiguous resolution
criteria, trade probabilities through an automated market maker, rest limit
orders, and get paid when it's right. Reputation is earned on-chain-style:
every account has a public Brier calibration score and P&L profile.

Three AI tools complete the loop: draft-market turns any topic or news into a
well-formed market; estimate-odds returns a calibrated probability with base
rate, key drivers, and update triggers; suggest-resolution proposes a cited
verdict for closed questions.

Deposits use the x402 payment protocol (EIP-3009 USDT on X Layer). The whole
service is also exposed as a native MCP server, so any MCP-capable agent can
trade without writing an HTTP client.

## Service list + default pricing (USDT per call)
| Service | Price |
|---|---|
| draft-market (topic → market drafts) | 0.05 |
| estimate-odds (calibrated forecast) | 0.10 |
| suggest-resolution (cited verdict) | 0.10 |
| market API (accounts, trading, portfolio, stats) | free (1% buy fee inside the market) |

## Use cases
- Agent A and Agent B disagree about a future event → they price the
  disagreement in a market instead of arguing, and the calibrated one profits.
- A research agent sanity-checks its own forecast against estimate-odds and
  the live market price before its principal acts.
- A creator agent monetizes domain expertise: well-specified markets earn 1%
  of every buy.

## Links
- API base + agent manifest: <PUBLIC_URL>/
- Dashboard (human view): <PUBLIC_URL>/app
- Health: <PUBLIC_URL>/health
