<div align="center">

# circuit-mcp

**Give any AI agent Circuit's real-time Solana data and agent-swarm intelligence as tools — auto-paid per call in CIRC over x402. No API keys, no signup. Add it to Claude Desktop, Claude Code, or any agent runtime with one line.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](https://www.npmjs.com/package/@circuit-llm/mcp)
[![MCP](https://img.shields.io/badge/MCP-server-blueviolet)](https://modelcontextprotocol.io)
[![x402](https://img.shields.io/badge/x402-CIRC%20payments-gold)](https://x402.org)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

[Website](https://circuitllm.xyz) · [Data API](https://api.circuitllm.xyz) · [Circuit SDK](https://github.com/Circuit-LLM/circuit-sdk) · [Telegram](https://t.me/circuitllm) · [X / Twitter](https://x.com/CircuitLLM)

</div>

> **Beta software.** circuit-mcp is under active development — expect breaking changes, incomplete features, and rough edges. Paid tools spend real CIRC per call; start with the free tools (or a small spend cap) until you're comfortable with how it behaves.

## What it does

A thin [Model Context Protocol](https://modelcontextprotocol.io) server over [`@circuit-llm/data`](https://github.com/Circuit-LLM/circuit-sdk/tree/main/packages/data). It exposes Circuit's real-time Solana data as tools any MCP client can call — and auto-pays for them per call in CIRC over [x402](https://x402.org). Free tools return data directly; paid tools are auto-paid from your wallet, bounded per call **and** per session. No API keys, no accounts.

The differentiator is the **`swarm_*`** tools: live signals, consensus, leaderboard, holdings, and a crowd-sourced rug blacklist from Circuit's running trading-agent fleet — data no generic price API has.

**29 data tools (14 free) + `dllm_chat` (decentralized LLM inference) + `pay_settle`, 3 guided prompts, and 5 free ambient resources.** Every tool is read-only.

## Quick Start

Add it to any MCP client (Claude Desktop, Claude Code, an agent runtime):

```jsonc
// claude_desktop_config.json → "mcpServers"
{ "circuit": { "command": "npx", "args": ["-y", "@circuit-llm/mcp"],
    "env": { "CIRCUIT_WALLET": "<base58 secret funded with CIRC>" } } }   // omit → free tools only
```

Then ask your agent *"what's the swarm's consensus on this mint?"* or *"audit this token for rug risk."* The paid tools settle on Solana in ~400ms behind the scenes. Without `CIRCUIT_WALLET`, the free tools still work — and paid tools return an x402 quote you can pay from your own wallet and complete with `pay_settle` (see [pass-through](#how-it-works)).

## Tools

**Free — price & market data**

| Tool | What |
|------|------|
| `circuit_quote` | live price list for every tool (call this first) |
| `token_price` | aggregated USD price (Jupiter + DexScreener + CoinGecko) |
| `live_prices` | sub-second batch prices (≤20 mints) from the gRPC indexer |
| `sol_price` | current SOL/USD oracle price |
| `token_candles` | OHLCV candlesticks (1m/5m/1h/1d) from the on-chain feed |
| `scan` | on-chain dip-reversal scanner |
| `slippage_buy` / `slippage_sell` | pre-trade price-impact estimate |
| `x402_accepted_tokens` | tokens accepted to pay Circuit's x402 endpoints (universal adapter) |

**Free — swarm intelligence ⭐** (the differentiator)

| Tool | What |
|------|------|
| **`swarm_leaderboard`** ⭐ | agents ranked by reputation — whose signals to trust |
| **`swarm_holdings`** ⭐ | what the fleet is holding right now (live smart-money positioning) |
| **`swarm_blacklist`** ⭐ | crowd-sourced rug/scam avoid-list with reasons |
| **`swarm_blacklist_check`** ⭐ | fast single-token "is this flagged?" check |
| **`swarm_stats`** ⭐ | live fleet activity + signal volume |

**Paid** (auto-paid in CIRC via x402)

| Tool | Cost | What |
|------|------|------|
| **`swarm_feed`** ⭐ | ~$0.002 | live buy/sell/rug signals from the swarm |
| **`swarm_consensus`** ⭐ | ~$0.002 | reputation-weighted swarm view on one token |
| **`swarm_insights`** ⭐ | ~$0.002 | aggregated patterns the swarm is seeing |
| `token_security` | ~$0.003 | rug-risk audit — authorities, LP lock, risk flags |
| `token_overview` | ~$0.003 | price + metadata + security + pools in one call |
| `token_info` | ~$0.005 | metadata + market data (supply, mcap, FDV, liquidity) |
| `token_holders` | ~$0.005 | holder count + top-5/10/20 concentration |
| `token_top_traders` | ~$0.005 | top traders by volume (Birdeye) — wallet, whale tags, buy/sell, USD volume |
| `trending` | ~$0.002 | trending tokens across sources |
| `new_tokens` | ~$0.002 | freshly launched tokens (discovery feed) |
| `wallet_pnl` | ~$0.01 | realized/unrealized P&L for any wallet |
| `wallet_analytics` | ~$0.01 | behavioral profile — win rate, hold times, sizing |
| `market_regime` | ~$0.002 | risk-on/risk-off macro read |
| `market_sentiment` | ~$0.002 | fear/greed gauge |
| `market_overview` | ~$0.002 | broad market snapshot + top movers |

Prices are live from `circuit_quote` (`/api/quote`); a few paid endpoints are intermittently ungated (free).

**Paid — decentralized inference**

| Tool | Cost | What |
|------|------|------|
| `dllm_chat` | ~$0.03 | chat completion from Circuit's decentralized LLM (Qwen2.5-72B) over x402 |

`dllm_chat` pays per call in CIRC — the **same x402 rail** as the data tools, not model credits. Pass `prompt` (single turn, optional `system`) or full OpenAI-style `messages`. The result includes a `backend` field: `mesh` = the decentralized DLLM, `openrouter-fallback` = a hosted fallback model served while the mesh is offline (so a paid call never dead-ends). Point it elsewhere with `CIRCUIT_INFERENCE_URL` (default `https://inference.circuitllm.xyz`).

**Settlement** — `pay_settle`: when the server has no wallet, a paid tool returns an x402 quote instead of paying. Pay it on Solana yourself (CIRC to the recipient, or any registered token to its collector), then call `pay_settle` with the same `{ tool, args }` and your transaction signature to get the data. With a funded `CIRCUIT_WALLET`, paid tools auto-pay and you never need this.

## Prompts

Guided workflows that chain the right tools for a single intent:

| Prompt | Args | What it does |
|--------|------|--------------|
| `rug_check` | `mint` | blacklist + security + holders + consensus → SAFE / CAUTION / AVOID |
| `ape_check` | `mint`, `solAmount?` | consensus + security + slippage + regime → GO / NO-GO |
| `swarm_pulse` | — | stats + holdings + leaderboard + fresh buy signals → what the fleet is doing |

## Resources

Free, read-only ambient context a client can pull without a tool call: `circuit://quote`, `circuit://swarm/leaderboard`, `circuit://swarm/holdings`, `circuit://swarm/blacklist`, `circuit://x402/accepted-tokens`.

## Configuration

All configuration is via environment variables.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CIRCUIT_WALLET` | — | base58 secret key that funds micropayments (omit → free tools only) |
| `CIRCUIT_MCP_MAX_SPEND_CIRC` | `1000` | per-**call** CIRC spend cap |
| `CIRCUIT_MCP_MAX_TOTAL_CIRC` | `50000` | per-**process** CIRC cap — the runaway-spend guard; paid tools stop once reached |
| `CIRCUIT_MCP_TIMEOUT_MS` | `120000` | outer per-tool-call backstop (a genuinely stuck call returns a clean error) |
| `CIRCUIT_TREASURY` | — | if set, only ever pay this address (recipient allow-list — recommended) |
| `CIRCUIT_DATA_URL` | `https://api.circuitllm.xyz` | override the data API base |
| `CIRCUIT_INFERENCE_URL` | `https://inference.circuitllm.xyz` | override the DLLM inference gateway base (`dllm_chat`) |
| `CIRCUIT_RPC_URL` | public RPC | Solana RPC used to send payments — set your own; the public default rate-limits |
| `CIRCUIT_PAYMENT_MINT` | — | pay in a **registered token** instead of CIRC (see [Paying in another token](#paying-in-another-token)) |
| `CIRCUIT_MCP_MAX_PAYTOKEN` | — | **required** with `CIRCUIT_PAYMENT_MINT`: per-call ceiling in the token's own base units (fail-closed) |
| `CIRCUIT_MCP_MAX_TOTAL_PAYTOKEN` | — | optional cumulative foreign-token ceiling (base units) — the drain guard |

### Paying in another token

Circuit's [Universal x402 Adapter](https://circuitllm.xyz/register) lets any registered token pay Circuit's x402
endpoints — the token is swapped to CIRC on the back end. To have this server pay for tools in a registered
token instead of CIRC, set `CIRCUIT_PAYMENT_MINT` to that mint (call **`x402_accepted_tokens`** to see what's
registered) **and** `CIRCUIT_MCP_MAX_PAYTOKEN` to a per-call ceiling in the token's base units. The ceiling is
mandatory — without it the server fails closed and keeps paying CIRC. Any endpoint that doesn't accept the token
also falls back to CIRC automatically. Requires a funded `CIRCUIT_WALLET` that holds the token.

## Safety

- **Spend is bounded two ways** — `CIRCUIT_MCP_MAX_SPEND_CIRC` per call and `CIRCUIT_MCP_MAX_TOTAL_CIRC` per process (the drain guard against a looping agent). Set `CIRCUIT_TREASURY` to pin the payee so a hostile endpoint can't redirect funds.
- **Read-only** — every tool is a data fetch; none move funds beyond the micropayment.
- **No bypass** — this package always pays per call; the internal-key bypass is a Circuit-hosted concern, never a user knob (see [docs/HOSTING.md](docs/HOSTING.md)).
- **Protocol-safe** — all logs go to stderr; stdout is reserved for the MCP channel.

## How it works

Each paid tool call hits the [Circuit Data API](https://api.circuitllm.xyz): a free endpoint returns data; a paid one answers `402 Payment Required` with a CIRC quote. [`@circuit-llm/data`](https://github.com/Circuit-LLM/circuit-sdk/tree/main/packages/data) pays the quote from your wallet on Solana and retries — the spend caps and `CIRCUIT_TREASURY` allow-list bound where and how much.

**Pass-through (no wallet).** Without `CIRCUIT_WALLET`, the server doesn't pay — it returns that 402 quote to the caller. You pay it yourself and finish with `pay_settle`; the data API verifies the signature on-chain (single-use, ≤5 min), so the server never holds funds. This is how a wallet-free hosted endpoint (like [mcp.circuitllm.xyz](https://mcp.circuitllm.xyz)) lets each caller pay per call in their own token. For a Circuit-fronted hosted deployment, see [docs/HOSTING.md](docs/HOSTING.md).

## Develop

```bash
git clone https://github.com/Circuit-LLM/MCP && cd MCP
npm install
npm run smoke    # spawn the server via a real MCP client, list tools, exercise the free tools (no spend)
npm start        # run the server over stdio
```

Built on [`@circuit-llm/data`](https://github.com/Circuit-LLM/circuit-sdk/tree/main/packages/data) + [`@circuit-llm/wallet`](https://github.com/Circuit-LLM/circuit-sdk/tree/main/packages/wallet) + the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Part of the Circuit Stack

- **circuit-mcp** — this repo, Circuit data + swarm intel as x402-paid MCP tools
- [circuit-sdk](https://github.com/Circuit-LLM/circuit-sdk) — the TypeScript SDK (x402 · data · wallet · agent · inference)
- [circuit-data-api](https://github.com/Circuit-LLM/circuit-data-api) — the x402-gated Solana data aggregator these tools serve
- [circuit-agent](https://github.com/Circuit-LLM/circuit-agent) — the autonomous trading agent behind `swarm_feed`
- [circuitllm.xyz](https://circuitllm.xyz) — website and data terminal

---

## License

MIT — see [LICENSE](LICENSE).
