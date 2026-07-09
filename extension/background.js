/**
 * MV3 service worker. Responsibilities:
 *   - Own all network I/O to Pancake's CDN and to our own backend (content
 *     scripts should not talk to the backend directly — keeps the extension
 *     free of API keys and gives us one place to enforce the backend URL).
 *   - Client-side cache (chrome.storage.local) keyed by SHA-256(audio_url)
 *     so we never re-call the backend/Gemini for a voice message the user
 *     already translated, even across tabs/sessions.
 *   - TTS proxying for "Nghe tiếng Việt".
 */

const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:5175',
};
const CACHE_PREFIX = 'pvt_cache_';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUDIO_DOWNLOAD_TIMEOUT_MS = 20000; // fetching the raw voice clip from the chat platform's CDN
// These must stay comfortably ABOVE what the server can take: gemini.js
// retries once on timeout (up to ~2x GEMINI_TIMEOUT_MS, 45s default each =
// ~90s worst case) / TTS_TIMEOUT_MS (20s default) — otherwise the extension
// gives up and shows a misleading "timeout" error while the backend (or a
// retry) is still working.
const TRANSLATE_TIMEOUT_MS = 110000;
const SPEAK_TIMEOUT_MS = 30000;

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function getCached(hash) {
  const key = CACHE_PREFIX + hash;
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry;
}

async function setCached(hash, data) {
  const key = CACHE_PREFIX + hash;
  await chrome.storage.local.set({
    [key]: { ...data, createdAt: Date.now() },
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout sau ${ms}ms`)), ms)),
  ]);
}

async function fetchAudioAsFormPart(audioUrl) {
  // No cookies needed: chat-platform CDNs (e.g. cdn.fbsbx.com) serve voice
  // messages via pre-signed URLs (expiry/signature baked into the query
  // string). 'include' bought us nothing here but did opt the request into
  // stricter CORS handling, so we omit credentials entirely.
  const res = await withTimeout(fetch(audioUrl, { credentials: 'omit' }), AUDIO_DOWNLOAD_TIMEOUT_MS, 'Tải audio');
  if (!res.ok) {
    throw new Error(`Không tải được audio gốc (HTTP ${res.status}). Có thể link đã hết hạn hoặc yêu cầu đăng nhập.`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('File audio rỗng.');
  return blob;
}

async function handleTranslateAudio(message) {
  const { audioHash, audioUrl, audioBuffer, mimeType, pageUrl } = message;
  if (!audioHash) throw new Error('Thiếu audioHash.');

  const cached = await getCached(audioHash);
  if (cached) {
    return { sourceLanguage: cached.sourceLanguage, transcript: cached.transcript, translation: cached.translation, fromCache: true };
  }

  let blob;
  if (audioBuffer) {
    blob = new Blob([audioBuffer], { type: mimeType || 'audio/mpeg' });
  } else if (audioUrl) {
    blob = await fetchAudioAsFormPart(audioUrl);
  } else {
    throw new Error('Không có dữ liệu audio để dịch.');
  }

  const { backendUrl } = await getSettings();
  const form = new FormData();
  form.append('audio', blob, 'voice-message');
  form.append('audioUrl', audioUrl || '');
  form.append('audioHash', audioHash);
  form.append('sourcePage', pageUrl || '');

  let res;
  try {
    res = await withTimeout(
      fetch(`${backendUrl}/translate-audio`, { method: 'POST', body: form }),
      TRANSLATE_TIMEOUT_MS,
      'Dịch giọng nói'
    );
  } catch (err) {
    throw new Error(`Không kết nối được backend (${backendUrl}): ${err.message}`);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Backend lỗi (HTTP ${res.status}).`);
  }

  const data = await res.json();
  await setCached(audioHash, data);
  return data;
}

async function handleSpeakText(message) {
  const { text } = message;
  if (!text || !text.trim()) throw new Error('Không có nội dung để đọc.');

  const { backendUrl } = await getSettings();
  let res;
  try {
    res = await withTimeout(
      fetch(`${backendUrl}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
      SPEAK_TIMEOUT_MS,
      'TTS'
    );
  } catch (err) {
    throw new Error(`Không kết nối được dịch vụ đọc (${backendUrl}): ${err.message}`);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `TTS lỗi (HTTP ${res.status}).`);
  }

  const blob = await res.blob();
  const audioDataUrl = await blobToDataUrl(blob);
  return { audioDataUrl };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Không đọc được audio phản hồi.'));
    reader.readAsDataURL(blob);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  (async () => {
    try {
      if (message.type === 'TRANSLATE_AUDIO') {
        const data = await handleTranslateAudio(message);
        sendResponse({ ok: true, data });
      } else if (message.type === 'SPEAK_TEXT') {
        const data = await handleSpeakText(message);
        sendResponse({ ok: true, data });
      } else if (message.type === 'GET_SETTINGS') {
        sendResponse({ ok: true, data: await getSettings() });
      } else if (message.type === 'SET_SETTINGS') {
        await chrome.storage.sync.set(message.settings || {});
        sendResponse({ ok: true, data: await getSettings() });
      } else if (message.type === 'CLEAR_CACHE') {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
        await chrome.storage.local.remove(keys);
        sendResponse({ ok: true, data: { cleared: keys.length } });
      } else {
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error('[PVT background]', message.type, err);
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();

  return true; // keep the message channel open for the async response above
});
