# Hosted deployment (Phase 1 — design, not yet built)

`circuit-mcp` ships as a **bring-your-own-wallet** server: the operator sets `CIRCUIT_WALLET`, and every
paid tool call auto-pays CIRC from that wallet to the Circuit treasury. That's ideal for a developer running
the server locally (Claude Desktop, an agent runtime). It has two frictions for broad adoption:

1. every agent operator needs a funded CIRC wallet, and
2. the payment happens client-side (the server the operator runs holds the key).

A **Circuit-hosted** deployment removes both: Circuit runs the MCP server, fronts the data payments, and
charges the calling agent at the MCP boundary. This document is the design for that; it is **not built yet**.

## Two deployment models

| | Distributed (this package) | Hosted (Circuit-operated) |
|---|---|---|
| Runs where | the user's machine (`npx @circuit-llm/mcp`) | `mcp.circuitllm.xyz` |
| Transport | stdio | Streamable HTTP |
| Who holds a wallet | the user (`CIRCUIT_WALLET`) | Circuit (server-side) |
| Data API payment | user's wallet pays x402 per call | Circuit fetches for free with the internal key |
| Who the agent pays | nobody (pays the data API directly) | Circuit, at the MCP boundary |

## How the hosted server settles

1. An agent's MCP client calls a paid tool over Streamable HTTP.
2. The hosted server fetches the underlying data from [circuit-data-api](https://github.com/Circuit-LLM/circuit-data-api)
   using `CIRCUIT_DATA_INTERNAL_KEY` — the internal-key bypass, so the data itself costs Circuit nothing.
3. The server **meters the agent** for that tool call, one of two ways:
   - **x402 at the MCP boundary** — the tool returns `402`; the agent pays CIRC/USDC and retries (fully
     pay-as-you-go, no account), or
   - **prepaid credits** — the agent presents a key tied to a balance, debited per call (the same ledger
     model as [circuit-models-gateway](https://github.com/Circuit-LLM/circuit-models-gateway)).
4. A markup over the raw data-API price is Circuit's take.

## Why the shipped package has no internal-key path

The internal-key bypass (`CIRCUIT_DATA_INTERNAL_KEY`) is **deliberately not read** by this package. Letting a
distributed client set it would (a) advertise a bypass mechanism and (b) confuse the payment model. The
bypass is a server-side concern of the hosted deployment only — a separate entry point Circuit operates, not
a knob a `npx` user can flip. The distributed package always pays per call.

## Open items

- Streamable HTTP entry point + session handling.
- The metering choice (x402-at-boundary vs prepaid credits) — likely both, mirroring the models gateway.
- USDC alongside CIRC.
- A **directory** where third parties list their own x402-paid MCP tools, with a Circuit take-rate — the
  marketplace play (Path 1 of the ecosystem strategy).
