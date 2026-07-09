/**
 * Adapter for Pancake (https://pancake.vn, https://pages.fm). Deliberately avoids hardcoded
 * Pancake CSS class names — those are minified/rotated by their build and
 * will break silently on the next deploy. Instead we detect voice messages
 * structurally:
 *
 *   1. Any native <audio> element is almost certainly a voice-message
 *      player (Pancake, like virtually every chat UI, renders voice notes
 *      as HTML5 audio, not a custom canvas/webgl waveform).
 *   2. We walk a bounded number of ancestors up from the <audio> tag to
 *      find a "message bubble"-shaped container (something with several
 *      children, block layout, occurring inside a scrollable list) to use
 *      as the anchor for injecting our toolbar, so we never mutate the
 *      audio player's own subtree.
 *
 * If Pancake's markup turns out to need something more specific once you
 * inspect it live in DevTools, tune BUBBLE_ANCESTOR_HOPS / the hint regex
 * below — the rest of the extension does not need to change.
 */
(function (global) {
  'use strict';

  const { waitForAudioUrl, findAudioUrlInElement } = global.PVT.domUtils;
  const AudioProvider = global.PVT.AudioProvider;

  const BUBBLE_ANCESTOR_HOPS = 4;
  const BUBBLE_HINT_RE = /(message|bubble|chat|msg|conversation|voice)/i;
  const PANCAKE_HOST_RE = /(^|\.)(pancake\.vn|pages\.fm)$/i;

  // Pancake's player renders the <audio> tag up front but only resolves its
  // real src once the user presses its own Play button (confirmed live:
  // audio.src/currentSrc are empty until then). We can't wait for a real
  // user click, so we simulate one on Pancake's own control — muted, and
  // paused again the instant a src shows up — to force the load silently.
  const SPEED_LABEL_RE = /^\s*\d+(\.\d+)?x\s*$/i; // "1x", "1.5x" playback-rate control
  const NON_PLAY_HINT_RE = /(download|speed|tốc\s*độ)/i;

  // Confirmed live via DevTools (2026-07-08): Pancake's Play control has no
  // <button>, no role, no aria-label — it's a bare
  // <div class="icon-container"><svg><path d="M240,128a15.74..."/></svg></div>.
  // Matching the icon's own path shape is the most reliable signal we have.
  const PLAY_ICON_PATH_SIGNATURE = 'M240,128a15.74,15.74,0,0,1-7.6,13.51';

  function findPlayTrigger(container) {
    const pathMatch = Array.from(container.querySelectorAll('svg path[d]')).find((p) =>
      (p.getAttribute('d') || '').startsWith(PLAY_ICON_PATH_SIGNATURE)
    );
    if (pathMatch) return pathMatch.closest('.icon-container') || pathMatch.closest('svg') || pathMatch;

    // Same generic wrapper class, first occurrence in the row — Play always
    // renders before the Download icon in Pancake's player, and neither has
    // a distinguishing class/label of its own.
    const iconContainers = container.querySelectorAll('.icon-container');
    if (iconContainers.length) return iconContainers[0];

    // Semantic/labelled fallbacks, in case a different message type (or a
    // future Pancake deploy) uses more accessible markup.
    const byHint = container.querySelector('[aria-label*="play" i], [class*="play" i]');
    if (byHint) return byHint;

    const candidates = container.querySelectorAll('button, [role="button"]');
    for (const el of candidates) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.className || ''}`;
      const text = (el.textContent || '').trim();
      if (SPEED_LABEL_RE.test(text)) continue; // skip the "1x" speed toggle
      if (NON_PLAY_HINT_RE.test(label)) continue; // skip download/speed controls
      return el;
    }
    return null;
  }

  async function triggerLazyLoad(container, audioEl) {
    const trigger = findPlayTrigger(container) || audioEl;
    const wasMuted = audioEl.muted;
    audioEl.muted = true;
    try {
      if (typeof trigger.click === 'function') {
        trigger.click();
      } else {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      return await waitForAudioUrl(container, { timeoutMs: 3000, intervalMs: 100 });
    } finally {
      try {
        audioEl.pause();
        audioEl.currentTime = 0;
      } catch (_err) {
        // Media may not be seekable yet (readyState HAVE_NOTHING) — harmless.
      }
      audioEl.muted = wasMuted;
    }
  }

  function findBubbleAncestor(audioEl) {
    let node = audioEl.parentElement;
    let best = audioEl.parentElement;
    for (let hop = 0; node && hop < BUBBLE_ANCESTOR_HOPS; hop += 1) {
      const cls = (node.className && String(node.className)) || '';
      const role = node.getAttribute && node.getAttribute('role');
      if (BUBBLE_HINT_RE.test(cls) || role === 'listitem' || node.tagName === 'LI') {
        best = node;
        break;
      }
      best = node;
      node = node.parentElement;
    }
    return best;
  }

  class PancakeProvider extends AudioProvider {
    get id() {
      return 'pancake';
    }

    matches(location) {
      return PANCAKE_HOST_RE.test(location.hostname);
    }

    detectAudioElements(root) {
      const scope = root instanceof Element || root instanceof Document ? root : document;
      const audioEls = Array.from(scope.querySelectorAll('audio'));
      const containers = new Set();
      for (const audioEl of audioEls) {
        if (audioEl.closest('[data-pvt-toolbar-root]')) continue; // our own injected UI
        containers.add(findBubbleAncestor(audioEl));
      }
      return Array.from(containers).filter(Boolean);
    }

    async extractAudioUrl(container) {
      // Pulled straight from a real <audio>/<video> element's own
      // src/currentSrc — the browser already resolved it as playable media,
      // so trust it outright. isAudioLikeUrl's extension/keyword heuristic
      // is too strict for this (confirmed live: Pancake's Messenger-backed
      // voice notes resolve to opaque cdn.fbsbx.com URLs with no .mp3-style
      // extension, which that heuristic used to reject).
      const immediate = findAudioUrlInElement(container);
      if (immediate) return immediate;

      const audioEl = container.querySelector('audio');
      if (audioEl) {
        const triggered = await triggerLazyLoad(container, audioEl);
        if (triggered) return triggered;
      }

      // Fallback: correlate with the most recent audio-flavoured network
      // response captured by lib/network-hook.js (covers the case where the
      // player fetches its stream via XHR/fetch instead of a plain <audio src>).
      global.PVT.networkAudio.requestSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return global.PVT.networkAudio.getRecent(5000);
    }
  }

  global.PVT = global.PVT || {};
  global.PVT.registry.register(new PancakeProvider());
})(typeof window !== 'undefined' ? window : globalThis);
