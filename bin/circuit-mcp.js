#!/usr/bin/env node
// Circuit MCP — stdio entry point. Any MCP client (Claude Desktop, Claude Code, IDEs, agent runtimes)
// spawns this and talks JSON-RPC over stdio. All logging goes to stderr; stdout is the MCP channel.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../src/server.js';

const { server, hasWallet, capCirc, totalCirc } = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `circuit-mcp ready — paid tools ${hasWallet ? `ENABLED (cap ${capCirc} CIRC/call, ${totalCirc} CIRC/session)` : 'DISABLED (no CIRCUIT_WALLET; free tools only)'}\n`,
);
