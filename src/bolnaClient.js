'use strict';

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const BOLNA_MCP_URL = 'https://mcp.bolna.ai/api/mcp';

let clientPromise = null;

function connect() {
  if (!process.env.BOLNA_API_KEY) {
    throw new Error('BOLNA_API_KEY is not set.');
  }
  const client = new Client({ name: 'switchboard-slack', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(BOLNA_MCP_URL), {
    authProvider: { token: async () => process.env.BOLNA_API_KEY },
  });
  return client.connect(transport).then(() => client);
}

// Connects once, lazily, and reuses the same session for every call.
function getClient() {
  if (!clientPromise) clientPromise = connect();
  return clientPromise;
}

// Calls a real Bolna tool. Returns the tool's JSON payload (parsed from the
// first text content block) or throws with a readable message on failure.
async function callBolnaTool(name, args) {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args || {} });

  const textBlock = (result.content || []).find((b) => b.type === 'text');
  const raw = textBlock ? textBlock.text : '';

  if (result.isError) {
    throw new Error(raw || `${name} failed with no error message.`);
  }

  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // some tools (search_docs, get_doc) return plain text/markdown
  }
}

module.exports = { callBolnaTool, getClient };
