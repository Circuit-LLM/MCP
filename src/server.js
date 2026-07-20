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
// Surface: 29 data tools (14 free) + dllm_chat (decentralized LLM inference, paid) + pay_settle, 3 guided
// prompts, and 5 free ambient resources. The differentiator is the swarm_* family — live signal/consensus/
// leaderboard/holdings/blacklist from Circuit's running agent fleet, data no generic price API has. Every
// tool is READ-ONLY (a fetch or an inference generation); the only side effect is the micropayment.
//
// Pass-through (no-wallet / hosted): without CIRCUIT_WALLET, a paid tool returns its x402 quote instead of
// erroring, so the CALLER pays with their own wallet and completes the call via pay_settle (the tx signature
// is verified on-chain). This server never holds funds. With a wallet, paid tools auto-pay and pay_settle is unused.
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
import { X402Client } from '@circuit-llm/x402';
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

  // internalKey is a CODE-ONLY option (opts, never env) for a Circuit-operated hosted deployment that fetches
  // the data API with the internal-key bypass and meters the agent itself. It is deliberately not env-readable
  // so a distributed `npx` user can't flip a payment bypass — see docs/HOSTING.md.
  // One x402 payer shared by the data tools AND dllm_chat, so the per-call cap, cumulative drain guard,
  // recipient pinning, and registered-token settings apply uniformly across everything this server pays for.
  const x402 = new X402Client({
    wallet: hasWallet ? wallet : undefined,
    maxSpendRaw: toRaw(capCirc), // cap per single tool call (CIRC path)
    maxTotalSpendRaw: toRaw(totalCirc), // cap total spend for this process (stops a runaway/looping agent)
    allowedRecipients: treasury ? [treasury] : undefined, // pin the payee so a hostile endpoint can't redirect funds
    payToken, // undefined → pay CIRC; a mint → pay that registered token where accepted, else CIRC
    maxPayTokenRaw, // fail-closed per-call ceiling for the foreign token (base units)
    maxTotalPayTokenRaw, // optional cumulative foreign-token drain guard
    onPay: (q) => log(`[circuit-mcp] paid ${q?.amountDisplay ?? '?'} for a tool call`),
  });
  const data = new Data({
    x402, // reuse the shared payer (caps/pinning/payToken already configured on it)
    internalKey: opts.internalKey, // hosted-only: fetch free via the internal-key bypass (metering happens at the boundary)
    baseUrl: env.CIRCUIT_DATA_URL || undefined,
  });

  const server = new McpServer({ name: 'circuit-data', version: '0.4.0' });

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

  // ── x402 pass-through (no-wallet / hosted deployments) ──────────────────────
  // With a wallet, paid tools auto-pay (above). WITHOUT one, instead of erroring we return the endpoint's
  // 402 quote so the CALLER can pay with their OWN wallet and finish via `pay_settle` — the caller is the
  // payer, the payee (treasury/collector, distributor→CIRC) is unchanged, and this server never holds funds.
  const baseUrl = (env.CIRCUIT_DATA_URL || 'https://api.circuitllm.xyz').replace(/\/$/, '');
  const routeUrl = (path, query) => {
    const u = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
    return u.toString();
  };
  // Format a 402 body into the quote we hand a no-wallet caller (shared by the data GET path and the
  // inference POST path). Lists CIRC + every registered token the endpoint accepts, plus what to do next.
  const quoteFrom402 = (body) => {
    const alts = (body.acceptedTokens || [])
      .filter((t) => t.amountRaw != null)
      .map((t) => ({ symbol: t.symbol, mint: t.mint, amountRaw: String(t.amountRaw), recipient: t.recipient, decimals: t.decimals, tokenProgram: t.tokenProgram }));
    return {
      status: 'payment_required',
      pay_in_CIRC: body.payment
        ? { recipient: body.payment.recipient, amountRaw: String(body.payment.amountRaw), amountDisplay: body.payment.amountDisplay, token: body.payment.token, usdEquivalent: body.payment.usdEquivalent }
        : null,
      or_pay_in_registered_token: alts,
      expires_in_seconds: body.expiresInSeconds ?? 300,
      next: 'Pay ONE of the above on Solana with your wallet, then call pay_settle with { tool, args, signature } (the same tool + args). Or set CIRCUIT_WALLET so this server auto-pays.',
    };
  };
  const x402Quote = async (path, query) => {
    const r = await fetch(routeUrl(path, query), { signal: AbortSignal.timeout(20_000) });
    if (r.ok) return r.json(); // endpoint was free / returned data directly
    if (r.status !== 402) throw new Error(`data API ${r.status}`);
    return quoteFrom402(await r.json().catch(() => ({})));
  };
  const x402Settle = async (path, query, signature) => {
    if (!signature || typeof signature !== 'string') return { error: 'missing payment signature' };
    const r = await fetch(routeUrl(path, query), { headers: { 'X-Payment-Signature': signature }, signal: AbortSignal.timeout(35_000) });
    const b = await r.json().catch(() => null);
    if (r.ok) return { data: b };
    if (r.status === 402) return { error: 'payment not verified', reason: b?.reason || b?.message || 'unknown' };
    return { error: `data API ${r.status}`, body: b };
  };

  // A paid tool declares its data-API route once; auto-pay (wallet) and quote (no wallet) both use it, and it
  // registers the route so `pay_settle` can replay any paid tool with the caller's signature.
  const paidRoute = {};
  const paidTool = (name, config, route) => {
    paidRoute[name] = route;
    tool(name, config, (args) => {
      const { path, query } = route(args ?? {});
      return hasWallet ? data.get(path, query) : x402Quote(path, query);
    });
  };

  // ── x402 inference (POST /v1/chat/completions on the DLLM gateway) ───────────
  // Same x402 rail as the data tools (same CIRC treasury + on-chain verify), just POST-with-a-body on a
  // different host. With a wallet the shared X402Client auto-pays; without one it returns a quote the
  // caller settles via pay_settle. Inference can be slower than a data read, so these use a longer budget.
  const inferenceBase = (env.CIRCUIT_INFERENCE_URL || 'https://inference.circuitllm.xyz').replace(/\/$/, '');
  const inferenceEndpoint = `${inferenceBase}/v1/chat/completions`;
  const INFERENCE_TIMEOUT_MS = 115_000;
  // Build the OpenAI-style request body from tool args. Throws (→ friendly tool error) if given nothing.
  const chatBody = (args = {}) => {
    const messages =
      Array.isArray(args.messages) && args.messages.length
        ? args.messages
        : [
            ...(args.system ? [{ role: 'system', content: String(args.system) }] : []),
            { role: 'user', content: String(args.prompt ?? '') },
          ];
    const hasContent = messages.some((m) => String(m?.content ?? '').trim());
    if (!hasContent) throw new Error('provide `prompt` or `messages`');
    const body = { messages, stream: false }; // MCP tool results aren't streamed — ask for the full completion
    if (args.max_tokens != null) body.max_tokens = args.max_tokens;
    return body;
  };
  // Shape a completion for the tool result — surfaces WHICH backend served it: 'mesh' is the decentralized
  // DLLM (Qwen2.5-72B); 'openrouter-fallback' is the fallback model served while the mesh is offline.
  const shapeCompletion = (b, resp) => ({
    reply: b?.choices?.[0]?.message?.content ?? '',
    model: b?.model ?? null,
    backend: resp.headers.get('x-circuit-backend') || 'mesh',
    finish_reason: b?.choices?.[0]?.finish_reason ?? null,
    usage: b?.usage ?? null,
  });
  const inferencePay = async (body) => {
    const resp = await x402.fetch(inferenceEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });
    const b = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(`inference gateway ${resp.status}: ${b?.error || b?.message || 'error'}`);
    return shapeCompletion(b, resp);
  };
  const inferenceQuote = async (body) => {
    const r = await fetch(inferenceEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) return r.json();
    if (r.status !== 402) throw new Error(`inference gateway ${r.status}`);
    return quoteFrom402(await r.json().catch(() => ({})));
  };
  const inferenceSettle = async (body, signature) => {
    if (!signature || typeof signature !== 'string') return { error: 'missing payment signature' };
    const r = await fetch(inferenceEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payment-Signature': signature },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });
    const b = await r.json().catch(() => null);
    if (r.ok) return { data: shapeCompletion(b, r) };
    if (r.status === 402) return { error: 'payment not verified', reason: b?.reason || b?.message || 'unknown' };
    return { error: `inference gateway ${r.status}`, body: b };
  };
  // A paid POST (inference) tool: args → request body. Same wallet/no-wallet split as paidTool, and its
  // route is registered so pay_settle can rebuild the identical body from the caller's { tool, args }.
  const paidPostRoute = {};
  const paidPostTool = (name, config, route) => {
    paidPostRoute[name] = route;
    tool(name, config, (args) => {
      const body = route(args ?? {});
      return hasWallet ? inferencePay(body) : inferenceQuote(body);
    });
  };

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

  // ══ PAID — swarm intelligence ⭐ (auto-pay CIRC via x402; no wallet → returns a quote for pay_settle) ═════
  paidTool(
    'swarm_feed',
    { title: 'Swarm signal feed', description: '~$0.002 in CIRC. Live buy/sell/rug signals published by the Circuit trading-agent swarm — signal data unique to Circuit.', inputSchema: { limit: z.number().int().max(100).optional(), type: z.enum(['buy_signal', 'sell_signal', 'rug_alert']).optional(), minReputation: z.number().optional().describe('only signals from agents above this reputation') } },
    ({ limit, type, minReputation }) => ({ path: '/api/swarm/feed', query: { limit, type, minReputation } }),
  );
  paidTool(
    'swarm_consensus',
    { title: 'Swarm consensus on a token', description: "~$0.002 in CIRC. The swarm's reputation-weighted view on ONE token: bullish / bearish / rug_alert with confidence.", inputSchema: { mint: z.string().describe('SPL token mint address') } },
    ({ mint }) => ({ path: `/api/swarm/consensus/${encodeURIComponent(mint)}` }),
  );
  paidTool(
    'swarm_insights',
    { title: 'Swarm insights', description: '~$0.002 in CIRC. Aggregated patterns the swarm is seeing — what is working, what is being avoided, and emerging setups across the fleet.', inputSchema: { limit: z.number().int().max(100).optional().describe('max insights (default 20)') } },
    ({ limit }) => ({ path: '/api/swarm/insights', query: { limit } }),
  );

  // ══ PAID — token deep-dive ══════════════════════════════════════════════════
  paidTool(
    'token_security',
    { title: 'Token security audit', description: '~$0.003 in CIRC. Rug-risk audit: authority analysis, LP lock %, creator balance, and full risk flags by category.', inputSchema: { mint: z.string() } },
    ({ mint }) => ({ path: '/api/token-security', query: { mint } }),
  );
  paidTool(
    'token_overview',
    { title: 'One-shot token overview', description: 'Price + metadata + security audit + active pools in a single call (replaces four). Priced per /api/quote (~$0.003 in CIRC; often free).', inputSchema: { mint: z.string() } },
    ({ mint }) => ({ path: '/api/token-overview', query: { mint } }),
  );
  paidTool(
    'token_info',
    { title: 'Token metadata', description: '~$0.005 in CIRC. Token metadata + market data: name, symbol, supply, market cap, FDV, liquidity, and volume.', inputSchema: { mint: z.string() } },
    ({ mint }) => ({ path: '/api/token-info', query: { mint } }),
  );
  paidTool(
    'token_holders',
    { title: 'Holder concentration', description: '~$0.005 in CIRC. Holder count + top-5/10/20 supply concentration (a key rug/whale signal).', inputSchema: { mint: z.string() } },
    ({ mint }) => ({ path: '/api/token-holders', query: { mint } }),
  );
  paidTool(
    'token_top_traders',
    { title: 'Top traders', description: '~$0.005 in CIRC. Top traders of a token by volume (Birdeye): wallet, whale/smart-money tags, buy/sell trade counts, and USD volume — a smart-money signal.', inputSchema: { mint: z.string(), limit: z.number().int().max(20).optional().describe('max traders (default 10)'), window: z.enum(['30m', '1h', '2h', '4h', '6h', '8h', '12h', '24h']).optional().describe('time window (default 24h)') } },
    ({ mint, limit, window }) => ({ path: '/api/token-top-traders', query: { mint, limit, window } }),
  );
  paidTool(
    'trending',
    { title: 'Trending tokens', description: '~$0.002 in CIRC. Aggregated trending Solana tokens across RugCheck organic, DexScreener boosts, and volume signals.', inputSchema: { limit: z.number().int().max(50).optional() } },
    ({ limit }) => ({ path: '/api/token-trending', query: { limit } }),
  );
  paidTool(
    'new_tokens',
    { title: 'New token launches', description: '~$0.002 in CIRC. Freshly launched Solana tokens — a discovery/early-entry feed.', inputSchema: {} },
    () => ({ path: '/api/new-tokens' }),
  );

  // ══ PAID — wallet intelligence (smart-money tracking) ═══════════════════════
  paidTool(
    'wallet_pnl',
    { title: 'Wallet P&L', description: '~$0.01 in CIRC. Realized/unrealized P&L for any Solana wallet — track smart money and copy-trade candidates.', inputSchema: { wallet: z.string().describe('Solana wallet address') } },
    ({ wallet: w }) => ({ path: '/api/wallet-pnl', query: { wallet: w } }),
  );
  paidTool(
    'wallet_analytics',
    { title: 'Wallet analytics', description: '~$0.01 in CIRC. Behavioral profile of a wallet: win rate, holding times, trade sizes, token history — is this wallet worth following?', inputSchema: { wallet: z.string().describe('Solana wallet address') } },
    ({ wallet: w }) => ({ path: '/api/wallet-analytics', query: { wallet: w } }),
  );

  // ══ PAID — market macro context ═════════════════════════════════════════════
  paidTool(
    'market_regime',
    { title: 'Market regime', description: '~$0.002 in CIRC. Risk-on / risk-off read on the Solana market (breadth, momentum, volatility) — the macro backdrop for any trade.', inputSchema: {} },
    () => ({ path: '/api/market-regime' }),
  );
  paidTool(
    'market_sentiment',
    { title: 'Market sentiment', description: '~$0.002 in CIRC. Fear/greed and sentiment gauge for the broader crypto market.', inputSchema: {} },
    () => ({ path: '/api/market-sentiment' }),
  );
  paidTool(
    'market_overview',
    { title: 'Market overview', description: '~$0.002 in CIRC. Broad market snapshot: total cap, volume, BTC/SOL dominance, and top movers.', inputSchema: {} },
    () => ({ path: '/api/market-overview' }),
  );

  // ══ PAID — decentralized LLM inference (Circuit DLLM, x402) ═════════════════
  paidPostTool(
    'dllm_chat',
    {
      title: 'Circuit DLLM chat (decentralized inference)',
      description:
        '~$0.03 in CIRC. Chat completion from Circuit\'s decentralized LLM (Qwen2.5-72B) over x402 — the same ' +
        'per-call payment rail as the data tools, not model credits. With CIRCUIT_WALLET it auto-pays; without one ' +
        'it returns a quote to settle via pay_settle. Pass `prompt` for a single turn (optionally with `system`), or ' +
        'full `messages`. The result\'s `backend` says who served it: "mesh" = the decentralized DLLM, ' +
        '"openrouter-fallback" = a fallback model served while the mesh is offline.',
      inputSchema: {
        prompt: z.string().optional().describe('Single-turn user message (shortcut for messages).'),
        system: z.string().optional().describe('Optional system prompt, used together with `prompt`.'),
        messages: z
          .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
          .optional()
          .describe('Full OpenAI-style messages; overrides `prompt`/`system` when provided.'),
        max_tokens: z.number().int().positive().max(4096).optional().describe('Max tokens to generate.'),
      },
    },
    (args) => chatBody(args),
  );

  // ══ pay_settle — finish a paid call after paying its quote (pass-through) ════
  server.registerTool(
    'pay_settle',
    {
      title: 'Settle a paid tool with an on-chain payment',
      description:
        'Complete a paid Circuit tool when this server has no wallet. First call the paid tool (e.g. trending, ' +
        'dllm_chat) to get a payment quote, pay it on Solana with your own wallet (CIRC to the recipient, or any ' +
        'registered token to its collector), then call pay_settle with the SAME { tool, args } and your transaction ' +
        'signature. The payment is verified on-chain (single-use, ≤5 min). With a funded CIRCUIT_WALLET you never ' +
        'need this — paid tools auto-pay.',
      inputSchema: {
        tool: z.string().describe('the paid tool you are paying for, e.g. "trending", "wallet_pnl", "dllm_chat"'),
        args: z.object({}).passthrough().optional().describe('the SAME arguments you passed to the paid tool'),
        signature: z.string().describe('your Solana transaction signature proving the payment'),
      },
      // Read-only like every Circuit tool: it delivers already-paid data given a signature the CALLER
      // produced out-of-band; pay_settle itself neither signs nor spends.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tool: toolName, args, signature }) => {
      // POST (inference) tools rebuild their request body from args; GET (data) tools rebuild path+query.
      if (paidPostRoute[toolName]) {
        let body;
        try { body = paidPostRoute[toolName](args ?? {}); } catch (e) { return asError(e?.message ?? String(e)); }
        const r = await inferenceSettle(body, signature);
        if (r.error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'payment_failed', ...r }, null, 2) }], isError: true };
        return asText(r.data);
      }
      const route = paidRoute[toolName];
      if (!route) return asError(`unknown paid tool "${toolName}"`);
      const { path, query } = route(args ?? {});
      const r = await x402Settle(path, query, signature);
      if (r.error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'payment_failed', ...r }, null, 2) }], isError: true };
      return asText(r.data);
    },
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
