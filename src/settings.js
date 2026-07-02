const { ipcRenderer } = require('electron');

let selDuration = 30;
let selOptions = 4;
let licenseValid = false;

// Load current config when the window opens.
ipcRenderer.on('load-config', (_e, config) => {
  document.getElementById('license-key').value = config.licenseKey || '';
  document.getElementById('stream-url').value = config.streamUrl || '';
  document.getElementById('buffer-offset').value = config.bufferOffsetSec ?? 0;
  selDuration = config.duration || 30;
  selOptions = config.optionCount || 4;
  if (config.licenseKey) {
    licenseValid = true;
    setLicenseStatus('Activated ✓', false);
  }
  syncControls();
});

function syncControls() {
  document.querySelectorAll('.preset-btn').forEach((b) => {
    b.classList.toggle('selected', Number(b.dataset.dur) === selDuration);
  });
  document.getElementById('opt-4').classList.toggle('active', selOptions === 4);
  document.getElementById('opt-5').classList.toggle('active', selOptions === 5);
}

function setDuration(s) {
  selDuration = s;
  syncControls();
}
function setOptions(n) {
  selOptions = n;
  syncControls();
}

function setLicenseStatus(msg, isError) {
  const el = document.getElementById('license-status');
  el.textContent = msg;
  el.style.color = isError ? '#e74c3c' : '#27ae60';
}

async function checkLicense() {
  const key = document.getElementById('license-key').value;
  setLicenseStatus('Checking…', false);
  const result = await ipcRenderer.invoke('verify-license', key);
  licenseValid = result.valid;
  if (result.valid) {
    setLicenseStatus(`Activated ✓ (${result.plan})`, false);
  } else {
    setLicenseStatus(result.reason || 'Invalid key', true);
  }
}

function save() {
  const newConfig = {
    licenseKey: document.getElementById('license-key').value.trim(),
    streamUrl: document.getElementById('stream-url').value.trim(),
    bufferOffsetSec: parseFloat(document.getElementById('buffer-offset').value) || 0,
    duration: selDuration,
    optionCount: selOptions,
  };
  ipcRenderer.send('save-config', newConfig);
}

function cancel() {
  ipcRenderer.send('cancel-settings');
}
