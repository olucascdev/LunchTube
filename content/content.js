// LunchTube - Content Script
// Injects LunchTube panel on YouTube homepage during lunch time

(function () {
  'use strict';

  const PANEL_ID = 'lunchtube-panel';

  // ─── Check if we should inject ────────────────────────────────────────────
  function isYouTubeHome() {
    return window.location.hostname === 'www.youtube.com' &&
      (window.location.pathname === '/' || window.location.pathname === '/feed/subscriptions');
  }

  // ─── Create Panel HTML ───────────────────────────────────────────────────
  function createPanel(videos, usedMock) {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    const mockBadge = usedMock
      ? '<span class="lt-mock-badge">demo</span>'
      : '';

    const videoCards = videos.slice(0, 5).map(v => `
      <a class="lt-card" href="https://www.youtube.com/watch?v=${v.id}" target="_self">
        <div class="lt-thumb-wrap">
          <img class="lt-thumb" src="${v.thumbnail}" alt="" loading="lazy" />
          <span class="lt-duration">${v.duration}</span>
        </div>
        <div class="lt-info">
          <span class="lt-title">${escapeHtml(v.title)}</span>
          <span class="lt-channel">${escapeHtml(v.channel)}</span>
        </div>
      </a>
    `).join('');

    panel.innerHTML = `
      <div class="lt-header">
        <div class="lt-brand">
          <span class="lt-icon">🍴</span>
          <span class="lt-title-main">LunchTube</span>
          <span class="lt-subtitle">Hora do almoço!</span>
          ${mockBadge}
        </div>
        <button class="lt-close" id="lt-close-btn" title="Fechar">✕</button>
      </div>
      <div class="lt-scroll">
        <div class="lt-grid">${videoCards}</div>
      </div>
    `;

    return panel;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Inject Panel ────────────────────────────────────────────────────────
  function injectPanel(videos, usedMock) {
    if (document.getElementById(PANEL_ID)) return;

    const panel = createPanel(videos, usedMock);

    // Insert before the main content area
    const target =
      document.querySelector('#primary') ||
      document.querySelector('ytd-browse') ||
      document.querySelector('#content') ||
      document.body;

    target.prepend(panel);

    // Close button
    document.getElementById('lt-close-btn').addEventListener('click', () => {
      panel.style.animation = 'lt-slideUp 0.3s ease forwards';
      setTimeout(() => panel.remove(), 300);
    });
  }

  // ─── Main ────────────────────────────────────────────────────────────────
  async function init() {
    if (!isYouTubeHome()) return;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (response?.state === 'lunch' && response.videos?.length > 0) {
        // Small delay to let YouTube render its content first
        setTimeout(() => injectPanel(response.videos, response.usedMock), 1500);
      }
    } catch (err) {
      // Extension context may not be available, fail silently
    }
  }

  // ─── SPA Navigation listener ─────────────────────────────────────────────
  // YouTube is a SPA, so we need to re-check on navigation
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById(PANEL_ID)?.remove();
      setTimeout(init, 500);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  init();
})();
