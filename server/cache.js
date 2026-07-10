/**
 * Minimal file-backed cache so we never call Gemini twice for the same
 * voice message. Keyed by SHA-256(audio_url) (falls back to a hash of the
 * uploaded bytes when the client couldn't supply a stable URL, e.g. blob:).
 *
 * Storage: a single JSON file (cache/store.json). Fine for the traffic a
 * single Pancake team generates; swap `read`/`write` for Redis/SQLite if
 * this needs to scale across processes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'store.json');
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

let memoryStore = null;
let writeQueued = false;

function ensureLoaded() {
  if (memoryStore) return memoryStore;
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (fs.existsSync(CACHE_FILE)) {
    try {
      memoryStore = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (err) {
      console.warn('[cache] store.json corrupted, starting fresh:', err.message);
      memoryStore = {};
    }
  } else {
    memoryStore = {};
  }
  return memoryStore;
}

function flush() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(memoryStore, null, 2));
    } catch (err) {
      console.error('[cache] failed to persist store.json:', err.message);
    }
  });
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Strip query string/fragment before hashing — mirrors
// extension/lib/dom-utils.js normalizeUrlForHash(). Chat CDN URLs (e.g.
// cdn.fbsbx.com) are signed and rotate their query tokens on every page
// load even though the attachment itself is unchanged; hashing the raw URL
// would mint a new cache key every time and defeat caching entirely.
function normalizeUrlForHash(url) {
  if (!url) return url;
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch (_err) {
    return url.split('?')[0].split('#')[0];
  }
}

/** Stable cache key: prefer the client-supplied hash, fall back to URL, then raw bytes. */
function computeHash({ audioUrl, audioHash, buffer }) {
  if (audioHash && typeof audioHash === 'string' && audioHash.length === 64) return audioHash;
  if (audioUrl) return sha256(normalizeUrlForHash(audioUrl));
  if (buffer) return sha256(buffer);
  throw new Error('computeHash: cần audioUrl, audioHash hoặc buffer.');
}

function get(hash) {
  const store = ensureLoaded();
  const entry = store[hash];
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    delete store[hash];
    flush();
    return null;
  }
  return entry;
}

function set(hash, { transcript, translation, sourceLanguage }) {
  const store = ensureLoaded();
  const entry = { hash, sourceLanguage, transcript, translation, createdAt: Date.now() };
  store[hash] = entry;
  flush();
  return entry;
}

module.exports = { get, set, computeHash, sha256 };
