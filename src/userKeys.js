'use strict';

// Maps a Slack user ID to their own Bolna API key. Bolna's tools accept a
// per-call `api_key` argument that runs that one call against a different
// account than the connection was opened with — so every FDE can act as
// themselves, on their own account, through one shared bot process.
//
// MVP storage: a local JSON file, gitignored, same trust level as .env.
// If this bot ever leaves a single trusted machine, swap this for a real
// secrets store (each value is a live Bolna credential).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'user-bolna-keys.json');

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAll(map) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
}

function setKey(slackUserId, bolnaApiKey) {
  const all = loadAll();
  all[slackUserId] = bolnaApiKey;
  saveAll(all);
}

function getKey(slackUserId) {
  return loadAll()[slackUserId] || null;
}

function removeKey(slackUserId) {
  const all = loadAll();
  delete all[slackUserId];
  saveAll(all);
}

module.exports = { setKey, getKey, removeKey };
