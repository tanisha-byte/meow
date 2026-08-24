'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_TOOLS, BOLNA_TOOLS_BY_NAME } = require('./tools');
const { callBolnaTool } = require('./bolnaClient');

const anthropic = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

const THINKING_TEXT = '🥛 Meow is drinking milk…';

const SYSTEM_PROMPT = `You are Meow, a copilot for Forward Deployed Engineers (FDEs) at Bolna, a voice AI company. \
FDEs are often new, deal with clients under time pressure, and don't have full product context — your job is to answer \
questions and take actions against the connected Bolna account using the tools you have, in plain language, without \
making the FDE know Bolna's API shape.

When debugging a call, look at hangup cause, latency breakdown, and interruption stats before guessing — explain *why* \
something happened, not just what the raw fields say. When asked for a report, compute it from real execution data \
rather than estimating.

Some tools mutate the account or spend money — those pause for the FDE to confirm in Slack before they run; you will \
receive their result once confirmed or a note that they were declined. You do not need to ask for confirmation \
yourself in text — the system handles that. Just call the tool you think is right and explain what you're doing.

Keep responses to the length the question needs — a one-line answer for a one-line question, more detail for a \
debugging request. Use Slack mrkdwn (single asterisks for bold, backticks for code), not Markdown headers.`;

// ---------- conversation + pending-batch state (single process, in-memory) ----------

const conversations = new Map(); // threadKey -> Anthropic.MessageParam[]
const pendingBatches = new Map(); // batchId -> { threadKey, channel, threadTs, items: Map, messenger, requesterId, apiKey, rawAcc }
const threadLocks = new Map(); // threadKey -> Promise (tail of that thread's queue)
const rawDataStore = new Map(); // rawId -> [{ tool, input, result } | { tool, input, error }]

let batchCounter = 0;
function nextBatchId() {
  batchCounter += 1;
  return `b${Date.now()}_${batchCounter}`;
}

let rawCounter = 0;
function nextRawId() {
  rawCounter += 1;
  return `r${Date.now()}_${rawCounter}`;
}

function threadKeyOf(channel, threadTs) {
  return `${channel}:${threadTs}`;
}

function getMessages(threadKey) {
  if (!conversations.has(threadKey)) conversations.set(threadKey, []);
  return conversations.get(threadKey);
}

// Serializes everything that reads-then-mutates a thread's message history.
// Without this, a second message landing on the same thread while the first
// is still mid-flight (e.g. between pushing the user turn and the `await`
// on the "thinking" post) can interleave with it on the same shared array —
// which is how the conversation ends up with two messages appended out of
// order and Claude sees a trailing assistant turn ("prefill") instead of the
// user turn that was just pushed.
function withThreadLock(threadKey, fn) {
  const prev = threadLocks.get(threadKey) || Promise.resolve();
  const run = prev.then(fn, fn);
  threadLocks.set(threadKey, run.catch(() => {}));
  return run;
}

// ---------- formatting helpers ----------

function summarizeArgs(input) {
  const json = JSON.stringify(input, null, 2);
  return json.length > 800 ? `${json.slice(0, 800)}…` : json;
}

function confirmBlocksFor(batchId, toolUseId, toolDef, input) {
  const isDanger = toolDef.tier === 'danger';
  const header = isDanger ? `⚠️ *${toolDef.name}* — ${toolDef.warning || 'This is irreversible or costs money.'}` : `*${toolDef.name}*`;
  const value = JSON.stringify({ batchId, id: toolUseId });

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${header}\n\`\`\`${summarizeArgs(input)}\`\`\`` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'run_tool',
          value,
          style: isDanger ? 'danger' : 'primary',
          text: { type: 'plain_text', text: isDanger ? 'Run it (irreversible)' : 'Run it', emoji: true },
          confirm: {
            title: { type: 'plain_text', text: isDanger ? 'Are you sure?' : 'Confirm' },
            text: { type: 'mrkdwn', text: isDanger ? (toolDef.warning || 'This cannot be undone.') : `This will call \`${toolDef.name}\` on your real Bolna account.` },
            confirm: { type: 'plain_text', text: isDanger ? 'Yes, do it' : 'Yes' },
            deny: { type: 'plain_text', text: 'Cancel' },
            style: isDanger ? 'danger' : 'primary',
          },
        },
        {
          type: 'button',
          action_id: 'cancel_tool',
          value,
          text: { type: 'plain_text', text: 'Cancel', emoji: true },
        },
      ],
    },
  ];
}

function rawDataButtonBlocks(rawId) {
  return [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'view_raw_data',
          value: rawId,
          text: { type: 'plain_text', text: '🔎 View raw data', emoji: true },
        },
      ],
    },
  ];
}

// Renders the exact tool calls (name, args, and the real Bolna response or
// error) an answer was grounded in — so an FDE can check a number against
// its source instead of trusting Claude's summary of it.
function formatRawData(rawAcc) {
  return rawAcc
    .map(({ tool, input, result, error }) => {
      const body = error ? `Error: ${error}` : JSON.stringify(result, null, 2);
      const args = input && Object.keys(input).length ? `${JSON.stringify(input)}\n` : '';
      return `*${tool}*\n${args}\`\`\`${body}\`\`\``;
    })
    .join('\n\n');
}

function getRawData(rawId) {
  return rawDataStore.get(rawId) || null;
}

// Turns the shared "thinking" bubble into the first real thing Meow has to
// show (text, or the first confirm card); anything after that just posts as
// a normal new message. One bubble per user turn, not per Claude round-trip.
function makeReveal(messenger, thinkingTs) {
  let used = false;
  return async (text, blocks) => {
    if (!used) {
      used = true;
      return messenger.update(thinkingTs, text, blocks);
    }
    return messenger.post(text, blocks);
  };
}

// ---------- the core loop ----------

async function callClaude(messages) {
  return anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages,
    tools: CLAUDE_TOOLS,
  });
}

function toolResultBlock(toolUseId, content, isError) {
  const block = { type: 'tool_result', tool_use_id: toolUseId, content: typeof content === 'string' ? content : JSON.stringify(content) };
  if (isError) block.is_error = true;
  return block;
}

// `defaultApiKey` is the requester's own Bolna key. It's injected as the
// `api_key` argument on every call UNLESS Claude explicitly set one itself
// (e.g. the FDE asked to act on a specific sub-account) — an explicit
// Claude-supplied value always wins over the per-user default.
// `rawAcc`, if given, collects the real tool name/args/result so the FDE can
// later check the answer against its actual source via "View raw data".
async function runTool(toolUse, defaultApiKey, rawAcc) {
  try {
    const args = { ...(toolUse.input || {}) };
    if (!args.api_key && defaultApiKey) args.api_key = defaultApiKey;
    const result = await callBolnaTool(toolUse.name, args);
    if (rawAcc) rawAcc.push({ tool: toolUse.name, input: toolUse.input, result });
    return toolResultBlock(toolUse.id, result, false);
  } catch (err) {
    if (rawAcc) rawAcc.push({ tool: toolUse.name, input: toolUse.input, error: err.message });
    return toolResultBlock(toolUse.id, `Error: ${err.message}`, true);
  }
}

// Advances the conversation for `threadKey` one Claude turn at a time.
// `reveal` resolves the shared "thinking" bubble the first time there's
// something worth showing; `messenger` handles everything after that.
// `requesterId`/`apiKey` identify whose Bolna account this turn runs against.
async function advance(threadKey, channel, threadTs, messenger, reveal, requesterId, apiKey, rawAcc) {
  const messages = getMessages(threadKey);
  const response = await callClaude(messages);

  const textParts = [];
  const toolUses = [];
  for (const block of response.content) {
    if (block.type === 'text' && block.text.trim()) textParts.push(block.text.trim());
    else if (block.type === 'tool_use') toolUses.push(block);
  }

  if (textParts.length) await reveal(textParts.join('\n\n'));

  if (toolUses.length === 0) {
    if (!textParts.length) await reveal("(Meow didn't say anything back — try rephrasing?)");
    if (rawAcc.length) {
      const rawId = nextRawId();
      rawDataStore.set(rawId, rawAcc);
      await reveal(null, rawDataButtonBlocks(rawId));
    }
    messages.push({ role: 'assistant', content: response.content });
    return;
  }

  const needsConfirm = toolUses.filter((tu) => BOLNA_TOOLS_BY_NAME[tu.name] && BOLNA_TOOLS_BY_NAME[tu.name].tier !== 'read');
  const autoRun = toolUses.filter((tu) => !needsConfirm.includes(tu));

  if (needsConfirm.length === 0) {
    const results = await Promise.all(autoRun.map((tu) => runTool(tu, apiKey, rawAcc)));
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: results });
    return advance(threadKey, channel, threadTs, messenger, reveal, requesterId, apiKey, rawAcc);
  }

  // At least one write/danger tool was requested: pause this batch. Run the
  // auto (read) ones now so they're ready the moment confirmations land.
  const autoResults = await Promise.all(autoRun.map((tu) => runTool(tu, apiKey, rawAcc)));
  const batchId = nextBatchId();
  const items = new Map();
  for (const tu of autoRun) items.set(tu.id, { toolUse: tu, status: 'auto', result: autoResults[autoRun.indexOf(tu)] });
  for (const tu of needsConfirm) items.set(tu.id, { toolUse: tu, status: 'pending', result: null });

  pendingBatches.set(batchId, { threadKey, channel, threadTs, items, messenger, requesterId, apiKey, rawAcc });
  messages.push({ role: 'assistant', content: response.content });

  for (const tu of needsConfirm) {
    const toolDef = BOLNA_TOOLS_BY_NAME[tu.name];
    await reveal(null, confirmBlocksFor(batchId, tu.id, toolDef, tu.input));
  }
}

async function startTurn({ channel, threadTs, userText, messenger, requesterId, apiKey }) {
  const threadKey = threadKeyOf(channel, threadTs);
  return withThreadLock(threadKey, async () => {
    const messages = getMessages(threadKey);
    messages.push({ role: 'user', content: userText });
    const thinkingMsg = await messenger.post(THINKING_TEXT);
    await advance(threadKey, channel, threadTs, messenger, makeReveal(messenger, thinkingMsg.ts), requesterId, apiKey, []);
  });
}

// Called from the button handler. Returns 'confirmed' | 'declined' | 'unknown'
// | 'forbidden' (someone other than the original requester clicked), and if
// this was the last pending item in its batch, finishes the batch.
async function resolveBatchItem(batchId, itemId, decision, clickerId) {
  const batch = pendingBatches.get(batchId);
  if (!batch) return 'unknown';
  if (batch.requesterId && clickerId !== batch.requesterId) return 'forbidden';
  const item = batch.items.get(itemId);
  if (!item || item.status !== 'pending') return 'unknown';

  item.status = decision; // 'confirmed' | 'declined'

  const stillPending = [...batch.items.values()].some((i) => i.status === 'pending');
  if (stillPending) return decision;

  pendingBatches.delete(batchId);

  await withThreadLock(batch.threadKey, async () => {
    const results = [];
    for (const { toolUse, status, result } of batch.items.values()) {
      if (status === 'auto') {
        results.push(result);
      } else if (status === 'confirmed') {
        results.push(await runTool(toolUse, batch.apiKey, batch.rawAcc));
      } else {
        results.push(toolResultBlock(toolUse.id, 'The FDE clicked Cancel — this action was not run.', false));
      }
    }

    const messages = getMessages(batch.threadKey);
    messages.push({ role: 'user', content: results });
    const thinkingMsg = await batch.messenger.post(THINKING_TEXT);
    await advance(batch.threadKey, batch.channel, batch.threadTs, batch.messenger, makeReveal(batch.messenger, thinkingMsg.ts), batch.requesterId, batch.apiKey, batch.rawAcc);
  });

  return decision;
}

module.exports = { startTurn, resolveBatchItem, threadKeyOf, getRawData, formatRawData };
