const { ipcRenderer } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Persist settings to disk ──
const settingsPath = path.join(
  require('os').homedir(),
  '.classroom-timer-settings.json'
);

function loadSettingsFromDisk() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch(e) {}
  return null;
}

function saveSettingsToDisk(s) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  } catch(e) {}
}

// ── State ──
let settings = null;
let totalSeconds = 0;
let remainingSeconds = 0;
let timerInterval = null;
let isRunning = false;

const MIN_CIRCULAR = 200;
const MAX_CIRCULAR = 600;
const MIN_BAR_HEIGHT = 40;
const MAX_BAR_HEIGHT = 120;
const MIN_VERTICAL_WIDTH = 60;
const MAX_VERTICAL_WIDTH = 240;

// Minimum window width for circular mode so the control pill never gets cut.
// 8 buttons × 36px + 7 gaps × 8px + 24px padding + breathing room.
// Kept generous to account for macOS rendering / button-text variance.
const MIN_WINDOW_WIDTH = 460;

let circularSize  = 320;
let barHeight     = 56;
let verticalWidth = 90;

// Label font scale (1.0 = default). Applied to both circular curved labels
// and the horizontal bar segment labels. Adjustable from the control pane.
const FONT_SCALE_MIN  = 0.5;
const FONT_SCALE_MAX  = 2.0;
const FONT_SCALE_STEP = 0.1;
let fontScale = 1.0;

// ── DOM refs ──
const circularWidget  = document.getElementById('circular-widget');
const barWidget       = document.getElementById('bar-widget');
const verticalWidget  = document.getElementById('vertical-widget');
const timeDisplay     = document.getElementById('time-display');
const canvas          = document.getElementById('dial');
const ctx             = canvas.getContext('2d');
const barSegments     = document.getElementById('bar-segments');
const barMarker       = document.getElementById('bar-marker');
const barTimeOverlay  = document.getElementById('bar-time-overlay');
const verticalSegments    = document.getElementById('vertical-segments');
const verticalMarker      = document.getElementById('vertical-marker');
const verticalTimeOverlay = document.getElementById('vertical-time-overlay');

// ── Boot: load from disk first, then ask main for any override ──
const diskSettings = loadSettingsFromDisk();
if (diskSettings) {
  applySettings(diskSettings);
}
ipcRenderer.send('get-settings');

ipcRenderer.on('apply-settings', (event, s) => {
  applySettings(s);
});

function applySettings(s) {
  // Migrate old saved mode names that no longer exist.
  if (s.mode === 'vertical-left') s.mode = 'vertical';

  settings         = s;
  totalSeconds     = s.duration;
  remainingSeconds = s.duration;
  isRunning        = false;
  clearInterval(timerInterval);

  // Restore font scale if previously saved.
  if (typeof s.fontScale === 'number' && !isNaN(s.fontScale)) {
    fontScale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, s.fontScale));
  }
  applyBarFontScale();

  saveSettingsToDisk(s);
  applyMode();
  buildBarSegments();
  buildVerticalSegments();

  // Restore saved sizes on every settings apply
  if (s.circularSize) {
  circularSize = s.circularSize;
  canvas.width  = circularSize;
  canvas.height = circularSize;
  circularWidget.style.width  = `${Math.max(MIN_WINDOW_WIDTH, circularSize)}px`;
  circularWidget.style.height = `${circularSize + 70}px`;
  const centerDisplay = document.getElementById('center-display');
  if (centerDisplay) {
    centerDisplay.style.top = `${Math.round(circularSize * 0.46)}px`;
  }
  // Window width must fit either the dial or the control pill (whichever is wider).
  ipcRenderer.send('resize-window', {
    width:  Math.max(MIN_WINDOW_WIDTH, Math.round(circularSize)),
    height: Math.round(circularSize + 70)
  });
}
  if (s.barHeight) {
    barHeight = s.barHeight;
    const strip = document.getElementById('bar-strip');
    if (strip) strip.style.height = `${barHeight}px`;
    if (s.mode === 'bar') {
      ipcRenderer.send('resize-bar-window', { height: barHeight });
    }
  }
  if (s.verticalWidth) {
    verticalWidth = s.verticalWidth;
    if (s.mode === 'vertical' || s.mode === 'vertical-left') {
      ipcRenderer.send('resize-vertical-window', {
        width: verticalWidth,
        side: s.mode === 'vertical-left' ? 'left' : 'right'
      });
    }
  }

  render();
}

// ── Mode toggle (on widget) ──
document.getElementById('btn-mode').addEventListener('click', toggleMode);
document.getElementById('bar-btn-mode').addEventListener('click', toggleMode);
document.getElementById('vert-btn-mode').addEventListener('click', toggleMode);

function toggleMode() {
  if (!settings) return;
  // Cycle: circular → bar → vertical → circular
  const order = ['circular', 'bar', 'vertical'];
  const idx   = order.indexOf(settings.mode);
  settings.mode = order[(idx + 1) % order.length];
  // Save current sizes into settings before switching
  settings.circularSize  = circularSize;
  settings.barHeight     = barHeight;
  settings.verticalWidth = verticalWidth;
  saveSettingsToDisk(settings);
  ipcRenderer.send('switch-mode', settings);
}

// ── Gear ──
document.getElementById('btn-gear').addEventListener('click', () => ipcRenderer.send('open-settings'));
document.getElementById('bar-btn-gear').addEventListener('click', () => ipcRenderer.send('open-settings'));
document.getElementById('vert-btn-gear').addEventListener('click', () => ipcRenderer.send('open-settings'));

document.getElementById('btn-exit').addEventListener('click', () => ipcRenderer.send('exit-app'));
document.getElementById('bar-btn-exit').addEventListener('click', () => ipcRenderer.send('exit-app'));
document.getElementById('vert-btn-exit').addEventListener('click', () => ipcRenderer.send('exit-app'));

// ── Font size controls (A− / A+) ──
function applyBarFontScale() {
  // Scale the .bar-segment text via CSS variable so it grows/shrinks live.
  // Base size is 0.78rem (see timer.css). We override with inline style.
  document.querySelectorAll('.bar-segment').forEach(el => {
    el.style.fontSize = (0.78 * fontScale) + 'rem';
  });
}

function applyVerticalFontScale() {
  document.querySelectorAll('.vertical-segment').forEach(el => {
    el.style.fontSize = (0.78 * fontScale) + 'rem';
  });
}

function changeFontScale(delta) {
  fontScale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, fontScale + delta));
  fontScale = Math.round(fontScale * 10) / 10;
  applyBarFontScale();
  applyVerticalFontScale();
  if (settings) {
    settings.fontScale = fontScale;
    saveSettingsToDisk(settings);
  }
  render();
}

['btn-font-up', 'bar-btn-font-up', 'vert-btn-font-up'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => changeFontScale(+FONT_SCALE_STEP));
});
['btn-font-down', 'bar-btn-font-down', 'vert-btn-font-down'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => changeFontScale(-FONT_SCALE_STEP));
});



// ── Playback controls ──
document.getElementById('btn-start').addEventListener('click', startTimer);
document.getElementById('bar-btn-start').addEventListener('click', startTimer);
document.getElementById('vert-btn-start').addEventListener('click', startTimer);
document.getElementById('btn-pause').addEventListener('click', pauseTimer);
document.getElementById('bar-btn-pause').addEventListener('click', pauseTimer);
document.getElementById('vert-btn-pause').addEventListener('click', pauseTimer);
document.getElementById('btn-reset').addEventListener('click', resetTimer);
document.getElementById('bar-btn-reset').addEventListener('click', resetTimer);
document.getElementById('vert-btn-reset').addEventListener('click', resetTimer);

function startTimer() {
  if (isRunning) return;
  if (remainingSeconds <= 0) remainingSeconds = totalSeconds;
  isRunning = true;
  timerInterval = setInterval(() => {
    remainingSeconds--;
    render();
    if (remainingSeconds <= 0) {
      clearInterval(timerInterval);
      isRunning = false;
      onTimerEnd();
    }
  }, 1000);
}

function pauseTimer() {
  isRunning = false;
  clearInterval(timerInterval);
}

function resetTimer() {
  isRunning = false;
  clearInterval(timerInterval);
  remainingSeconds = totalSeconds;
  render();
}

function onTimerEnd() {
  if (settings && settings.sound) {
    try {
      const beep = new AudioContext();
      const osc  = beep.createOscillator();
      const gain = beep.createGain();
      osc.connect(gain);
      gain.connect(beep.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.6, beep.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, beep.currentTime + 1.2);
      osc.start();
      osc.stop(beep.currentTime + 1.2);
    } catch(e) {}
  }
}

// ── Apply mode ──
function applyMode() {
  if (!settings) return;
  circularWidget.classList.add('hidden');
  barWidget.classList.add('hidden');
  verticalWidget.classList.add('hidden');
  if (settings.mode === 'bar') {
    barWidget.classList.remove('hidden');
  } else if (settings.mode === 'vertical' || settings.mode === 'vertical-left') {
    verticalWidget.classList.remove('hidden');
    // Move the resize grip to the inward-facing edge so dragging always widens.
    const grip = document.getElementById('vertical-resize-grip');
    if (grip) {
      if (settings.mode === 'vertical-left') {
        grip.style.left = 'auto';
        grip.style.right = '2px';
        grip.style.cursor = 'ew-resize';
      } else {
        grip.style.right = 'auto';
        grip.style.left = '2px';
        grip.style.cursor = 'ew-resize';
      }
    }
  } else {
    circularWidget.classList.remove('hidden');
  }
}

// ── Zone helper ──
function getCurrentZone() {
  if (!settings) return { label: 'Ready', color: '#27ae60', index: 0 };
  const pct = (remainingSeconds / totalSeconds) * 100;
  for (let i = 0; i < settings.zones.length; i++) {
    if (pct >= settings.zones[i].threshold) {
      return { ...settings.zones[i], index: i };
    }
  }
  return { ...settings.zones[settings.zones.length - 1], index: settings.zones.length - 1 };
}

function formatTime(s) {
  const m   = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ── Build bar segments (once per settings load) ──
function buildBarSegments() {
  barSegments.innerHTML = '';
  if (!settings) return;
  // Zones ordered: zone[0]=75-100%, zone[1]=50-75%, zone[2]=25-50%, zone[3]=0-25%
  // In bar left→right means time passing, so zone[0] is leftmost (most time)
  settings.zones.forEach((zone, i) => {
    const seg = document.createElement('div');
    seg.className = 'bar-segment';
    seg.id = `seg-${i}`;
    seg.style.background = zone.color;
    seg.textContent = zone.label;
    barSegments.appendChild(seg);
  });
  applyBarFontScale();
}

// Vertical segments: zone[0] = top (most time), zone[3] = bottom (least time).
function buildVerticalSegments() {
  verticalSegments.innerHTML = '';
  if (!settings) return;
  settings.zones.forEach((zone, i) => {
    const seg = document.createElement('div');
    seg.className = 'vertical-segment';
    seg.id = `vseg-${i}`;
    seg.style.background = zone.color;
    seg.textContent = zone.label;
    verticalSegments.appendChild(seg);
  });
  applyVerticalFontScale();
}

// ── Render ──
function render() {
  if (!settings) return;
  const pct     = totalSeconds > 0 ? remainingSeconds / totalSeconds : 1;
  const zone    = getCurrentZone();
  const formatted = formatTime(remainingSeconds);

  if (settings.mode === 'circular') {
    timeDisplay.textContent = formatted;
    drawDial(pct, zone);
  } else if (settings.mode === 'vertical' || settings.mode === 'vertical-left') {
    renderVertical(pct, zone, formatted);
  } else {
    renderBar(pct, zone, formatted);
  }
}

// ── Render vertical ──
function renderVertical(pct, currentZone, formatted) {
  if (!settings) return;
  const currentPct = pct * 100;
  settings.zones.forEach((zone, i) => {
    const seg = document.getElementById(`vseg-${i}`);
    if (!seg) return;
    const isPast = currentPct < zone.threshold;
    seg.classList.toggle('dimmed', isPast);
  });
  // Marker moves top→bottom as time runs out (pct=1 → top=0%, pct=0 → top=100%)
  const strip = document.getElementById('vertical-strip');
  const stripH = strip ? strip.offsetHeight : window.innerHeight;
  const markerTop = (1 - pct) * stripH;
  verticalMarker.style.top = `${markerTop}px`;
  verticalTimeOverlay.textContent = formatted;
  const overlayH = 24;
  let overlayTop = markerTop - overlayH / 2;
  overlayTop = Math.max(4, Math.min(overlayTop, stripH - overlayH - 4));
  verticalTimeOverlay.style.top = `${overlayTop}px`;
}



// ── Render bar ──
function renderBar(pct, currentZone, formatted) {
  if (!settings) return;

  // Dim segments that are "past" (time has passed through them)
  // pct=1 full time, pct=0 done
  // zone[0]=75-100%, zone[1]=50-75%, zone[2]=25-50%, zone[3]=0-25%
  // A zone is "active" if current pct is within its range
  // A zone is "past" (dimmed) if pct has dropped below its threshold
  const currentPct = pct * 100;
  settings.zones.forEach((zone, i) => {
    const seg = document.getElementById(`seg-${i}`);
    if (!seg) return;
    // Each zone spans from zone.threshold down to the next zone's threshold
    // zone[0]: 75-100%, zone[1]: 50-75%, zone[2]: 25-50%, zone[3]: 0-25%
    // Upper bound of this zone
    const upperBound = i === 0 ? 100 : settings.zones[i - 1].threshold;
    // Segment is fully past when marker has moved beyond its upper bound
    const isPast = currentPct < zone.threshold;
    // Segment is active (marker currently inside it)
    const isActive = currentPct >= zone.threshold && currentPct < upperBound;
    seg.classList.toggle('dimmed', isPast);

    
   });

  // Marker position — moves left to right as time runs out
  // pct=1 → left=0%, pct=0 → left=100%
  const markerLeft = (1 - pct) * 100;
  const barW = barWidget.offsetWidth || window.innerWidth;
  const markerPx = (markerLeft / 100) * barW;

  barMarker.style.left = `${markerPx}px`;

  // Time overlay follows marker
  barTimeOverlay.textContent = formatted;
  const overlayW = 70;
  let overlayLeft = markerPx - overlayW / 2;
  overlayLeft = Math.max(4, Math.min(overlayLeft, barW - overlayW - 4));
  barTimeOverlay.style.left = `${overlayLeft}px`;
}

// ── RESIZE LOGIC ──



function applyCircularSize(size) {
  circularSize = Math.max(MIN_CIRCULAR, Math.min(MAX_CIRCULAR, size));

  // Resize canvas properly — no CSS transform
  canvas.width  = circularSize;
  canvas.height = Math.round(circularSize);
//   canvas.height = Math.round(circularSize * 0.94);

  // Resize the widget container
  circularWidget.style.width  = `${Math.max(MIN_WINDOW_WIDTH, circularSize)}px`;
  circularWidget.style.height = `${circularSize + 70}px`;

  // Reposition center display
  const centerDisplay = document.getElementById('center-display');
  centerDisplay.style.top = `${Math.round(circularSize * 0.46)}px`;

  // Tell main process to resize the window. Width never drops below
  // MIN_WINDOW_WIDTH so the control pill always fits.
  ipcRenderer.send('resize-window', {
    width:  Math.max(MIN_WINDOW_WIDTH, Math.round(circularSize)),
    height: Math.round(circularSize + 70)
  });

  // Redraw with new canvas size
  render();
}

function applyBarHeight(height) {
  barHeight = Math.max(MIN_BAR_HEIGHT, Math.min(MAX_BAR_HEIGHT, height));
  // barHeight controls the colored strip; the controls row sits below it.
  const strip = document.getElementById('bar-strip');
  if (strip) strip.style.height = `${barHeight}px`;
  ipcRenderer.send('resize-bar-window', {
    height: Math.round(barHeight)
  });
}

// Also fix drawDial to use dynamic canvas size
function getDialParams() {
  const size   = canvas.width  || 320;
  const height = canvas.height || 300;
  const cx     = size / 2;
  const cy     = height / 2;
  const outerR = size * 0.46;
  const trackR = size * 0.31;
  const innerR = size * 0.275;
  return { cx, cy, outerR, trackR, innerR, size, height };
}

// Draw text along a circular arc centered at `midAngle` on a circle of
// radius `radius` around (cx, cy). Text is auto-shrunk so its total arc
// length fits within `maxAngle` (segment span) and the font height fits
// within `maxHeight` (the ring band thickness).
// Top-half labels read left→right with characters facing outward.
// Bottom-half labels are drawn so they also read left→right (not upside-down).
function drawCurvedLabel(text, cx, cy, radius, midAngle, maxAngle, preferredFont, maxHeight) {
  const MIN_FONT   = 9;
  const fontFamily = 'Segoe UI, Arial';
  const PADDING    = 0.90; // leave a small gap from segment dividers

  // Normalize midAngle into [-PI, PI).
  let mid = midAngle;
  while (mid >=  Math.PI) mid -= Math.PI * 2;
  while (mid <  -Math.PI) mid += Math.PI * 2;
  // Canvas y grows downward, so angles in (0, PI) are the bottom half.
  const isBottom = mid > 0 && mid < Math.PI;

  // Pick the largest font that fits both angularly and in band thickness.
  let chosen = MIN_FONT;
  for (let f = preferredFont; f >= MIN_FONT; f--) {
    if (f * 1.1 > maxHeight) continue;
    ctx.font = `bold ${f}px ${fontFamily}`;
    const arcLen = ctx.measureText(text).width;
    if (arcLen / radius <= maxAngle * PADDING) { chosen = f; break; }
  }
  ctx.font = `bold ${chosen}px ${fontFamily}`;

  const chars  = Array.from(text);
  const widths = chars.map(c => ctx.measureText(c).width);
  const angles = widths.map(w => w / radius);
  const totalArc = angles.reduce((s, a) => s + a, 0);

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (!isBottom) {
    // Top half: walk clockwise (angle increasing) so text reads left→right.
    let a = mid - totalArc / 2;
    for (let i = 0; i < chars.length; i++) {
      const ca = a + angles[i] / 2;
      const x = cx + radius * Math.cos(ca);
      const y = cy + radius * Math.sin(ca);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ca + Math.PI / 2); // tangent, character upright facing outward
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
      a += angles[i];
    }
  } else {
    // Bottom half: walk counter-clockwise (angle decreasing) and flip each
    // character 180° so the text reads left→right and isn't upside-down.
    let a = mid + totalArc / 2;
    for (let i = 0; i < chars.length; i++) {
      const ca = a - angles[i] / 2;
      const x = cx + radius * Math.cos(ca);
      const y = cy + radius * Math.sin(ca);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ca - Math.PI / 2);
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
      a -= angles[i];
    }
  }
}

// ── OVERRIDE drawDial to use dynamic params ──
function drawDial(pct, currentZone) {
  const { cx, cy, outerR, trackR, innerR, size, height } = getDialParams();
  ctx.clearRect(0, 0, size, height);

  if (!settings) return;
  const zones       = settings.zones;
  const segAngle    = (Math.PI * 2) / 4;
  const startOffset = -Math.PI / 2;

  zones.forEach((zone, i) => {
    const segStart = startOffset + i * segAngle;
    const segEnd   = segStart + segAngle;

    ctx.beginPath();
    ctx.arc(cx, cy, outerR, segStart, segEnd);
    ctx.arc(cx, cy, trackR, segEnd, segStart, true);
    ctx.closePath();
    ctx.fillStyle = zone.color;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx + trackR * Math.cos(segStart), cy + trackR * Math.sin(segStart));
    ctx.lineTo(cx + outerR * Math.cos(segStart), cy + outerR * Math.sin(segStart));
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Curved label: text arcs along the colored ring band.
    const labelMidAngle = segStart + segAngle / 2;
    const labelR        = (outerR + trackR) / 2;

    ctx.fillStyle = 'rgba(255,255,255,0.95)';

    drawCurvedLabel(
      zone.label.toUpperCase(),
      cx, cy,
      labelR,
      labelMidAngle,
      segAngle,
      Math.round(size * 0.06 * fontScale), // preferred font scaled by user A−/A+ control
      (outerR - trackR)                    // radial band thickness (cap on font height)
    );
  });

  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(12,14,20,0.97)';
  ctx.fill();

  const needleAngle = startOffset + (1 - pct) * Math.PI * 2;
  const needleLen   = outerR - 4;
  const nx = cx + needleLen * Math.cos(needleAngle);
  const ny = cy + needleLen * Math.sin(needleAngle);

  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur  = 10;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(nx, ny);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.stroke();
  ctx.shadowBlur  = 0;

  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// Circular resize drag
const resizeGrip = document.getElementById('resize-grip');
let isResizing      = false;
let resizeStartX    = 0;
let resizeStartSize = 320;

resizeGrip.addEventListener('mousedown', (e) => {
  isResizing      = true;
  resizeStartX    = e.screenX;
  resizeStartSize = circularSize;
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const delta = e.screenX - resizeStartX;
  applyCircularSize(resizeStartSize + delta);
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  if (settings) {
    settings.circularSize = circularSize;
    saveSettingsToDisk(settings);
  }
});

// Bar resize drag
const barResizeGrip = document.getElementById('bar-resize-grip');
let isResizingBar   = false;
let barResizeStartY = 0;
let barResizeStartH = 56;

barResizeGrip.addEventListener('mousedown', (e) => {
  isResizingBar   = true;
  barResizeStartY = e.screenY;
  barResizeStartH = barHeight;
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizingBar) return;
  const delta = e.screenY - barResizeStartY;
  applyBarHeight(barResizeStartH + delta);
});

document.addEventListener('mouseup', () => {
  if (!isResizingBar) return;
  isResizingBar = false;
  if (settings) {
    settings.barHeight = barHeight;
    saveSettingsToDisk(settings);
  }
});

// Vertical resize drag (drag horizontally to change the vertical strip width)
function applyVerticalWidth(width) {
  verticalWidth = Math.max(MIN_VERTICAL_WIDTH, Math.min(MAX_VERTICAL_WIDTH, width));
  ipcRenderer.send('resize-vertical-window', {
    width: Math.round(verticalWidth),
    side: settings && settings.mode === 'vertical-left' ? 'left' : 'right'
  });
}

const verticalResizeGrip = document.getElementById('vertical-resize-grip');
let isResizingVert = false;
let vertResizeStartX = 0;
let vertResizeStartW = 90;

if (verticalResizeGrip) {
  verticalResizeGrip.addEventListener('mousedown', (e) => {
    isResizingVert  = true;
    vertResizeStartX = e.screenX;
    vertResizeStartW = verticalWidth;
    e.preventDefault();
  });
}

document.addEventListener('mousemove', (e) => {
  if (!isResizingVert) return;
  // For right-docked: dragging left (negative delta) increases width.
  // For left-docked:  dragging right (positive delta) increases width.
  const isLeft = settings && settings.mode === 'vertical-left';
  const delta  = isLeft
    ? (e.screenX - vertResizeStartX)
    : (vertResizeStartX - e.screenX);
  applyVerticalWidth(vertResizeStartW + delta);
});

document.addEventListener('mouseup', () => {
  if (!isResizingVert) return;
  isResizingVert = false;
  if (settings) {
    settings.verticalWidth = verticalWidth;
    saveSettingsToDisk(settings);
  }
});

// Apply saved sizes on load
if (settings?.circularSize)  applyCircularSize(settings.circularSize);
if (settings?.barHeight)     applyBarHeight(settings.barHeight);
if (settings?.verticalWidth) verticalWidth = settings.verticalWidth;