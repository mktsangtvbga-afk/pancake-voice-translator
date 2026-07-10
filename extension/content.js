/**
 * Orchestrator: finds voice messages via the active AudioProvider, injects a
 * hover toolbar (Dịch / Nghe tiếng Việt) rendered in a closed-ish Shadow DOM
 * so nothing here can be styled-over by (or leak style into) Pancake's own
 * UI. All network I/O is delegated to background.js via chrome.runtime
 * messaging — content scripts should not talk to the backend directly.
 */
(function () {
  'use strict';

  const { sha256Hex, normalizeUrlForHash, debounce } = window.PVT.domUtils;
  const registry = window.PVT.registry;

  const provider = registry.resolveActive(window.location);
  if (!provider) {
    // No provider claims this host — nothing to do (e.g. extension is
    // installed but the user is on an unrelated site that happens to match
    // a broad host permission granted from the popup).
    return;
  }

  const processed = new WeakSet();

  function createToolbarHost() {
    const host = document.createElement('span');
    host.setAttribute('data-pvt-toolbar-root', provider.id);
    host.style.all = 'initial';
    host.style.display = 'inline-block';
    host.style.marginLeft = '8px';
    host.style.verticalAlign = 'middle';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${SHADOW_CSS}</style>
      <div class="pvt-root">
        <div class="pvt-actions">
          <button type="button" class="pvt-btn pvt-btn-translate">Dịch</button>
        </div>
        <div class="pvt-panel" hidden>
          <div class="pvt-panel-header">Voice Message</div>
          <div class="pvt-row"><span class="pvt-label">Ngôn ngữ:</span> <span class="pvt-lang"></span></div>
          <div class="pvt-block">
            <div class="pvt-label">Văn bản gốc:</div>
            <div class="pvt-transcript"></div>
          </div>
          <div class="pvt-block">
            <div class="pvt-label">Tiếng Việt:</div>
            <div class="pvt-translation"></div>
          </div>
          <div class="pvt-actions">
            <button type="button" class="pvt-btn pvt-btn-speak">Nghe tiếng Việt</button>
          </div>
          <div class="pvt-error" hidden></div>
        </div>
      </div>
    `;
    return { host, shadow };
  }

  const SHADOW_CSS = `
    :host { all: initial; }
    .pvt-root { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #1f2328; }
    .pvt-btn {
      cursor: pointer; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328;
      border-radius: 6px; padding: 4px 10px; font-size: 12px; line-height: 1.4;
    }
    .pvt-btn:hover { background: #eef1f4; }
    .pvt-btn:disabled { opacity: 0.6; cursor: default; }
    .pvt-btn-translate { color: #0969da; border-color: #0969da; }
    .pvt-btn-speak { color: #1a7f37; border-color: #1a7f37; margin-top: 6px; }
    .pvt-panel {
      margin-top: 6px; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 8px;
      background: #ffffff; max-width: 360px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .pvt-panel-header { font-weight: 600; margin-bottom: 6px; }
    .pvt-row { margin-bottom: 6px; }
    .pvt-label { color: #57606a; font-weight: 600; margin-right: 4px; }
    .pvt-block { margin-bottom: 8px; }
    .pvt-transcript, .pvt-translation { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
    .pvt-error { color: #cf222e; margin-top: 6px; white-space: pre-wrap; }
    .pvt-actions { display: flex; }
  `;

  function attachToolbar(container) {
    if (processed.has(container)) return;
    processed.add(container);

    const { host, shadow } = createToolbarHost();
    const anchor = provider.getAnchor(container);
    anchor.insertAdjacentElement('afterend', host);

    // Reveal-on-hover, per spec: the button only appears while the user is
    // hovering the voice-message area, so we never permanently alter layout.
    host.style.opacity = '0';
    host.style.pointerEvents = 'none';
    host.style.transition = 'opacity 120ms ease';
    let hideTimer = null;
    const show = () => {
      if (hideTimer) clearTimeout(hideTimer);
      host.style.opacity = '1';
      host.style.pointerEvents = 'auto';
    };
    const scheduleHide = () => {
      hideTimer = setTimeout(() => {
        // Keep visible if the result panel is open, so the user can still
        // read/interact with it after moving the mouse away.
        const panel = shadow.querySelector('.pvt-panel');
        if (panel && !panel.hidden) return;
        host.style.opacity = '0';
        host.style.pointerEvents = 'none';
      }, 250);
    };
    container.addEventListener('mouseenter', show);
    container.addEventListener('mouseleave', scheduleHide);
    host.addEventListener('mouseenter', show);
    host.addEventListener('mouseleave', scheduleHide);

    wireToolbar({ container, shadow });
  }

  function wireToolbar({ container, shadow }) {
    const translateBtn = shadow.querySelector('.pvt-btn-translate');
    const speakBtn = shadow.querySelector('.pvt-btn-speak');
    const panel = shadow.querySelector('.pvt-panel');
    const langEl = shadow.querySelector('.pvt-lang');
    const transcriptEl = shadow.querySelector('.pvt-transcript');
    const translationEl = shadow.querySelector('.pvt-translation');
    const errorEl = shadow.querySelector('.pvt-error');

    let lastTranslation = null;
    let currentAudio = null;
    speakBtn.disabled = true; // enabled only after a successful translation exists to read

    function showError(message) {
      panel.hidden = false; // .pvt-error lives inside .pvt-panel, so the panel must be revealed too
      errorEl.hidden = false;
      errorEl.textContent = message;
    }
    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    translateBtn.addEventListener('click', async () => {
      if (lastTranslation !== null) {
        // Already translated this message earlier in the current page
        // session — the panel is still showing it, nothing to do. Avoids a
        // redundant round trip (extraction + network) even though the
        // server/client cache would also catch it.
        panel.hidden = false;
        return;
      }
      clearError();
      translateBtn.disabled = true;
      translateBtn.textContent = 'Đang dịch...';
      try {
        const audioUrl = await provider.extractAudioUrl(container);
        if (!audioUrl) {
          throw new Error('Không tìm thấy file audio cho voice message này.');
        }
        const audioHash = await sha256Hex(normalizeUrlForHash(audioUrl));
        const payload = { type: 'TRANSLATE_AUDIO', audioHash, pageUrl: window.location.href };

        if (audioUrl.startsWith('blob:') || audioUrl.startsWith('data:')) {
          // blob:/data: URLs only resolve inside this document — the
          // background service worker has no way to fetch them itself, so
          // we read the bytes here and transfer them across the message.
          const audioResp = await fetch(audioUrl);
          if (!audioResp.ok) throw new Error('Không đọc được dữ liệu audio (blob).');
          const blob = await audioResp.blob();
          payload.audioBuffer = await blob.arrayBuffer();
          payload.mimeType = blob.type || 'audio/mpeg';
        } else {
          // Plain http(s) URL: let background fetch it directly so a cache
          // hit never costs any bandwidth on the tab side.
          payload.audioUrl = audioUrl;
        }

        const response = await chrome.runtime.sendMessage(payload);

        if (!response || !response.ok) {
          throw new Error((response && response.error) || 'Dịch thất bại, vui lòng thử lại.');
        }

        const { sourceLanguage, transcript, translation } = response.data;
        langEl.textContent = sourceLanguage || 'Không xác định';
        transcriptEl.textContent = transcript || '(trống)';
        translationEl.textContent = translation || '(trống)';
        lastTranslation = translation;
        speakBtn.disabled = !translation;
        panel.hidden = false;
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
      } finally {
        translateBtn.disabled = false;
        translateBtn.textContent = 'Dịch';
      }
    });

    speakBtn.addEventListener('click', async () => {
      if (!lastTranslation) {
        showError('Chưa có bản dịch để đọc.');
        return;
      }
      clearError();
      speakBtn.disabled = true;
      speakBtn.textContent = 'Đang tạo giọng đọc...';
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'SPEAK_TEXT',
          text: lastTranslation,
        });
        if (!response || !response.ok) {
          throw new Error((response && response.error) || 'Không thể đọc bản dịch.');
        }
        if (currentAudio) {
          currentAudio.pause();
          currentAudio = null;
        }
        currentAudio = new Audio(response.data.audioDataUrl);
        await currentAudio.play();
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
      } finally {
        speakBtn.disabled = false;
        speakBtn.textContent = 'Nghe tiếng Việt';
      }
    });
  }

  function scan(root) {
    let containers = [];
    try {
      containers = provider.detectAudioElements(root);
    } catch (err) {
      console.warn('[PVT] detectAudioElements failed', err);
      return;
    }
    for (const container of containers) {
      attachToolbar(container);
    }
  }

  const debouncedScan = debounce(() => scan(document), 300);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes && mutation.addedNodes.length) {
        debouncedScan();
        return;
      }
    }
  });

  function start() {
    scan(document);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
