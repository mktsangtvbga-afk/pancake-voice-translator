/**
 * Generic, selector-agnostic DOM/URL helpers shared by every provider.
 * Nothing here knows about Pancake specifically — providers compose these.
 */
(function (global) {
  'use strict';

  const AUDIO_EXT_RE = /\.(mp3|wav|ogg|oga|m4a|aac|webm|opus|amr)(\?|#|$)/i;
  const AUDIO_PATH_HINT_RE = /(voice|audio|record|sound|media)/i;

  /** Heuristic: does this URL look like a playable audio asset? */
  function isAudioLikeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('data:audio')) return true;
    if (url.startsWith('blob:')) return true;
    try {
      const u = new URL(url, global.location.href);
      if (AUDIO_EXT_RE.test(u.pathname)) return true;
      if (AUDIO_PATH_HINT_RE.test(u.pathname) && (u.pathname.includes('.') === false || AUDIO_EXT_RE.test(u.pathname))) {
        return true;
      }
      return false;
    } catch (_err) {
      return AUDIO_EXT_RE.test(url);
    }
  }

  /** Heuristic: does this MIME/content-type look like audio? */
  function isAudioContentType(contentType) {
    return !!contentType && /^audio\//i.test(contentType.trim());
  }

  /**
   * Depth-first search for the first usable audio URL inside `root`:
   * <audio>/<source src>, then any data-* attribute anywhere under root
   * whose value looks like an audio URL.
   */
  function findAudioUrlInElement(root) {
    if (!root) return null;

    const media = root.querySelector('audio, video');
    if (media) {
      if (media.currentSrc) return media.currentSrc;
      if (media.src) return media.src;
      const source = media.querySelector('source[src]');
      if (source && source.src) return source.src;
    }

    const attrCandidates = root.querySelectorAll('[data-src], [data-url], [data-audio], [data-voice-url], [href]');
    for (const el of attrCandidates) {
      for (const attr of ['data-src', 'data-url', 'data-audio', 'data-voice-url', 'href']) {
        const val = el.getAttribute(attr);
        if (val && isAudioLikeUrl(val)) return val;
      }
    }

    return null;
  }

  /**
   * Poll for an audio URL to appear under `root` (many chat SPAs hydrate the
   * <audio src> lazily, e.g. only once the player is mounted/clicked).
   * @returns {Promise<string|null>}
   */
  function waitForAudioUrl(root, { timeoutMs = 2500, intervalMs = 150 } = {}) {
    return new Promise((resolve) => {
      const immediate = findAudioUrlInElement(root);
      if (immediate) return resolve(immediate);

      const startedAt = Date.now();
      const timer = setInterval(() => {
        const found = findAudioUrlInElement(root);
        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  /**
   * Strip query string/fragment before hashing a media URL for caching.
   * Chat CDNs (confirmed live: cdn.fbsbx.com) serve voice messages behind
   * signed URLs whose query tokens (oh=, oe=, dl=...) rotate on every page
   * load even though the underlying attachment is unchanged — hashing the
   * raw URL would mint a new cache key every time and defeat caching
   * entirely (translating the same message repeatedly burns Gemini quota
   * for no reason). The attachment's stable id lives in the path.
   */
  function normalizeUrlForHash(url) {
    if (!url) return url;
    if (url.startsWith('blob:') || url.startsWith('data:')) return url; // no query games here
    try {
      const u = new URL(url, global.location.href);
      return `${u.origin}${u.pathname}`;
    } catch (_err) {
      return url.split('?')[0].split('#')[0];
    }
  }

  /** SHA-256 hex digest, used for both cache keys and dedupe. */
  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(text);
    const digest = await global.crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Debounce helper used by MutationObserver callbacks. */
  function debounce(fn, waitMs) {
    let handle = null;
    return (...args) => {
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => fn(...args), waitMs);
    };
  }

  global.PVT = global.PVT || {};
  global.PVT.domUtils = {
    isAudioLikeUrl,
    isAudioContentType,
    findAudioUrlInElement,
    waitForAudioUrl,
    normalizeUrlForHash,
    sha256Hex,
    debounce,
  };
})(typeof window !== 'undefined' ? window : globalThis);
