// Smoke test — spawn the server over real stdio via the MCP client, list tools, and call two FREE
// tools end-to-end against the public data API (no wallet, no spend). Exits non-zero on failure.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CIRC = '8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump';

const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/circuit-mcp.js')] });
const client = new Client({ name: 'circuit-mcp-smoke', version: '0.0.0' });

let failures = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check(tools.length >= 24, `listed ${tools.length} tools`, names.join(', '));
  check(names.includes('swarm_feed') && names.includes('token_security'), 'core tools present');
  check(['swarm_leaderboard', 'swarm_holdings', 'swarm_blacklist_check', 'swarm_insights', 'wallet_pnl', 'slippage_buy', 'new_tokens', 'market_regime'].every((n) => names.includes(n)), 'new tools registered');
  check(tools.every((t) => t.annotations?.readOnlyHint === true), 'all tools annotated read-only');

  const q = await client.callTool({ name: 'circuit_quote', arguments: {} });
  check(!q.isError && !!q.content?.[0]?.text, 'circuit_quote (free) returned data', q.content?.[0]?.text?.slice(0, 60)?.replace(/\n/g, ' '));

  const p = await client.callTool({ name: 'token_price', arguments: { mint: CIRC } });
  check(!p.isError && /price|usd/i.test(p.content?.[0]?.text ?? ''), 'token_price (free) returned a price');

  // New FREE swarm tools should return data with no wallet and no spend.
  const h = await client.callTool({ name: 'swarm_holdings', arguments: {} });
  check(!h.isError && /holdings/i.test(h.content?.[0]?.text ?? ''), 'swarm_holdings (free) returned data');
  const lb = await client.callTool({ name: 'swarm_leaderboard', arguments: { limit: 3 } });
  check(!lb.isError && /leaderboard|reputation/i.test(lb.content?.[0]?.text ?? ''), 'swarm_leaderboard (free) returned data');

  // A paid tool with no wallet must fail gracefully with a clear hint (not crash).
  const s = await client.callTool({ name: 'token_security', arguments: { mint: CIRC } });
  check(s.isError && /CIRCUIT_WALLET|CIRC/i.test(s.content?.[0]?.text ?? ''), 'paid tool w/o wallet → friendly error', s.content?.[0]?.text?.slice(0, 70));

  // Prompts and resources should be registered.
  const { prompts } = await client.listPrompts();
  check(prompts.length >= 3 && ['rug_check', 'ape_check', 'swarm_pulse'].every((n) => prompts.some((p2) => p2.name === n)), `listed ${prompts.length} prompts`, prompts.map((p2) => p2.name).join(', '));
  const { resources } = await client.listResources();
  check(resources.length >= 4, `listed ${resources.length} resources`, resources.map((r) => r.uri).join(', '));
} catch (e) {
  check(false, 'unexpected exception', e.message);
} finally {
  await client.close().catch(() => {});
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
