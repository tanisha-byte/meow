'use strict';

// Maps a Slack user ID to their own Bolna API key. Bolna's tools accept a
// per-call `api_key` argument that runs that one call against a different
// account than the connection was opened with — so every FDE can act as
// themselves, on their own account, through one shared bot process.
//
// MVP storage: a local JSON file, gitignored, same trust level as .env.
// If this bot ever leaves a single trusted machine, swap this for a real
// secrets store (each value is a live Bolna credential).
//
// DATA_DIR must point at a persistent volume when this runs on a platform
// that rebuilds the filesystem on every deploy (e.g. Railway) — otherwise
// every FDE's registration is silently wiped on the next `railway up`.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'user-bolna-keys.json');

// Free hosts give you an ephemeral filesystem: every restart and every deploy
// wipes the data directory, which would silently log out every registered FDE
// and leave them staring at the "you haven't connected your account" reply.
// USER_KEYS_JSON is a baseline read at boot so the known registrations survive
// a restart even though the file does not. Anyone who runs /meow-connect after
// that persists only until the next restart — copy their entry into the env
// var to make it durable. On a box with a real disk, leave USER_KEYS_JSON
// unset and this is a no-op.
function seedFromEnv() {
  if (!process.env.USER_KEYS_JSON) return {};
  try {
    return JSON.parse(process.env.USER_KEYS_JSON);
  } catch (err) {
    console.error('USER_KEYS_JSON is not valid JSON, ignoring it:', err.message);
    return {};
  }
}

// The on-disk file wins over the seed, so a fresh /meow-connect always beats a
// stale env var for the same user.
function loadAll() {
  const seed = seedFromEnv();
  try {
    return { ...seed, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return seed;
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
