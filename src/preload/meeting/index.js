const { ipcRenderer } = require('electron');
const { scanRois } = require('./roi-scanner');

const POLL_MS = 500;
// 창·패널 크기가 바뀌면 Meet 이 타일을 다시 배치한다. 다음 폴링(최대 500ms)을 기다리지 않고 배치가 끝날 즈음 바로 잰다.
const RESIZE_SCAN_DELAY_MS = 150;
let isSendScheduled = false;
let resizeScanTimer = null;

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
  window.addEventListener('resize', () => {
    clearTimeout(resizeScanTimer);
    resizeScanTimer = setTimeout(sendRoiUpdate, RESIZE_SCAN_DELAY_MS);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWatching, { once: true });
} else {
  startWatching();
}
