// ── Local YouTube Live Chat Ingestion Engine ──
//
// Runs inside the Electron MAIN process. Opens a hidden BrowserWindow pointed
// at YouTube's live-chat popout for the teacher's own stream, then drains new
// chat messages from the page DOM under the teacher's IP. This deliberately
// avoids the YouTube Data API v3 quota (5 units / call).
//
// Design notes:
//   * The hidden window loads REMOTE content, so we keep nodeIntegration off
//     and contextIsolation on. We never expose IPC to the page; instead we
//     poll it with executeJavaScript and drain a small in-page buffer. This
//     keeps untrusted YouTube JS fully sandboxed.
//   * DOM selectors are centralised in PAGE_SCRAPER so they're trivial to
//     update if YouTube changes its markup (which it will, eventually).
//   * This module only EMITS observed messages. De-duplication and the
//     "first valid A–E per unique voter" rule live in the poll session
//     (main.js) so the active-window logic stays in one place.

const { BrowserWindow } = require('electron');

/**
 * Extract the 11-char YouTube video ID from the many URL shapes a teacher
 * might paste: watch?v=, youtu.be/, /live/, /live_chat?v=, or a bare ID.
 */
function extractVideoId(input) {
  if (!input) return null;
  const raw = input.trim();

  // Bare 11-char ID
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    // watch?v=ID and live_chat?v=ID
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;

    // youtu.be/ID  and  /live/ID  and  /embed/ID
    const parts = url.pathname.split('/').filter(Boolean);
    for (const seg of parts) {
      if (/^[A-Za-z0-9_-]{11}$/.test(seg)) return seg;
    }
  } catch (_) {
    // not a URL — fall through
  }
  return null;
}

// This string is stringified and injected into the YouTube live-chat page.
// It installs a MutationObserver that pushes each new text message into a
// window-level buffer which the main process drains via executeJavaScript.
const PAGE_SCRAPER = `
(function () {
  if (window.__pollRankerInstalled) return 'already';
  window.__pollRankerInstalled = true;
  window.__pollRankerBuffer = [];

  function findRoot() {
    // The popout renders the message list inside #items of the item-list renderer.
    return document.querySelector('yt-live-chat-item-list-renderer #items')
        || document.querySelector('#items.yt-live-chat-item-list-renderer')
        || document.querySelector('#items');
  }

  function readMessage(node) {
    if (!node || !node.querySelector) return null;
    // Only standard text messages (skip superchats/membership/system if desired,
    // but we accept superchats too since they carry an author + message).
    var authorEl = node.querySelector('#author-name');
    var msgEl = node.querySelector('#message');
    if (!msgEl) return null;

    var handle = authorEl ? authorEl.textContent.trim() : '';
    var text = msgEl.textContent.trim();

    // Stable per-author identity. YouTube does not reliably expose the channel
    // id in the popout DOM, so we use the author photo URL (which embeds the
    // channel's ucid/avatar id) as the dedup key, falling back to the handle.
    var channelId = '';
    var photo = node.querySelector('#author-photo img');
    if (photo && photo.src) channelId = photo.src;
    if (!channelId) channelId = 'name:' + handle;

    return { channelId: channelId, handle: handle, text: text, observedTs: Date.now() };
  }

  function push(node) {
    var m = readMessage(node);
    if (m) window.__pollRankerBuffer.push(m);
  }

  function attach() {
    var root = findRoot();
    if (!root) { setTimeout(attach, 500); return; }

    // Pick up any messages already present.
    root.querySelectorAll('yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer').forEach(push);

    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mut) {
        mut.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          var tag = (n.tagName || '').toLowerCase();
          if (tag === 'yt-live-chat-text-message-renderer' ||
              tag === 'yt-live-chat-paid-message-renderer') {
            push(n);
          }
        });
      });
    });
    observer.observe(root, { childList: true });
    window.__pollRankerObserver = observer;
  }

  attach();
  return 'installed';
})();
`;

// Drains and clears the in-page buffer, returning the batch as JSON.
const PAGE_DRAIN = `
(function () {
  if (!window.__pollRankerBuffer) return '[]';
  var batch = window.__pollRankerBuffer;
  window.__pollRankerBuffer = [];
  return JSON.stringify(batch);
})();
`;

class ChatScraper {
  /**
   * @param {Object} handlers
   * @param {(messages: Array) => void} handlers.onMessages - batch of observed messages
   * @param {(status: {state: string, detail?: string}) => void} [handlers.onStatus]
   */
  constructor({ onMessages, onStatus } = {}) {
    this.onMessages = onMessages || (() => {});
    this.onStatus = onStatus || (() => {});
    this.window = null;
    this.pollTimer = null;
    this.installed = false;
  }

  get isRunning() {
    return !!this.window;
  }

  /**
   * Open the hidden chat window for a stream and begin draining messages.
   * @param {string} streamUrl
   * @returns {{ok: boolean, videoId?: string, error?: string}}
   */
  start(streamUrl) {
    const videoId = extractVideoId(streamUrl);
    if (!videoId) {
      const error = 'Could not find a YouTube video ID in that URL.';
      this.onStatus({ state: 'error', detail: error });
      return { ok: false, error };
    }

    // If already running, restart cleanly against the new stream.
    this.stop();

    this.onStatus({ state: 'connecting', detail: videoId });

    this.window = new BrowserWindow({
      show: false,
      width: 420,
      height: 700,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false, // keep scraping while widget is foregrounded
      },
    });

    const chatUrl = `https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`;
    this.window.loadURL(chatUrl);

    this.window.webContents.on('did-finish-load', () => {
      this._install();
    });

    this.window.webContents.on('did-fail-load', (_e, code, desc) => {
      this.onStatus({ state: 'error', detail: `Load failed (${code}): ${desc}` });
    });

    this.window.on('closed', () => {
      this.window = null;
    });

    return { ok: true, videoId };
  }

  async _install() {
    if (!this.window) return;
    try {
      await this.window.webContents.executeJavaScript(PAGE_SCRAPER, true);
      this.installed = true;
      this.onStatus({ state: 'connected' });
      this._startPolling();
    } catch (err) {
      this.onStatus({ state: 'error', detail: `Inject failed: ${err.message}` });
    }
  }

  _startPolling() {
    clearInterval(this.pollTimer);
    // ~700ms drain cadence. The page buffers continuously, so cadence only
    // affects how chunky the delivery is, not whether messages are captured.
    this.pollTimer = setInterval(() => this._drain(), 700);
  }

  async _drain() {
    if (!this.window || !this.installed) return;
    try {
      const json = await this.window.webContents.executeJavaScript(PAGE_DRAIN, true);
      const batch = JSON.parse(json || '[]');
      if (batch.length) this.onMessages(batch);
    } catch (err) {
      // Page navigated or closed mid-drain; surface but don't crash.
      this.onStatus({ state: 'error', detail: `Drain failed: ${err.message}` });
    }
  }

  stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.installed = false;
    if (this.window) {
      try {
        this.window.destroy();
      } catch (_) {}
      this.window = null;
    }
    this.onStatus({ state: 'stopped' });
  }
}

module.exports = { ChatScraper, extractVideoId };
