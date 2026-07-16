// payToken gating — unit check of the x402 Universal Adapter wiring in buildServer(). No network, no spend:
// we only assert which env combinations enable paying in a registered token vs falling back to CIRC.
// The rule is fail-closed — a foreign token is only paid when there's a wallet, a valid mint, AND a per-call
// ceiling; anything else drops back to CIRC.
import assert from 'node:assert';
import { buildServer } from '../src/server.js';
import { generateKeypair, secretKeyBase58 } from '@circuit-llm/wallet';

process.env.CIRCUIT_SUPPRESS_RPC_WARNING = '1';
const SECRET = secretKeyBase58(generateKeypair());
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC — a valid base58 mint to stand in for a registered token

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`); if (!ok) failures++; };

const KEYS = ['CIRCUIT_WALLET', 'CIRCUIT_PAYMENT_MINT', 'CIRCUIT_MCP_MAX_PAYTOKEN', 'CIRCUIT_MCP_MAX_TOTAL_PAYTOKEN'];
// Build with an isolated env patch (buildServer reads process.env for both the wallet and the config).
const build = (patch) => {
  const saved = { ...process.env };
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try { return buildServer({ log: () => {} }); }
  finally { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, saved); }
};

// 1. mint but no wallet → disabled (nothing to send the token with)
check(build({ CIRCUIT_PAYMENT_MINT: MINT }).payToken === undefined, 'mint without wallet → CIRC (payToken off)');

// 2. wallet + mint but NO per-call ceiling → disabled (fail-closed: never pay a foreign token unbounded)
check(build({ CIRCUIT_WALLET: SECRET, CIRCUIT_PAYMENT_MINT: MINT }).payToken === undefined, 'mint without ceiling → CIRC (fail-closed)');

// 3. wallet + ceiling but INVALID mint → disabled
check(build({ CIRCUIT_WALLET: SECRET, CIRCUIT_PAYMENT_MINT: 'not-a-mint', CIRCUIT_MCP_MAX_PAYTOKEN: '1000000' }).payToken === undefined, 'invalid mint → CIRC');

// 4. wallet + valid mint + ceiling → ENABLED (pays this token where accepted)
check(build({ CIRCUIT_WALLET: SECRET, CIRCUIT_PAYMENT_MINT: MINT, CIRCUIT_MCP_MAX_PAYTOKEN: '1000000' }).payToken === MINT, 'wallet + mint + ceiling → payToken enabled');

console.log(failures === 0 ? '\nPAYTOKEN PASS' : `\nPAYTOKEN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
