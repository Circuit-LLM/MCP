// Circuit MCP — expose Circuit's Solana data API + agent-swarm intelligence as MCP tools.
//
// Design: this is a thin mapping layer over @circuit-llm/data. That client already speaks x402 —
// free endpoints return 200, paid endpoints answer 402 and the client pays CIRC from the wallet and
// retries. So the MCP server is just: a spend-capped wallet + a tool per endpoint. No payment code here.
//
// Payment model (Phase 0): the operator configures ONE funded wallet (CIRCUIT_WALLET). Every paid tool
// call auto-pays CIRC to the Circuit treasury, capped per call. Free tools need no wallet. This is the
// "bring-your-own-wallet" MCP — drop it into Claude Desktop / an agent runtime, fund a CIRC wallet, done.
//
// Env:
//   CIRCUIT_WALLET               base58 secret key that funds micropayments (omit → free tools only)
//   CIRCUIT_MCP_MAX_SPEND_CIRC   per-call CIRC spend cap (default 1000 ≈ a few cents of headroom)
//   CIRCUIT_TREASURY             if set, only ever pay THIS address (recipient allow-list; recommended)
//   CIRCUIT_DATA_URL             override the data API base (default https://api.circuitllm.xyz)
//
// Note: the x402 internal-key bypass is deliberately NOT wired here — this package always pays per call.
// The bypass is a Circuit-internal concern for a hosted deployment, never a knob users can set.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Data } from '@circuit-llm/data';
import { makeWallet } from '@circuit-llm/wallet';

const CIRC_DECIMALS = 6;

/** Build the configured McpServer (not yet connected to a transport). */
export function buildServer(opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m) => process.stderr.write(m + '\n')); // stdout is the MCP channel — logs go to stderr

  // Wallet is optional: makeWallet() returns a read-only wallet (keypair=null) when CIRCUIT_WALLET is unset,
  // and only throws when it's set-but-malformed. Paid tools then fail with a clear "set CIRCUIT_WALLET" hint.
  let wallet = null;
  try {
    wallet = makeWallet();
  } catch (e) {
    log(`[circuit-mcp] CIRCUIT_WALLET is set but invalid: ${e.message} — paid tools disabled`);
  }
  const hasWallet = !!wallet?.keypair;

  // Parse a positive number from env, falling back to a default (never crash on a typo).
  const posNum = (v, dflt, name) => {
    if (v == null || v === '') return dflt;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    log(`[circuit-mcp] ignoring invalid ${name}="${v}" — using ${dflt}`);
    return dflt;
  };
  const toRaw = (circ) => BigInt(Math.round(circ * 10 ** CIRC_DECIMALS));

  const capCirc = posNum(env.CIRCUIT_MCP_MAX_SPEND_CIRC, 1000, 'CIRCUIT_MCP_MAX_SPEND_CIRC'); // per call
  const totalCirc = posNum(env.CIRCUIT_MCP_MAX_TOTAL_CIRC, 50_000, 'CIRCUIT_MCP_MAX_TOTAL_CIRC'); // per process — the real drain guard
  // Outer backstop for a WHOLE tool call. It must exceed a legit paid pay-and-retry (initial request +
  // on-chain CIRC payment, which can take tens of seconds on a slow RPC + the retry) — otherwise it would
  // kill a slow-but-valid payment mid-flight. @circuit-llm/x402 already bounds each individual HTTP attempt
  // to ~30s, so this only trips when a call is genuinely stuck, never a merely-slow payment.
  const timeoutMs = posNum(env.CIRCUIT_MCP_TIMEOUT_MS, 120_000, 'CIRCUIT_MCP_TIMEOUT_MS');

  // Validate the optional recipient allow-list — a bad address would silently block EVERY paid tool.
  let treasury = env.CIRCUIT_TREASURY?.trim() || undefined;
  if (treasury && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(treasury)) {
    log(`[circuit-mcp] ignoring invalid CIRCUIT_TREASURY="${treasury}" (not a base58 address) — recipient pinning off`);
    treasury = undefined;
  }

  const data = new Data({
    wallet: hasWallet ? wallet : undefined,
    maxSpendRaw: toRaw(capCirc), // cap per single tool call
    maxTotalSpendRaw: toRaw(totalCirc), // cap total spend for this process (stops a runaway/looping agent)
    allowedRecipients: treasury ? [treasury] : undefined, // pin the payee so a hostile endpoint can't redirect funds
    onPay: (q) => log(`[circuit-mcp] paid ${q?.amountDisplay ?? '?'} for a tool call`),
    baseUrl: env.CIRCUIT_DATA_URL || undefined,
  });

  const server = new McpServer({ name: 'circuit-data', version: '0.1.0' });

  const asText = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
  const asError = (m) => ({ content: [{ type: 'text', text: `Error: ${m}` }], isError: true });

  // Bound every tool call so a stalled upstream (the data API accepts the socket but never responds)
  // can't hang the MCP client forever — it returns a clean timeout error instead.
  const withTimeout = (p) => {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`tool call timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer)); // clear on settle so the timer doesn't linger
  };

  // Register a tool with unified error handling: a timeout backstop, a friendly hint when a paid tool is
  // hit with no wallet, and a clear message when a spend cap is reached.
  const tool = (name, config, run) =>
    server.registerTool(name, config, async (args) => {
      try {
        return asText(await withTimeout(Promise.resolve().then(() => run(args ?? {}))));
      } catch (e) {
        const name = e?.name;
        const msg = e?.message ?? String(e);
        // Match on the @circuit-llm/x402 error class name (each sets this.name) — robust to message wording.
        if (name === 'PaymentRequiredError') {
          return asError(`this tool costs CIRC. Set CIRCUIT_WALLET to a funded base58 secret key to enable paid tools. (${msg})`);
        }
        if (name === 'SpendCapError' || name === 'BudgetExceededError') {
          return asError(`spend cap reached — raise CIRCUIT_MCP_MAX_SPEND_CIRC / CIRCUIT_MCP_MAX_TOTAL_CIRC (or restart). (${msg})`);
        }
        if (name === 'RecipientNotAllowedError') {
          return asError(`payment blocked — CIRCUIT_TREASURY doesn't match the endpoint's payee. Unset it or set the correct treasury. (${msg})`);
        }
        return asError(msg); // InsufficientFundsError etc. already carry a clear message
      }
    });

  // ── FREE tools (no wallet needed) ───────────────────────────────────────────
  tool(
    'circuit_quote',
    { title: 'Circuit price list', description: 'FREE. List every Circuit data tool with its live cost in USD and CIRC. Call this first to see what each paid tool costs.', inputSchema: {} },
    () => data.quote(),
  );
  tool(
    'token_price',
    { title: 'Token price', description: 'FREE. Aggregated USD price for a Solana token (Jupiter + DexScreener + CoinGecko, with on-chain price-feed fallback).', inputSchema: { mint: z.string().describe('SPL token mint address') } },
    ({ mint }) => data.tokenPrice(mint),
  );
  tool(
    'live_prices',
    { title: 'Live batch prices', description: 'FREE. Sub-second batch prices for up to 20 mints straight from the Circuit gRPC indexer (Redis reads).', inputSchema: { mints: z.array(z.string()).max(20).describe('SPL token mint addresses (max 20)') } },
    ({ mints }) => data.livePrices(mints),
  );
  tool(
    'scan',
    { title: 'Dip-reversal scan', description: 'FREE. The Circuit on-chain dip-reversal scanner: freshly scored candidates from the live gRPC feed.', inputSchema: { limit: z.number().int().max(50).optional().describe('max candidates (default 20)'), minLiquidity: z.number().optional().describe('min USD liquidity filter') } },
    ({ limit, minLiquidity }) => data.get('/api/price-feed/scan', { limit, minLiquidity }),
  );

  // ── PAID tools (auto-pay CIRC via x402) ─────────────────────────────────────
  tool(
    'swarm_feed',
    { title: 'Swarm signal feed', description: '~$0.002 in CIRC. Live buy/sell/rug signals published by the Circuit trading-agent swarm — signal data unique to Circuit.', inputSchema: { limit: z.number().int().max(100).optional(), type: z.enum(['buy_signal', 'sell_signal', 'rug_alert']).optional(), minReputation: z.number().optional().describe('only signals from agents above this reputation') } },
    ({ limit, type, minReputation }) => data.get('/api/swarm/feed', { limit, type, minReputation }),
  );
  tool(
    'swarm_consensus',
    { title: 'Swarm consensus on a token', description: "~$0.002 in CIRC. The swarm's reputation-weighted view on ONE token: bullish / bearish / rug_alert with confidence.", inputSchema: { mint: z.string().describe('SPL token mint address') } },
    ({ mint }) => data.get(`/api/swarm/consensus/${encodeURIComponent(mint)}`),
  );
  tool(
    'token_security',
    { title: 'Token security audit', description: '~$0.003 in CIRC. Rug-risk audit: authority analysis, LP lock %, creator balance, and full risk flags by category.', inputSchema: { mint: z.string() } },
    ({ mint }) => data.tokenSecurity(mint),
  );
  tool(
    'token_overview',
    { title: 'One-shot token overview', description: 'Price + metadata + security audit + active pools in a single call (replaces four). Priced per /api/quote (~$0.003 in CIRC; often free).', inputSchema: { mint: z.string() } },
    ({ mint }) => data.get('/api/token-overview', { mint }),
  );
  tool(
    'trending',
    { title: 'Trending tokens', description: '~$0.002 in CIRC. Aggregated trending Solana tokens across RugCheck organic, DexScreener boosts, and volume signals.', inputSchema: { limit: z.number().int().max(50).optional() } },
    ({ limit }) => data.get('/api/token-trending', { limit }),
  );
  tool(
    'token_holders',
    { title: 'Holder concentration', description: '~$0.005 in CIRC. Holder count + top-5/10/20 supply concentration (a key rug/whale signal).', inputSchema: { mint: z.string() } },
    ({ mint }) => data.tokenHolders(mint),
  );

  return { server, hasWallet, capCirc, totalCirc };
}
