/**
 * Runs in the page's MAIN world (see manifest.json "world": "MAIN").
 * Pancake, like most SPAs, resolves the real voice-message URL through an
 * XHR/fetch call before wiring it into the player. This patches both APIs
 * to observe *any* audio-like response and rebroadcasts it as a DOM
 * CustomEvent so the isolated-world content script can correlate it with
 * the voice-message element the user is hovering.
 *
 * MAIN and ISOLATED worlds do not share JS globals (only the DOM), so
 * CustomEvent is the bridge — never assume window.* set here is visible
 * to content.js.
 */
(function () {
  'use strict';

  const EVENT_NAME = 'pvt:network-audio';
  const MAX_BUFFER = 30;
  const buffer = [];

  function emit(url, contentType) {
    if (!url) return;
    const entry = { url, contentType: contentType || '', ts: Date.now() };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: entry }));
  }

  function looksLikeAudio(url, contentType) {
    if (contentType && /^audio\//i.test(contentType)) return true;
    if (typeof url === 'string' && /\.(mp3|wav|ogg|oga|m4a|aac|webm|opus|amr)(\?|#|$)/i.test(url)) return true;
    return false;
  }

  // --- fetch ---
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = response.url || (typeof args[0] === 'string' ? args[0] : args[0] && args[0].url);
        const contentType = response.headers && response.headers.get ? response.headers.get('content-type') : '';
        if (looksLikeAudio(url, contentType)) emit(url, contentType);
      } catch (_err) {
        // Never let observability break the page's real network call.
      }
      return response;
    };
  }

  // --- XMLHttpRequest ---
  const OriginalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__pvtUrl = url;
    return OriginalOpen.call(this, method, url, ...rest);
  };

  const OriginalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener('load', () => {
      try {
        const contentType = this.getResponseHeader ? this.getResponseHeader('content-type') : '';
        const finalUrl = this.responseURL || this.__pvtUrl;
        if (looksLikeAudio(finalUrl, contentType)) emit(finalUrl, contentType);
      } catch (_err) {
        // ignore
      }
    });
    return OriginalSend.apply(this, args);
  };

  // Let the isolated world ask for the whole buffer on demand (e.g. right
  // after a "Dịch" click, to catch URLs that fired just before injection).
  document.addEventListener('pvt:query-network-audio', () => {
    document.dispatchEvent(new CustomEvent('pvt:network-audio-snapshot', { detail: buffer.slice() }));
  });
})();
