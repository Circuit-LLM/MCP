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
// Surface: 28 tools (14 free), 3 guided prompts, and 5 free ambient resources. The differentiator is the
// swarm_* family — live signal/consensus/leaderboard/holdings/blacklist from Circuit's running agent fleet,
// data no generic price API has. Every tool is READ-ONLY (a fetch); the only side effect is the micropayment.
//
// Env:
//   CIRCUIT_WALLET               base58 secret key that funds micropayments (omit → free tools only)
//   CIRCUIT_MCP_MAX_SPEND_CIRC   per-call CIRC spend cap (default 1000 ≈ a few cents of headroom)
//   CIRCUIT_MCP_MAX_TOTAL_CIRC   per-process CIRC cap — the runaway-spend guard
//   CIRCUIT_MCP_TIMEOUT_MS       outer per-tool-call backstop (default 120s)
//   CIRCUIT_TREASURY             if set, only ever pay THIS address (recipient allow-list; recommended)
//   CIRCUIT_DATA_URL             override the data API base (default https://api.circuitllm.xyz)
//   CIRCUIT_PAYMENT_MINT         pay in a registered token instead of CIRC (x402 Universal Adapter). The
//                                mint must appear in the endpoint's `acceptedTokens` (see x402_accepted_tokens);
//                                any endpoint that doesn't accept it falls back to CIRC.
//   CIRCUIT_MCP_MAX_PAYTOKEN     REQUIRED with CIRCUIT_PAYMENT_MINT: per-call ceiling in the token's OWN base
//                                units (fail-closed — without it we refuse to pay the foreign token, using CIRC).
//   CIRCUIT_MCP_MAX_TOTAL_PAYTOKEN  optional cumulative foreign-token ceiling (base units) — the drain guard.
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
  // Parse a positive integer of token base units into a BigInt (foreign-token ceilings). Returns undefined
  // on anything non-integer/non-positive so a typo can't silently disable the fail-closed cap.
  const posBigInt = (v, name) => {
    if (v == null || v === '') return undefined;
    const s = String(v).trim();
    if (!/^\d+$/.test(s) || s === '0') {
      log(`[circuit-mcp] ignoring invalid ${name}="${v}" — expected a positive integer of token base units`);
      return undefined;
    }
    return BigInt(s);
  };

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

  // Optional: pay in a REGISTERED TOKEN instead of CIRC (x402 Universal Adapter). The payer only spends the
  // foreign token on endpoints that advertise it in `acceptedTokens`; everything else still settles in CIRC.
  // The SDK fails closed — payToken without a per-call ceiling throws — so we pre-validate and, if the ceiling
  // is missing/invalid, drop back to CIRC rather than enable an unbounded foreign spend.
  let payToken = env.CIRCUIT_PAYMENT_MINT?.trim() || undefined;
  let maxPayTokenRaw;
  let maxTotalPayTokenRaw;
  if (payToken) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payToken)) {
      log(`[circuit-mcp] ignoring invalid CIRCUIT_PAYMENT_MINT="${payToken}" (not a base58 mint) — paying in CIRC`);
      payToken = undefined;
    } else if (!hasWallet) {
      log(`[circuit-mcp] CIRCUIT_PAYMENT_MINT is set but there's no CIRCUIT_WALLET to send it — paid tools stay disabled`);
      payToken = undefined;
    } else {
      maxPayTokenRaw = posBigInt(env.CIRCUIT_MCP_MAX_PAYTOKEN, 'CIRCUIT_MCP_MAX_PAYTOKEN');
      if (maxPayTokenRaw == null) {
        log('[circuit-mcp] CIRCUIT_PAYMENT_MINT is set but CIRCUIT_MCP_MAX_PAYTOKEN (per-call ceiling in the token\'s base units) is missing/invalid — refusing an unbounded foreign-token spend, paying in CIRC');
        payToken = undefined;
      } else {
        maxTotalPayTokenRaw = posBigInt(env.CIRCUIT_MCP_MAX_TOTAL_PAYTOKEN, 'CIRCUIT_MCP_MAX_TOTAL_PAYTOKEN'); // optional cumulative guard
      }
    }
  }

  const data = new Data({
    wallet: hasWallet ? wallet : undefined,
    maxSpendRaw: toRaw(capCirc), // cap per single tool call (CIRC path)
    maxTotalSpendRaw: toRaw(totalCirc), // cap total spend for this process (stops a runaway/looping agent)
    allowedRecipients: treasury ? [treasury] : undefined, // pin the payee so a hostile endpoint can't redirect funds
    payToken, // undefined → pay CIRC; a mint → pay that registered token where accepted, else CIRC
    maxPayTokenRaw, // fail-closed per-call ceiling for the foreign token (base units)
    maxTotalPayTokenRaw, // optional cumulative foreign-token drain guard
    onPay: (q) => log(`[circuit-mcp] paid ${q?.amountDisplay ?? '?'} for a tool call`),
    baseUrl: env.CIRCUIT_DATA_URL || undefined,
  });

  const server = new McpServer({ name: 'circuit-data', version: '0.2.0' });

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
  // hit with no wallet, and a clear message when a spend cap is reached. Every Circuit tool is a read-only
  // fetch against an external API, so we stamp readOnlyHint/openWorldHint annotations on all of them —
  // clients use those to decide what's safe to auto-run.
  const tool = (name, config, run) =>
    server.registerTool(
      name,
      { ...config, annotations: { readOnlyHint: true, openWorldHint: true, ...config.annotations } },
      async (args) => {
        try {
          return asText(await withTimeout(Promise.resolve().then(() => run(args ?? {}))));
        } catch (e) {
          const ename = e?.name;
          const msg = e?.message ?? String(e);
          // Match on the @circuit-llm/x402 error class name (each sets this.name) — robust to message wording.
          if (ename === 'PaymentRequiredError') {
            return asError(`this tool costs CIRC. Set CIRCUIT_WALLET to a funded base58 secret key to enable paid tools. (${msg})`);
          }
          if (ename === 'SpendCapError' || ename === 'BudgetExceededError') {
            return asError(`spend cap reached — raise CIRCUIT_MCP_MAX_SPEND_CIRC / CIRCUIT_MCP_MAX_TOTAL_CIRC (or restart). (${msg})`);
          }
          if (ename === 'RecipientNotAllowedError') {
            return asError(`payment blocked — CIRCUIT_TREASURY doesn't match the endpoint's payee. Unset it or set the correct treasury. (${msg})`);
          }
          return asError(msg); // InsufficientFundsError etc. already carry a clear message
        }
      },
    );

  // ══ FREE — price & market data (no wallet needed) ═══════════════════════════
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
    'sol_price',
    { title: 'SOL price', description: 'FREE. Current SOL/USD oracle price from the Circuit price feed.', inputSchema: {} },
    () => data.solPrice(),
  );
  tool(
    'token_candles',
    { title: 'OHLCV candles', description: 'FREE. Recent OHLCV candlesticks for a token from the on-chain price feed. window ∈ 1m|5m|1h|1d (default 5m), up to 300 candles.', inputSchema: { mint: z.string().describe('SPL token mint address'), window: z.enum(['1m', '5m', '1h', '1d']).optional().describe('candle interval (default 5m)'), limit: z.number().int().max(300).optional().describe('max candles (default 100)') } },
    ({ mint, window, limit }) => data.priceCandles(mint, { window, limit }),
  );
  tool(
    'scan',
    { title: 'Dip-reversal scan', description: 'FREE. The Circuit on-chain dip-reversal scanner: freshly scored candidates from the live gRPC feed.', inputSchema: { limit: z.number().int().max(50).optional().describe('max candidates (default 20)'), minLiquidity: z.number().optional().describe('min USD liquidity filter') } },
    ({ limit, minLiquidity }) => data.get('/api/price-feed/scan', { limit, minLiquidity }),
  );
  tool(
    'slippage_buy',
    { title: 'Buy price-impact', description: 'FREE. Estimate the on-chain price impact of buying a token with `solAmount` SOL (pre-trade slippage check).', inputSchema: { mint: z.string().describe('SPL token mint address'), solAmount: z.number().positive().describe('SOL to spend'), decimals: z.number().int().optional().describe('token decimals (if known — avoids a lookup)') } },
    ({ mint, solAmount, decimals }) => data.slippageBuy(mint, solAmount, { decimals }),
  );
  tool(
    'slippage_sell',
    { title: 'Sell price-impact', description: 'FREE. Estimate the on-chain price impact of selling `tokenAmount` of a token (pre-trade slippage check).', inputSchema: { mint: z.string().describe('SPL token mint address'), tokenAmount: z.number().positive().describe('token units to sell (UI amount)'), decimals: z.number().int().optional().describe('token decimals (if known — avoids a lookup)') } },
    ({ mint, tokenAmount, decimals }) => data.slippageSell(mint, tokenAmount, { decimals }),
  );

  // ══ FREE — swarm intelligence (the differentiator; no wallet needed) ═════════
  tool(
    'swarm_leaderboard',
    { title: 'Swarm leaderboard', description: "FREE. Circuit trading agents ranked by reputation: win rate, avg PnL, signal count. Shows which agents' signals to trust.", inputSchema: { limit: z.number().int().max(50).optional().describe('max agents (default 20)') } },
    ({ limit }) => data.get('/api/swarm/leaderboard', { limit }),
  );
  tool(
    'swarm_holdings',
    { title: 'Swarm holdings', description: 'FREE. What the Circuit agent fleet is holding RIGHT NOW — per-token, how many agents hold it and total USD value. Live smart-money positioning unique to Circuit.', inputSchema: {} },
    () => data.get('/api/swarm/holdings'),
  );
  tool(
    'swarm_blacklist',
    { title: 'Swarm rug blacklist', description: 'FREE. Tokens the swarm has flagged as rugs/scams, with the reason and how many agents reported each. A crowd-sourced avoid-list.', inputSchema: { limit: z.number().int().max(200).optional().describe('max entries'), search: z.string().optional().describe('filter by mint or symbol substring') } },
    ({ limit, search }) => data.get('/api/swarm/blacklist', { limit, search }),
  );
  tool(
    'swarm_blacklist_check',
    { title: 'Is this token blacklisted?', description: 'FREE. Fast single-token check against the swarm rug blacklist — returns blacklisted true/false with the reason and vote count. Use before entering a position.', inputSchema: { mint: z.string().describe('SPL token mint address') } },
    ({ mint }) => data.get(`/api/swarm/blacklist/check/${encodeURIComponent(mint)}`),
  );
  tool(
    'swarm_stats',
    { title: 'Swarm activity stats', description: 'FREE. Live health of the swarm: active agent count, signal volume by type, and current trending tokens across the fleet.', inputSchema: {} },
    () => data.get('/api/swarm/stats'),
  );

  // ══ FREE — x402 payment catalog (the universal token adapter) ═══════════════
  tool(
    'x402_accepted_tokens',
    { title: 'x402 accepted tokens', description: "FREE. Tokens you can use to pay Circuit's x402 endpoints besides CIRC — the registered tokens from Circuit's universal x402 adapter. Set CIRCUIT_PAYMENT_MINT to one of these mints (plus CIRCUIT_MCP_MAX_PAYTOKEN as a per-call ceiling) to have this server pay for tools in that token instead of CIRC. To register a new token, use the portal at circuitllm.xyz/register (a one-time wallet-signed claim).", inputSchema: {} },
    () => data.get('/api/x402/registry'),
  );

  // ══ PAID — swarm intelligence ⭐ (auto-pay CIRC via x402) ════════════════════
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
    'swarm_insights',
    { title: 'Swarm insights', description: '~$0.002 in CIRC. Aggregated patterns the swarm is seeing — what is working, what is being avoided, and emerging setups across the fleet.', inputSchema: { limit: z.number().int().max(100).optional().describe('max insights (default 20)') } },
    ({ limit }) => data.get('/api/swarm/insights', { limit }),
  );

  // ══ PAID — token deep-dive ══════════════════════════════════════════════════
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
    'token_info',
    { title: 'Token metadata', description: '~$0.005 in CIRC. Token metadata + market data: name, symbol, supply, market cap, FDV, liquidity, and volume.', inputSchema: { mint: z.string() } },
    ({ mint }) => data.tokenInfo(mint),
  );
  tool(
    'token_holders',
    { title: 'Holder concentration', description: '~$0.005 in CIRC. Holder count + top-5/10/20 supply concentration (a key rug/whale signal).', inputSchema: { mint: z.string() } },
    ({ mint }) => data.tokenHolders(mint),
  );
  tool(
    'trending',
    { title: 'Trending tokens', description: '~$0.002 in CIRC. Aggregated trending Solana tokens across RugCheck organic, DexScreener boosts, and volume signals.', inputSchema: { limit: z.number().int().max(50).optional() } },
    ({ limit }) => data.get('/api/token-trending', { limit }),
  );
  tool(
    'new_tokens',
    { title: 'New token launches', description: '~$0.002 in CIRC. Freshly launched Solana tokens — a discovery/early-entry feed.', inputSchema: {} },
    () => data.newTokens(),
  );

  // ══ PAID — wallet intelligence (smart-money tracking) ═══════════════════════
  tool(
    'wallet_pnl',
    { title: 'Wallet P&L', description: '~$0.01 in CIRC. Realized/unrealized P&L for any Solana wallet — track smart money and copy-trade candidates.', inputSchema: { wallet: z.string().describe('Solana wallet address') } },
    ({ wallet: w }) => data.walletPnl(w),
  );
  tool(
    'wallet_analytics',
    { title: 'Wallet analytics', description: '~$0.01 in CIRC. Behavioral profile of a wallet: win rate, holding times, trade sizes, token history — is this wallet worth following?', inputSchema: { wallet: z.string().describe('Solana wallet address') } },
    ({ wallet: w }) => data.walletAnalytics(w),
  );

  // ══ PAID — market macro context ═════════════════════════════════════════════
  tool(
    'market_regime',
    { title: 'Market regime', description: '~$0.002 in CIRC. Risk-on / risk-off read on the Solana market (breadth, momentum, volatility) — the macro backdrop for any trade.', inputSchema: {} },
    () => data.marketRegime(),
  );
  tool(
    'market_sentiment',
    { title: 'Market sentiment', description: '~$0.002 in CIRC. Fear/greed and sentiment gauge for the broader crypto market.', inputSchema: {} },
    () => data.marketSentiment(),
  );
  tool(
    'market_overview',
    { title: 'Market overview', description: '~$0.002 in CIRC. Broad market snapshot: total cap, volume, BTC/SOL dominance, and top movers.', inputSchema: {} },
    () => data.marketOverview(),
  );

  // ── Prompts — guided multi-tool workflows ───────────────────────────────────
  // These turn a single intent ("check this token") into the right chain of tool calls, and showcase the
  // swarm tools as part of the flow rather than leaving the client to discover them.
  server.registerPrompt(
    'rug_check',
    {
      title: 'Rug-check a token',
      description: 'Full rug/safety audit of one token using security, holders, and swarm signals.',
      argsSchema: { mint: z.string().describe('SPL token mint address') },
    },
    ({ mint }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Audit token ${mint} for rug risk. Call swarm_blacklist_check, token_security, token_holders, and swarm_consensus for this mint, then give a concise verdict (SAFE / CAUTION / AVOID) with the specific red or green flags that drove it.`,
        },
      }],
    }),
  );
  server.registerPrompt(
    'ape_check',
    {
      title: 'Should I buy this token?',
      description: 'Go/no-go decision on entering a position, weighing swarm view, safety, and slippage.',
      argsSchema: { mint: z.string().describe('SPL token mint address'), solAmount: z.string().optional().describe('SOL size you are considering (default 1)') },
    },
    ({ mint, solAmount }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `I'm considering buying ${solAmount || '1'} SOL of token ${mint}. Check swarm_consensus, swarm_blacklist_check, token_security, token_holders, and slippage_buy (solAmount ${solAmount || '1'}) for this mint, factor in market_regime, and give a GO or NO-GO with a one-line reason and the main risk.`,
        },
      }],
    }),
  );
  server.registerPrompt(
    'swarm_pulse',
    {
      title: 'What is the swarm doing?',
      description: 'A live read on the Circuit agent fleet: activity, positioning, and top signals.',
      argsSchema: {},
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: 'Summarize what the Circuit swarm is doing right now. Call swarm_stats, swarm_holdings, swarm_leaderboard, and swarm_feed (type buy_signal, limit 15), then give me: overall fleet activity, what they are accumulating, the top-reputation agents, and any notable fresh buy signals.',
        },
      }],
    }),
  );

  // ── Resources — free ambient context (no wallet, no spend) ──────────────────
  // Exposed as readable resources so a client can pull swarm state into context without a tool call.
  const jsonResource = (name, uri, title, description, fetchFn) =>
    server.registerResource(
      name,
      uri,
      { title, description, mimeType: 'application/json' },
      async (u) => {
        try {
          const body = await withTimeout(Promise.resolve().then(fetchFn));
          return { contents: [{ uri: u.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
        } catch (e) {
          return { contents: [{ uri: u.href, mimeType: 'application/json', text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }] };
        }
      },
    );
  jsonResource('circuit-quote', 'circuit://quote', 'Circuit price list', 'Live cost of every Circuit data tool.', () => data.quote());
  jsonResource('swarm-leaderboard', 'circuit://swarm/leaderboard', 'Swarm leaderboard', 'Circuit agents ranked by reputation.', () => data.get('/api/swarm/leaderboard', { limit: 20 }));
  jsonResource('swarm-holdings', 'circuit://swarm/holdings', 'Swarm holdings', 'What the Circuit fleet is holding right now.', () => data.get('/api/swarm/holdings'));
  jsonResource('swarm-blacklist', 'circuit://swarm/blacklist', 'Swarm rug blacklist', 'Tokens the swarm has flagged as rugs.', () => data.get('/api/swarm/blacklist', { limit: 100 }));
  jsonResource('x402-tokens', 'circuit://x402/accepted-tokens', 'x402 accepted tokens', "Tokens accepted to pay Circuit's x402 endpoints (universal adapter).", () => data.get('/api/x402/registry'));

  return { server, hasWallet, capCirc, totalCirc, payToken };
}
