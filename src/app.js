'use strict';

require('dotenv').config();
const { App, LogLevel } = require('@slack/bolt');
const { startTurn, resolveBatchItem, getRawData, formatRawData } = require('./lib');
const userKeys = require('./userKeys');

for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY', 'BOLNA_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in the environment. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// A flaky network (laptop sleep, wifi drop, VPN toggle) can throw from deep
// inside the socket-mode client outside any try/catch we control. Left
// unhandled, that either crashes the process silently or leaves it half-
// connected forever. Log and exit instead — the run-forever wrapper
// (npm run start:forever) restarts it fresh within a couple seconds.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection, restarting:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, restarting:', err);
  process.exit(1);
});

const NOT_CONNECTED_TEXT =
  "You haven't connected your own Bolna account yet, so I won't act using anyone else's. " +
  'Run `/meow-connect <your-bolna-api-key>` (get it from platform.bolna.ai → Developers) — that reply is only visible to you, in any channel.';

// Slack rejects (`msg_too_long`) any single message text past a few thousand
// characters; Claude's replies aren't bounded to that, so long answers (e.g.
// a debugging writeup or a big tool dump) need to be split across messages
// rather than sent as one oversized `text`.
const SLACK_TEXT_LIMIT = 3000;

function splitForSlack(text, limit = SLACK_TEXT_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function makeMessenger(client, channel, threadTs) {
  const fallbackText = 'Meow needs your input — see the buttons below.';
  return {
    post: async (text, blocks) => {
      const chunks = !blocks && text ? splitForSlack(text) : [text || fallbackText];
      const first = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: chunks[0],
        ...(blocks ? { blocks } : {}),
      });
      for (const chunk of chunks.slice(1)) {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
      }
      return first;
    },
    update: async (ts, text, blocks) => {
      const chunks = !blocks && text ? splitForSlack(text) : [text || fallbackText];
      const first = await client.chat.update({
        channel,
        ts,
        text: chunks[0],
        ...(blocks ? { blocks } : {}),
      });
      for (const chunk of chunks.slice(1)) {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
      }
      return first;
    },
  };
}

// Registration: slash-command arguments are never broadcast to the channel
// (only Slack and this app ever see them), and the reply is always ephemeral
// so the key is never echoed back to anyone, including the person who ran it.
app.command('/meow-connect', async ({ command, ack, client }) => {
  await ack();
  const apiKey = command.text && command.text.trim();
  if (!apiKey || !/^(bn|sa)-/.test(apiKey)) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: 'Usage: `/meow-connect <your-bolna-api-key>` — a key starting with `bn-` (main account) or `sa-` (sub-account). This works in any channel — only you see the reply.',
    });
    return;
  }
  userKeys.setKey(command.user_id, apiKey);
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: `✅ Connected — I'll act on *your* Bolna account (key ending \`…${apiKey.slice(-4)}\`) from now on. Run \`/meow-connect\` again anytime to swap it.`,
  });
});

// Slash command: /meow <question>
app.command('/meow', async ({ command, ack, client }) => {
  await ack();
  const apiKey = userKeys.getKey(command.user_id);
  if (!apiKey) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: NOT_CONNECTED_TEXT });
    return;
  }

  const question = command.text && command.text.trim();
  if (!question) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: 'Ask it something, e.g. `/meow why did the last call to my test agent fail?`',
    });
    return;
  }

  const root = await client.chat.postMessage({
    channel: command.channel_id,
    text: `*<@${command.user_id}> asked:* ${question}`,
  });

  const messenger = makeMessenger(client, command.channel_id, root.ts);
  try {
    await startTurn({ channel: command.channel_id, threadTs: root.ts, userText: question, messenger, requesterId: command.user_id, apiKey });
  } catch (err) {
    console.error(err);
    await messenger.post(`Something went wrong on my end: ${err.message}`);
  }
});

// @mention in a channel
app.event('app_mention', async ({ event, client }) => {
  const threadTs = event.thread_ts || event.ts;
  const messenger = makeMessenger(client, event.channel, threadTs);

  const apiKey = userKeys.getKey(event.user);
  if (!apiKey) {
    await messenger.post(NOT_CONNECTED_TEXT);
    return;
  }

  const question = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!question) {
    await messenger.post("What do you need? e.g. \"why did the last call to my test agent fail\"");
    return;
  }
  try {
    await startTurn({ channel: event.channel, threadTs, userText: question, messenger, requesterId: event.user, apiKey });
  } catch (err) {
    console.error(err);
    await messenger.post(`Something went wrong on my end: ${err.message}`);
  }
});

// Direct messages to the bot
app.message(async ({ message, client }) => {
  if (message.subtype || message.bot_id || !message.text) return;
  if (message.channel_type !== 'im') return; // channels are handled via @mention above
  const threadTs = message.thread_ts || message.ts;
  const messenger = makeMessenger(client, message.channel, threadTs);

  const apiKey = userKeys.getKey(message.user);
  if (!apiKey) {
    await messenger.post(NOT_CONNECTED_TEXT);
    return;
  }

  try {
    await startTurn({ channel: message.channel, threadTs, userText: message.text, messenger, requesterId: message.user, apiKey });
  } catch (err) {
    console.error(err);
    await messenger.post(`Something went wrong on my end: ${err.message}`);
  }
});

async function onConfirmationButton(decision, { action, ack, respond, body }) {
  await ack();
  let parsed;
  try {
    parsed = JSON.parse(action.value);
  } catch {
    await respond({ replace_original: false, text: "Couldn't read that button — try asking again." });
    return;
  }
  const clickerId = body.user && body.user.id;
  const outcome = await resolveBatchItem(parsed.batchId, parsed.id, decision, clickerId);

  if (outcome === 'forbidden') {
    await respond({ replace_original: false, response_type: 'ephemeral', text: 'Only the person who asked Meow this can confirm or cancel it.' });
    return;
  }
  if (outcome === 'unknown') {
    await respond({ replace_original: true, text: 'This already resolved or expired.' });
    return;
  }
  await respond({
    replace_original: true,
    text: decision === 'confirmed' ? '✅ Confirmed — running it now…' : '❌ Cancelled.',
  });
}

app.action('run_tool', (args) => onConfirmationButton('confirmed', args));
app.action('cancel_tool', (args) => onConfirmationButton('declined', args));

// Lets the FDE check any answer against the exact Bolna tool call(s) it was
// grounded in, instead of trusting Claude's summary of the data.
const RAW_DATA_RESPOND_LIMIT = 5; // response_url reuse is capped by Slack; keep this well under it
app.action('view_raw_data', async ({ action, ack, respond }) => {
  await ack();
  try {
    const rawAcc = getRawData(action.value);
    if (!rawAcc) {
      await respond({ replace_original: false, response_type: 'ephemeral', text: "That raw data isn't available anymore (the bot may have restarted since)." });
      return;
    }
    const chunks = splitForSlack(formatRawData(rawAcc));
    for (const chunk of chunks.slice(0, RAW_DATA_RESPOND_LIMIT)) {
      await respond({ replace_original: false, response_type: 'ephemeral', text: chunk });
    }
    if (chunks.length > RAW_DATA_RESPOND_LIMIT) {
      await respond({
        replace_original: false,
        response_type: 'ephemeral',
        text: `…truncated ${chunks.length - RAW_DATA_RESPOND_LIMIT} more chunk(s) — the raw data was very large.`,
      });
    }
  } catch (err) {
    // response_url expires ~30min after the message was posted — clicking an
    // old button 404s here. Nothing to recover; just don't crash the process.
    console.error('view_raw_data failed:', err.message);
  }
});

// Free hosts that only offer "web services" (Render's free plan, most PaaS
// free tiers) require the process to bind $PORT, and spin the service down
// after ~15 minutes with no inbound request. Socket Mode has no inbound HTTP
// of its own, so expose a tiny health endpoint: it satisfies the port check
// and gives an external pinger something to hit to keep the service awake.
// Locally $PORT is unset and none of this runs.
function startHealthEndpoint() {
  if (!process.env.PORT) return;
  require('http')
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('meow ok\n');
    })
    .listen(process.env.PORT, () => console.log(`Health endpoint listening on :${process.env.PORT}`));
}

(async () => {
  await app.start();
  startHealthEndpoint();
  console.log('⚡️ Meow is running (Socket Mode).');

  // Surfaces a bad USER_KEYS_JSON at boot rather than at the moment an FDE
  // first asks Meow something. Zero on a host with an ephemeral disk means
  // every registration is gone and everyone will be told to reconnect.
  const known = userKeys.count();
  console.log(`${known} registered user(s) known at boot.`);
  if (known === 0) {
    console.warn('No registered users. On an ephemeral host, check that USER_KEYS_JSON is the full JSON object from data/user-bolna-keys.json.');
  }
})();
