const { ipcRenderer } = require('electron');

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const CLOCK_CIRC = 2 * Math.PI * 92; // matches r=92 in poll.css

// ── UI state ──
let config = { streamUrl: '', duration: 45, optionCount: 5, bufferOffsetSec: 0 };
let selDuration = 45;
let selOptions = 5;
let countdownTimer = null;
let remaining = 0;
let paused = false;
let pickedAnswer = null;

// ── DOM refs ──
const phases = {
  init: document.getElementById('phase-init'),
  poll: document.getElementById('phase-poll'),
};
const widget = document.getElementById('widget');
const leaderboard = document.getElementById('leaderboard');
const titleStatus = document.getElementById('title-status');

// ─────────────────────────────────────────────────────────────────────────
//  Config sync
// ─────────────────────────────────────────────────────────────────────────
ipcRenderer.send('get-config');
ipcRenderer.on('config', (_e, c) => {
  config = { ...config, ...c };
  selDuration = config.duration || 45;
  selOptions = config.optionCount || 5;
  syncInitControls();
});

// ─────────────────────────────────────────────────────────────────────────
//  Phase switching
// ─────────────────────────────────────────────────────────────────────────
function showPhase(name) {
  Object.entries(phases).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
}
function showLeaderboard(show) {
  leaderboard.classList.toggle('hidden', !show);
  widget.classList.toggle('hidden', show);
}
function setTitle(text, running) {
  titleStatus.textContent = text;
  titleStatus.classList.toggle('running', !!running);
}

// ── Title bar ──
document.getElementById('btn-gear').addEventListener('click', () => ipcRenderer.send('open-settings'));
document.getElementById('btn-reset').addEventListener('click', resetToInit);
document.getElementById('btn-exit').addEventListener('click', () => ipcRenderer.send('exit-app'));

// ── Build clock minute ticks once ──
(function buildTicks() {
  const g = document.getElementById('clock-ticks');
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    const x1 = 100 + 84 * Math.sin(a);
    const y1 = 100 - 84 * Math.cos(a);
    const x2 = 100 + 90 * Math.sin(a);
    const y2 = 100 - 90 * Math.cos(a);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('class', 'clock-tick');
    g.appendChild(line);
  }
})();

// ─────────────────────────────────────────────────────────────────────────
//  PHASE 1: Initiation
// ─────────────────────────────────────────────────────────────────────────
function syncInitControls() {
  document.querySelectorAll('#time-grid .time-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.dur) === selDuration);
  });
  document.querySelectorAll('#options-row .radio-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.opt) === selOptions);
  });
}
document.querySelectorAll('#time-grid .time-btn').forEach((b) => {
  b.addEventListener('click', () => { selDuration = Number(b.dataset.dur); syncInitControls(); });
});
document.querySelectorAll('#options-row .radio-btn').forEach((b) => {
  b.addEventListener('click', () => { selOptions = Number(b.dataset.opt); syncInitControls(); });
});

document.getElementById('btn-start').addEventListener('click', async () => {
  const btn = document.getElementById('btn-start');
  btn.disabled = true;

  // Check if custom duration is active and should be used
  const customInput = document.getElementById('custom-duration');
  let effectiveDuration = selDuration;

  // If custom input has a value and it's valid, use that instead
  const inputValue = parseInt(customInput.value);
  if (!isNaN(inputValue) && inputValue >= 1 && inputValue <= 300) {
    effectiveDuration = inputValue;
  }

  const res = await ipcRenderer.invoke('poll:start', { duration: effectiveDuration, optionCount: selOptions });
  btn.disabled = false;
  if (!res.ok) { setTitle('⚠ ' + res.error, false); return; }
  startPollPhase();
});

// ─────────────────────────────────────────────────────────────────────────
//  PHASE 2 + 3 (merged): countdown clock + answer selection
// ─────────────────────────────────────────────────────────────────────────
function startPollPhase() {
  showPhase('poll');
  buildAnswerGrid();
  pickedAnswer = null;
  paused = false;
  remaining = selDuration;

  // Reset clock visuals to "running".
  document.getElementById('clock-progress').classList.add('run');
  document.getElementById('clock-timeout').classList.add('hidden');
  document.getElementById('clock-digital').classList.remove('hidden');
  updateClock(remaining, selDuration, true);

  // Transport: pause enabled, stop enabled. Show Results disabled until graded.
  document.getElementById('btn-pause').disabled = false;
  document.getElementById('btn-stop').disabled = false;
  document.getElementById('btn-show-results').disabled = true;
  setTitle('Poll Running', true);

  clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

function tick() {
  if (paused) return;
  remaining -= 1;
  updateClock(remaining, selDuration, true);
  if (remaining <= 0) {
    clearInterval(countdownTimer);
    onTimeout();
  }
}

function onTimeout() {
  ipcRenderer.send('poll:timeout');
  document.getElementById('clock-digital').classList.add('hidden');
  document.getElementById('clock-timeout').classList.remove('hidden');
  document.getElementById('clock-progress').classList.remove('run');
  document.getElementById('btn-pause').disabled = true;
  setTitle('Poll Stopped', false);
  // Show Results becomes available once a correct answer is selected.
}

function updateClock(secs, total, instant = false) {
  document.getElementById('clock-secs').textContent = Math.max(0, secs);
  const frac = total > 0 ? Math.max(0, secs) / total : 0;
  const prog = document.getElementById('clock-progress');
  const clockHand = document.getElementById('clock-hand');

  // On an instant set (poll start / reset) suppress the transition so the hand
  // and ring snap into place instead of spinning back from the previous state.
  if (instant) {
    prog.style.transition = 'none';
    clockHand.style.transition = 'none';
  }

  prog.style.strokeDasharray = `${CLOCK_CIRC}`;
  prog.style.strokeDashoffset = `${CLOCK_CIRC * (1 - frac)}`;
  // Hand sweeps clockwise as time elapses (full circle over the whole duration).
  // Drive rotation through the CSS `transform` property (not the SVG attribute)
  // so it animates with the CSS transition and pivots at transform-origin.
  const angle = (1 - frac) * 360;
  clockHand.style.transform = `rotate(${angle}deg)`;

  if (instant) {
    // Force reflow, then restore transitions for the subsequent ticks.
    void prog.getBoundingClientRect();
    prog.style.transition = '';
    clockHand.style.transition = '';
  }
}

function buildAnswerGrid() {
  const grid = document.getElementById('answer-grid');
  grid.innerHTML = '';
  const letters = LETTERS.slice(0, selOptions);
  letters.forEach((letter, i) => {
    const btn = document.createElement('button');
    btn.className = 'answer-btn';
    btn.textContent = letter;
    // 5th option (E) spans + centers on its own row, matching the screenshots.
    if (selOptions === 5 && i === 4) btn.classList.add('span-full');
    btn.addEventListener('click', () => pickAnswer(letter, btn));
    grid.appendChild(btn);
  });
}

function pickAnswer(letter, btn) {
  pickedAnswer = letter;
  document.querySelectorAll('.answer-btn').forEach((b) => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('btn-show-results').disabled = false;
}

// Transport controls
document.getElementById('btn-pause').addEventListener('click', () => {
  paused = !paused;
  const btn = document.getElementById('btn-pause');
  btn.textContent = paused ? '▶' : '⏸';
  ipcRenderer.send(paused ? 'poll:pause' : 'poll:resume');
  setTitle(paused ? 'Paused' : 'Poll Running', !paused);
});
document.getElementById('btn-stop').addEventListener('click', () => {
  clearInterval(countdownTimer);
  ipcRenderer.send('poll:stop');
  onTimeout();
});

document.getElementById('btn-show-results').addEventListener('click', async () => {
  if (!pickedAnswer) return;
  clearInterval(countdownTimer);
  const results = await ipcRenderer.invoke('poll:show-results', pickedAnswer);
  renderLeaderboard(results);
});

// ─────────────────────────────────────────────────────────────────────────
//  PHASE 4: Leaderboard (latest question result + cumulative top performers)
// ─────────────────────────────────────────────────────────────────────────
function renderLeaderboard(results) {
  ipcRenderer.send('poll:expand');
  showLeaderboard(true);

  // LEFT — horizontal option result rows
  const bars = document.getElementById('lb-bars');
  bars.innerHTML = '';
  results.tally.breakdown.forEach((b) => {
    const row = document.createElement('div');
    row.className = `lb-bar-row ${b.isCorrect ? 'is-correct' : ''}`;
    row.innerHTML = `
      <span class="lb-bar-letter">${b.letter}</span>
      <span class="lb-bar-track">
        <span class="lb-bar-fill" style="width:${b.pct}%"></span>
        <span class="lb-bar-pct">${b.pct.toFixed(1)}%</span>
      </span>
      <span class="lb-bar-votes">${b.count} vote${b.count === 1 ? '' : 's'}</span>`;
    bars.appendChild(row);
  });

  document.getElementById('lb-qnum').textContent = results.totalQuestions;
  document.getElementById('lb-total').textContent = results.tally.totalVotes;
  document.getElementById('lb-correct').textContent = results.tally.correctVotes;
  document.getElementById('lb-accuracy').textContent = `${results.tally.accuracy.toFixed(1)}%`;

  // Medal cards (GOLD / SILVER / BRONZE) — top 3 cumulative performers
  const medals = document.getElementById('lb-medals');
  medals.innerHTML = '';
  const tiers = ['GOLD', 'SILVER', 'BRONZE'];
  results.topPerformers.slice(0, 3).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lb-medal-row';
    row.innerHTML = `
      <span class="medal-badge medal-${i + 1}">${i + 1}</span>
      <span class="medal-tier">${tiers[i]} -</span>
      <span class="medal-name">${escapeHtml(p.handle)}</span>`;
    medals.appendChild(row);
  });

  // RIGHT — cumulative Top Performers
  const list = document.getElementById('lb-list');
  list.innerHTML = '';
  if (!results.topPerformers.length) {
    list.innerHTML = '<li class="lb-empty">No valid votes were captured yet.</li>';
  } else {
    results.topPerformers.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'lb-row';
      const posCls = i < 3 ? `medal-${i + 1}` : '';
      const ansCls = p.lastIsCorrect ? 'correct' : 'wrong';
      li.innerHTML = `
        <span class="lb-pos ${posCls}">${i + 1}</span>
        <span class="lb-handle">${escapeHtml(p.handle)}</span>
        <span class="lb-ans ${ansCls}">${p.lastAnswer || '—'}</span>
        <span class="lb-time">${p.lastElapsedLabel}</span>`;
      list.appendChild(li);
    });
  }
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const btn = document.getElementById('btn-export');
  const orig = btn.textContent;
  const res = await ipcRenderer.invoke('poll:export-csv');
  if (res.ok) btn.textContent = '✓ Saved';
  else if (!res.canceled) btn.textContent = '✕ Failed';
  setTimeout(() => (btn.textContent = orig), 1800);
});

// Next question — keep cumulative scores, return to Phase 1.
document.getElementById('btn-next').addEventListener('click', () => {
  ipcRenderer.send('poll:next-question');
  ipcRenderer.send('poll:collapse');
  showLeaderboard(false);
  resetToInit();
});

// End session — clears cumulative scores.
document.getElementById('btn-end').addEventListener('click', () => {
  ipcRenderer.send('poll:end-session');
  showLeaderboard(false);
  resetToInit();
  setTitle('Session ended', false);
});

function resetToInit() {
  clearInterval(countdownTimer);
  showLeaderboard(false);
  showPhase('init');
  syncInitControls();
  document.getElementById('btn-pause').disabled = true;
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('btn-pause').textContent = '⏸';
  document.getElementById('clock-timeout').classList.add('hidden');
  document.getElementById('clock-digital').classList.remove('hidden');
  document.getElementById('clock-secs').textContent = selDuration;
  updateClock(selDuration, selDuration, true);
  setTitle('', false);
}

// ── Scraper status → title bar ──
ipcRenderer.on('poll:status', (_e, status) => {
  if (status.state === 'error') setTitle('⚠ ' + (status.detail || 'Chat error'), false);
});

// Handle custom duration input
document.getElementById('btn-set-custom').addEventListener('click', () => {
  const customInput = document.getElementById('custom-duration');
  const duration = parseInt(customInput.value);

  if (isNaN(duration) || duration < 1 || duration > 300) {
    customInput.style.borderColor = '#e74c3c';
    setTimeout(() => {
      customInput.style.borderColor = '';
    }, 2000);
    return;
  }

  selDuration = duration;
  syncInitControls();
  customInput.value = '';  // Clear the input after setting
});

// Auto-select custom mode when user starts typing in custom input field
document.getElementById('custom-duration').addEventListener('focus', () => {
  // When user focuses on the custom input, switch to custom mode
  // Remove selection from preset buttons
  document.querySelectorAll('#time-grid .time-btn').forEach((b) => {
    b.classList.remove('active');
  });
});

// Update selDuration when user enters a valid custom value
document.getElementById('custom-duration').addEventListener('input', () => {
  const customInput = document.getElementById('custom-duration');
  const inputValue = parseInt(customInput.value);
  if (!isNaN(inputValue) && inputValue >= 1 && inputValue <= 300) {
    selDuration = inputValue;
  }
});

// Allow Enter key in custom duration input - automatically set custom duration
document.getElementById('custom-duration').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const customInput = document.getElementById('custom-duration');
    const duration = parseInt(customInput.value);

    if (!isNaN(duration) && duration >= 1 && duration <= 300) {
      selDuration = duration;
      syncInitControls();
      customInput.value = '';  // Clear the input after setting
    } else {
      // If invalid, show error
      customInput.style.borderColor = '#e74c3c';
      setTimeout(() => {
        customInput.style.borderColor = '';
      }, 2000);
    }
  }
});

// ── util ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Boot
showPhase('init');
syncInitControls();
updateClock(selDuration, selDuration, true);
