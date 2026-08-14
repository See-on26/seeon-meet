const { ipcRenderer } = require('electron');
const { scanRois } = require('./roi-scanner');

const POLL_MS = 500;
let isSendScheduled = false;

function sendRoiUpdate() {
  isSendScheduled = false;
  try {
    ipcRenderer.send('roi-update', scanRois());
  } catch {  }
}

function startWatching() {
  setInterval(sendRoiUpdate, POLL_MS);
  new MutationObserver(() => {
    if (!isSendScheduled) {
      isSendScheduled = true;
      setTimeout(sendRoiUpdate, 100);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWatching, { once: true });
} else {
  startWatching();
}
