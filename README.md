# @circuit-llm/mcp

[![npm](https://img.shields.io/npm/v/@circuit-llm/mcp?color=cb3837&label=npm)](https://www.npmjs.com/package/@circuit-llm/mcp)

> An MCP server that gives any AI agent Circuit's real-time Solana data and **agent-swarm intelligence** as tools — **auto-paid per call in CIRC** over x402. No API keys, no signup.

Part of the **[Circuit SDK](https://github.com/Circuit-LLM/circuit-sdk)**. [Packages →](https://github.com/Circuit-LLM/circuit-sdk/blob/main/docs/packages.md)

A thin [Model Context Protocol](https://modelcontextprotocol.io) server over [`@circuit-llm/data`](https://github.com/Circuit-LLM/circuit-sdk/tree/main/packages/data), which already speaks x402: free tools return data directly; paid tools are auto-paid from your wallet, bounded per call **and** per session.

## Use it

Add it to any MCP client (Claude Desktop, Claude Code, an agent runtime):

```jsonc
// claude_desktop_config.json → "mcpServers"
{
  "circuit": {
    "command": "npx",
    "args": ["-y", "@circuit-llm/mcp"],
    "env": {
      "CIRCUIT_WALLET": "<base58 secret key funded with CIRC>"    // omit → free tools only
    }
  }
}
```

Then ask your agent *"what's the swarm's consensus on this mint?"* or *"audit this token for rug risk"* — the paid tools settle on Solana in ~400ms behind the scenes. Without `CIRCUIT_WALLET`, the free tools still work.

## Tools

| Tool | Cost | What |
|------|------|------|
| `circuit_quote` | free | live price list for every tool |
| `token_price` | free | aggregated USD price (Jupiter + DexScreener + CoinGecko) |
| `live_prices` | free | sub-second batch prices (≤20 mints) from the gRPC indexer |
| `scan` | free | on-chain dip-reversal scanner |
| **`swarm_feed`** ⭐ | ~$0.002 | live buy/sell/rug signals from the Circuit agent swarm |
| **`swarm_consensus`** ⭐ | ~$0.002 | reputation-weighted swarm view on one token |
| `token_security` | ~$0.003 | rug-risk audit — authorities, LP lock, risk flags |
| `token_overview` | ~$0.003 | price + metadata + security + pools in one call |
| `trending` | ~$0.002 | trending tokens across sources |
| `token_holders` | ~$0.005 | holder count + top-5/10/20 concentration |

The **`swarm_*`** tools are the differentiator — live signals from a running trading-agent fleet, data no generic price API has. Prices are live from `circuit_quote` (`/api/quote`); a few endpoints are currently ungated (free).

## Config

All configuration is via environment variables.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CIRCUIT_WALLET` | — | base58 secret key that funds micropayments (omit → free tools only) |
| `CIRCUIT_MCP_MAX_SPEND_CIRC` | `1000` | per-**call** CIRC spend cap |
| `CIRCUIT_MCP_MAX_TOTAL_CIRC` | `50000` | per-**process** CIRC cap — the runaway-spend guard; paid tools stop once reached |
| `CIRCUIT_MCP_TIMEOUT_MS` | `120000` | outer per-tool-call backstop (a genuinely stuck call returns a clean error) |
| `CIRCUIT_TREASURY` | — | if set, only ever pay this address (recipient allow-list — recommended) |
| `CIRCUIT_DATA_URL` | `https://api.circuitllm.xyz` | override the data API base |
| `CIRCUIT_RPC_URL` | public RPC | Solana RPC used to send payments — set your own; the public default rate-limits |

## Safety

- **Spend is bounded two ways** — `CIRCUIT_MCP_MAX_SPEND_CIRC` per call and `CIRCUIT_MCP_MAX_TOTAL_CIRC` per process (the drain guard against a looping agent). Set `CIRCUIT_TREASURY` to pin the payee so a hostile endpoint can't redirect funds.
- **Read-only** — every tool is a data fetch; none move funds beyond the micropayment.
- **No bypass** — this package always pays per call; the internal-key bypass is a Circuit-hosted concern, never a user knob.
- **Protocol-safe** — all logs go to stderr; stdout is reserved for the MCP channel.

## Develop

```bash
git clone https://github.com/Circuit-LLM/MCP && cd MCP
npm install
npm run smoke    # spawn it via a real MCP client, list tools, exercise the free tools (no spend)
npm start        # run the server over stdio
```

Built on [`@circuit-llm/data`](https://github.com/Circuit-LLM/circuit-sdk/tree/main/packages/data) + [`@circuit-llm/wallet`](https://github.com/Circuit-LLM/circuit-sdk/tree/main/packages/wallet) + the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Part of the [Circuit SDK](https://github.com/Circuit-LLM/circuit-sdk) ecosystem.
