const { ipcRenderer } = require('electron');

let selectedDuration = 60;
let selectedMode = 'circular';
let selectedSound = true;

// Load current settings when window opens
ipcRenderer.on('load-settings', (event, settings) => {
  selectedDuration = settings.duration;
  selectedMode     = settings.mode;
  selectedSound    = settings.sound;

  // Apply mode
  setMode(selectedMode, true);

  // Apply sound
  setSound(selectedSound, true);

  // Apply duration display
  updateDurationDisplay();

  // Highlight matching preset if any
  highlightPreset(selectedDuration);

  // Apply zone labels
  settings.zones.forEach((zone, i) => {
    const input = document.getElementById(`zone-${i}`);
    if (input) input.value = zone.label;
  });
});

function setMode(mode, silent = false) {
  selectedMode = mode;
  document.getElementById('mode-circular').classList.toggle('active', mode === 'circular');
  document.getElementById('mode-bar').classList.toggle('active', mode === 'bar');
}

function setSound(val, silent = false) {
  selectedSound = val;
  document.getElementById('sound-on').classList.toggle('active', val === true);
  document.getElementById('sound-off').classList.toggle('active', val === false);
}

function setDuration(seconds) {
  selectedDuration = seconds;
  updateDurationDisplay();
  highlightPreset(seconds);
  document.getElementById('custom-seconds').value = '';
}

function applyCustom() {
  const val = parseInt(document.getElementById('custom-seconds').value);
  if (!val || val < 1) return;
  selectedDuration = val;
  updateDurationDisplay();
  highlightPreset(null); // clear preset highlights
}

function highlightPreset(seconds) {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.remove('selected');
  });
  const presets = [5,10,15,30,45,60,90,120,180,300,600,900];
  const idx = presets.indexOf(seconds);
  if (idx !== -1) {
    document.querySelectorAll('.preset-btn')[idx].classList.add('selected');
  }
}

function updateDurationDisplay() {
  const m = Math.floor(selectedDuration / 60);
  const s = selectedDuration % 60;
  let text = '';
  if (m > 0) text += `${m}m `;
  if (s > 0) text += `${s}s`;
  document.getElementById('duration-display').textContent = `Selected: ${text.trim()}`;
}

function save() {
  const zones = [
    { label: document.getElementById('zone-0').value || 'Exam Topper',     threshold: 75, color: '#27ae60' },
    { label: document.getElementById('zone-1').value || 'Exam Qualifier',  threshold: 50, color: '#f39c12' },
    { label: document.getElementById('zone-2').value || '50-50 Chance',    threshold: 25, color: '#e67e22' },
    { label: document.getElementById('zone-3').value || 'Need To Improve', threshold: 0,  color: '#e74c3c' },
  ];

  const newSettings = {
    mode:     selectedMode,
    duration: selectedDuration,
    sound:    selectedSound,
    zones:    zones
  };

  ipcRenderer.send('save-settings', newSettings);
}

function cancel() {
  ipcRenderer.send('cancel-settings');
}