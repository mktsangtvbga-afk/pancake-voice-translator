(function () {
  'use strict';

  const backendUrlInput = document.getElementById('backendUrl');
  const statusEl = document.getElementById('status');
  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = `pvt-status pvt-status-${kind || 'info'}`;
  }

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response && response.ok) {
      backendUrlInput.value = response.data.backendUrl || '';
    }
  }

  saveBtn.addEventListener('click', async () => {
    const backendUrl = backendUrlInput.value.trim().replace(/\/+$/, '');
    if (!backendUrl) {
      setStatus('Vui lòng nhập backend URL.', 'error');
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { backendUrl } });
    if (response && response.ok) {
      setStatus('Đã lưu.', 'success');
    } else {
      setStatus('Không lưu được cài đặt.', 'error');
    }
  });

  testBtn.addEventListener('click', async () => {
    setStatus('Đang kiểm tra...', 'info');
    const backendUrl = backendUrlInput.value.trim().replace(/\/+$/, '');
    try {
      const res = await fetch(`${backendUrl}/health`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      setStatus(`Kết nối OK${body.geminiConfigured === false ? ' (thiếu GEMINI_API_KEY trên server)' : ''}.`, 'success');
    } catch (err) {
      setStatus(`Không kết nối được backend: ${err.message}`, 'error');
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    if (response && response.ok) {
      setStatus(`Đã xoá ${response.data.cleared} mục cache.`, 'success');
    } else {
      setStatus('Không xoá được cache.', 'error');
    }
  });

  loadSettings();
})();
