#!/usr/bin/env node
// Circuit MCP — stdio entry point. Any MCP client (Claude Desktop, Claude Code, IDEs, agent runtimes)
// spawns this and talks JSON-RPC over stdio. All logging goes to stderr; stdout is the MCP channel.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../src/server.js';

const { server, hasWallet, capCirc, totalCirc, payToken } = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
const settle = payToken ? ` — settling in token ${payToken.slice(0, 4)}…${payToken.slice(-4)} where accepted, else CIRC` : '';
process.stderr.write(
  `circuit-mcp ready — paid tools ${hasWallet ? `ENABLED (cap ${capCirc} CIRC/call, ${totalCirc} CIRC/session)${settle}` : 'DISABLED (no CIRCUIT_WALLET; free tools only)'}\n`,
);
