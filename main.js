const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ChatScraper } = require('./src/scraper');
const scoring = require('./src/scoring');
const { verifyLicense } = require('./src/license');

// Ensure only one instance runs at a time. Re-launch focuses the widget.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
}

// Disable HW acceleration — prevents graphical clipping on frameless
// transparent windows in Windows OS. (Carried over from the timer base.)
app.disableHardwareAcceleration();

let pollWindow = null;
let settingsWindow = null;

// ── Persistent config ──
const configPath = path.join(os.homedir(), '.poll-ranker-config.json');

let config = {
  licenseKey: '',
  streamUrl: '',
  bufferOffsetSec: 0, // compensate for YouTube broadcast latency
  duration: 45, // default poll length (s)
  optionCount: 5, // 4 (A–D) or 5 (A–E)
};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

// ── Compact widget geometry (Phases 1–3) — landscape panel ──
const COMPACT_W = 660;
const COMPACT_H = 360;
let compactBounds = null; // remembered so we can restore after a leaderboard expand

// ─────────────────────────────────────────────────────────────────────────
//  Cumulative session.
//  A session holds many QUESTIONS. Each question owns the active-window
//  capture + dedup ("first valid A–E per unique voter"); scored questions are
//  accumulated into the session-wide Top Performers board.
// ─────────────────────────────────────────────────────────────────────────
const session = {
  active: false, // a question's capture window is open
  paused: false,
  pollStartTs: 0,
  durationSec: 45,
  optionCount: 5,
  correctAnswer: null,
  votes: new Map(), // channelId -> { channelId, handle, answer, arrivalTs } for the CURRENT question
  scoredQuestions: [], // array of completed scoreQuestion() arrays

  // Begin a new question's capture window.
  beginQuestion(durationSec, optionCount) {
    this.active = true;
    this.paused = false;
    this.pollStartTs = Date.now();
    this.durationSec = durationSec;
    this.optionCount = optionCount;
    this.correctAnswer = null;
    this.votes = new Map();
  },

  // Parse the first standalone A–E token within the option range.
  parseAnswer(text) {
    if (!text) return null;
    const m = text.match(/(?:^|[^a-z])([a-e])(?:[^a-z]|$)/i);
    if (!m) return null;
    const letter = m[1].toUpperCase();
    const idx = scoring.OPTION_LETTERS.indexOf(letter);
    if (idx === -1 || idx >= this.optionCount) return null; // out of range
    return letter;
  },

  // Ingest scraped messages. Records the FIRST valid vote per voter.
  ingest(messages) {
    if (!this.active || this.paused) return false;
    let changed = false;
    for (const msg of messages) {
      if (this.votes.has(msg.channelId)) continue; // already voted — dedup spam
      const answer = this.parseAnswer(msg.text);
      if (!answer) continue;
      this.votes.set(msg.channelId, {
        channelId: msg.channelId,
        handle: msg.handle || 'anonymous',
        answer,
        arrivalTs: msg.observedTs || Date.now(),
      });
      changed = true;
    }
    return changed;
  },

  // Timer hit zero — stop capturing but keep votes for grading.
  freeze() {
    this.active = false;
  },

  // Teacher picked the correct answer. Score this question, fold it into the
  // cumulative board, and return the full leaderboard payload.
  gradeAndCommit(correctAnswer) {
    this.correctAnswer = correctAnswer;
    const bufferOffsetMs = (config.bufferOffsetSec || 0) * 1000;
    const scored = scoring.scoreQuestion([...this.votes.values()], {
      pollStartTs: this.pollStartTs,
      correctAnswer,
      bufferOffsetMs,
      timeLimitMs: this.durationSec * 1000,
    });
    this.scoredQuestions.push(scored);
    return this.buildResults(scored);
  },

  // Leaderboard payload: this question's vote breakdown + cumulative ranking.
  buildResults(thisQuestionScored) {
    const cumulative = scoring.accumulate(this.scoredQuestions);
    const top = scoring.topN(cumulative, 10).map((e) => ({
      ...e,
      lastElapsedLabel: scoring.formatElapsed(e.lastElapsedMs || 0),
    }));
    return {
      totalQuestions: this.scoredQuestions.length,
      optionCount: this.optionCount,
      correctAnswer: this.correctAnswer,
      tally: scoring.tally(thisQuestionScored, this.optionCount, this.correctAnswer),
      topPerformers: top,
    };
  },

  // Wipe everything for a brand-new session.
  resetSession() {
    this.active = false;
    this.paused = false;
    this.votes = new Map();
    this.scoredQuestions = [];
    this.correctAnswer = null;
  },
};

// ── Scraper ──
const scraper = new ChatScraper({
  onMessages: (messages) => {
    session.ingest(messages); // silent capture — no live tally per spec
  },
  onStatus: (status) => {
    if (pollWindow) pollWindow.webContents.send('poll:status', status);
  },
});

// ─────────────────────────────────────────────────────────────────────────
//  Windows
// ─────────────────────────────────────────────────────────────────────────
function createPollWindow() {
  pollWindow = new BrowserWindow({
    useContentSize: true,
    width: COMPACT_W,
    height: COMPACT_H,
    x: 80,
    y: 80,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  pollWindow.loadFile(path.join(__dirname, 'src/poll.html'));
  pollWindow.setAlwaysOnTop(true, 'screen-saver');

  pollWindow.once('ready-to-show', () => {
    compactBounds = pollWindow.getBounds();
    pollWindow.show();
  });

  pollWindow.on('closed', () => {
    pollWindow = null;
    scraper.stop();
    app.quit();
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  // The widget is pinned at 'screen-saver' level, so temporarily drop it
  // below the settings window; restored when settings closes (see 'closed').
  if (pollWindow) pollWindow.setAlwaysOnTop(false);

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 640,
    frame: true,
    resizable: false,
    alwaysOnTop: true,
    title: 'Poll Ranker — Setup',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'src/settings.html'));
  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('load-config', config);
    settingsWindow.focus();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    if (pollWindow) pollWindow.setAlwaysOnTop(true, 'screen-saver');
  });
}

// Expand the widget to fill the work area for the full-screen leaderboard.
function expandToFullScreen() {
  if (!pollWindow) return;
  compactBounds = pollWindow.getBounds();
  const { x, y, width, height } = screen.getDisplayMatching(compactBounds).workArea;
  pollWindow.setBounds({ x, y, width, height });
}

function collapseToCompact() {
  if (!pollWindow) return;
  pollWindow.setBounds(compactBounds || { x: 80, y: 80, width: COMPACT_W, height: COMPACT_H });
}

// ─────────────────────────────────────────────────────────────────────────
//  IPC
// ─────────────────────────────────────────────────────────────────────────
ipcMain.on('open-settings', () => createSettingsWindow());

ipcMain.on('get-config', (event) => {
  event.reply('config', config);
});

ipcMain.on('save-config', (event, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig();
  if (settingsWindow) {
    settingsWindow.destroy();
    settingsWindow = null;
  }
  if (pollWindow) pollWindow.webContents.send('config', config);
});

ipcMain.on('cancel-settings', () => {
  if (settingsWindow) {
    settingsWindow.destroy();
    settingsWindow = null;
  }
});

// License verification (used by the onboarding console).
ipcMain.handle('verify-license', async (_event, key) => {
  const result = await verifyLicense(key);
  if (result.valid) {
    config.licenseKey = (key || '').trim();
    saveConfig();
  }
  return result;
});

// Phase 1 → 2: start a question's capture window. Ensures the scraper is live.
ipcMain.handle('poll:start', async (_event, { duration, optionCount }) => {
  if (!config.streamUrl) {
    return { ok: false, error: 'No YouTube stream URL set. Open Setup (⚙) first.' };
  }
  config.duration = duration;
  config.optionCount = optionCount;
  saveConfig();

  // (Re)connect the scraper to the configured stream if not already running.
  if (!scraper.isRunning) {
    const res = scraper.start(config.streamUrl);
    if (!res.ok) return { ok: false, error: res.error };
  }

  session.beginQuestion(duration, optionCount);
  return { ok: true, pollStartTs: session.pollStartTs };
});

// Pause / resume the active capture window.
ipcMain.on('poll:pause', () => {
  session.paused = true;
});
ipcMain.on('poll:resume', () => {
  session.paused = false;
});

// Phase 2 → 3: timer hit zero. Freeze capture; teacher will pick the key.
ipcMain.on('poll:timeout', () => {
  session.freeze();
});

// Stop the current question without grading (Stop button).
ipcMain.on('poll:stop', () => {
  session.freeze();
});

// Phase 3 → 4: teacher picked the correct option. Grade + commit + return.
ipcMain.handle('poll:show-results', async (_event, correctAnswer) => {
  return session.gradeAndCommit(correctAnswer);
});

ipcMain.on('poll:expand', () => expandToFullScreen());
ipcMain.on('poll:collapse', () => collapseToCompact());

// Next question — keep cumulative scores, return to Phase 1.
ipcMain.on('poll:next-question', () => {
  session.freeze();
  collapseToCompact();
});

// End the whole session and clear cumulative scores.
ipcMain.on('poll:end-session', () => {
  session.resetSession();
  scraper.stop();
  collapseToCompact();
});

// Export the cumulative session to CSV via a native save dialog.
ipcMain.handle('poll:export-csv', async () => {
  const cumulative = scoring.accumulate(session.scoredQuestions);
  const csv = scoring.buildCsv(cumulative, {
    streamUrl: config.streamUrl,
    totalQuestions: session.scoredQuestions.length,
    exportedAt: new Date().toISOString(),
  });

  const { canceled, filePath } = await dialog.showSaveDialog(pollWindow, {
    title: 'Export Leaderboard',
    defaultPath: `poll-session-${Date.now()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(filePath, csv, 'utf8');
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('exit-app', () => {
  scraper.stop();
  if (settingsWindow) settingsWindow.destroy();
  if (pollWindow) pollWindow.destroy();
  app.exit(0);
});

app.on('second-instance', () => {
  if (pollWindow) {
    if (pollWindow.isMinimized()) pollWindow.restore();
    pollWindow.show();
    pollWindow.focus();
  }
});

app.whenReady().then(() => {
  loadConfig();
  createPollWindow();
});

app.on('window-all-closed', () => {
  app.exit(0);
});
