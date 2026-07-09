/**
 * Plugin-adapter contract for chat platforms (Pancake, Facebook Inbox, Zalo,
 * Telegram Web, WhatsApp Web, ...). Each platform ships one class that
 * implements this interface and registers itself in ProviderRegistry.
 *
 * Loaded as a plain content-script global (no ES modules) so it works
 * identically in Chrome and Cốc Cốc without manifest "type": "module" quirks.
 */
(function (global) {
  'use strict';

  class AudioProvider {
    /** Unique id, e.g. "pancake". */
    get id() {
      throw new Error('AudioProvider.id must be implemented');
    }

    /** Return true if this provider recognizes the current page. */
    matches(_location) {
      throw new Error('AudioProvider.matches must be implemented');
    }

    /**
     * Scan a root node (Document or a mutated subtree) for voice-message
     * containers this provider knows how to handle.
     * @param {ParentNode} _root
     * @returns {Element[]} container elements (NOT the <audio> tag itself,
     *   but the wrapping element the toolbar should be attached under).
     */
    detectAudioElements(_root) {
      throw new Error('AudioProvider.detectAudioElements must be implemented');
    }

    /**
     * Resolve the real, fetchable audio URL for a container found by
     * detectAudioElements(). May return a Promise (e.g. while waiting for a
     * lazy-loaded <audio src> or an intercepted network response).
     * @param {Element} _container
     * @returns {string | Promise<string | null> | null}
     */
    extractAudioUrl(_container) {
      throw new Error('AudioProvider.extractAudioUrl must be implemented');
    }

    /**
     * Where to anchor the injected toolbar relative to the container.
     * Default: append as the container's last child. Providers can override
     * to avoid colliding with the host page's own layout/flex rules.
     */
    getAnchor(container) {
      return container;
    }
  }

  class ProviderRegistry {
    constructor() {
      /** @type {AudioProvider[]} */
      this._providers = [];
    }

    register(provider) {
      this._providers.push(provider);
      return this;
    }

    /** Returns the first provider whose matches() accepts the current page. */
    resolveActive(location = global.location) {
      return this._providers.find((p) => {
        try {
          return p.matches(location);
        } catch (err) {
          console.warn('[PVT] provider.matches() threw', p.id, err);
          return false;
        }
      }) || null;
    }

    all() {
      return this._providers.slice();
    }
  }

  global.PVT = global.PVT || {};
  global.PVT.AudioProvider = AudioProvider;
  global.PVT.registry = global.PVT.registry || new ProviderRegistry();
})(typeof window !== 'undefined' ? window : globalThis);
