/**
 * Isolated-world mirror of lib/network-hook.js's capture buffer. Listens on
 * the DOM (the only channel shared with the MAIN-world injector) and keeps
 * a local copy so providers can do best-effort correlation between "user
 * clicked Dịch on container X" and "an audio response was seen around the
 * same time".
 */
(function (global) {
  'use strict';

  const buffer = [];
  const MAX_BUFFER = 30;

  document.addEventListener('pvt:network-audio', (evt) => {
    if (!evt || !evt.detail) return;
    buffer.push(evt.detail);
    if (buffer.length > MAX_BUFFER) buffer.shift();
  });

  document.addEventListener('pvt:network-audio-snapshot', (evt) => {
    if (!Array.isArray(evt.detail)) return;
    for (const entry of evt.detail) {
      if (!buffer.some((b) => b.url === entry.url && b.ts === entry.ts)) {
        buffer.push(entry);
      }
    }
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  });

  function requestSnapshot() {
    document.dispatchEvent(new CustomEvent('pvt:query-network-audio'));
  }

  /** Most recent audio URL seen within `withinMs` of now, if any. */
  function getRecent(withinMs = 4000) {
    const cutoff = Date.now() - withinMs;
    const candidates = buffer.filter((b) => b.ts >= cutoff);
    return candidates.length ? candidates[candidates.length - 1].url : null;
  }

  global.PVT = global.PVT || {};
  global.PVT.networkAudio = { requestSnapshot, getRecent };
})(typeof window !== 'undefined' ? window : globalThis);
