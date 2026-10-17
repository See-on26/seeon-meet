import { IDLE_PHASE_LIST, pickRunSelection } from './control-sync.js';

const $ = (id) => document.getElementById(id);

// 팀 결정: 평가 설정을 켜면 균형 모드를 기본으로 고른다. 다른 모드도 직접 고를 수 있다.
const EVAL_PRESET_MODE = 'delayed';

let videoPath = null;
let isRoiEditing = false;
let lastStatus = { phase: 'idle', message: '', lastRunDir: null, runDir: null };

function render(status) {
  lastStatus = status;
  const isIdle = IDLE_PHASE_LIST.includes(status.phase);
  const selection = pickRunSelection({ status });
  if (selection.mode) $('modeSelect').value = selection.mode;
  if (selection.asrLanguage) $('languageSelect').value = selection.asrLanguage;
  $('pickBtn').disabled = !isIdle;
  $('modeSelect').disabled = !isIdle;
  $('languageSelect').disabled = !isIdle;
  $('evalPresetChk').disabled = !isIdle;
  $('roiBtn').disabled = !isIdle;
  $('roiBtn').classList.toggle('on', isRoiEditing);
  $('startBtn').disabled = !isIdle || !videoPath;
  $('pauseBtn').disabled = !['running', 'paused'].includes(status.phase);
  $('pauseBtn').textContent = status.phase === 'paused' ? '재개' : '일시정지';
  $('stopBtn').disabled = !['running', 'paused', 'draining'].includes(status.phase);
  $('resultBtn').disabled = !(status.lastRunDir || status.runDir);
  const errorText = status.errorList?.length ? ` · 오류 ${status.errorList.map((error) => error.code).join(', ')}` : '';
  $('statusText').textContent = `[${status.phase}] ${status.message || ''}${errorText}`;
  $('statusText').title = status.runDir || status.lastRunDir || '';
}

// 고른 영상은 재생 화면에 첫 화면으로 띄워, 시작 전에 그 위에서 ROI 를 맞출 수 있게 한다.
$('pickBtn').addEventListener('click', async () => {
  const pickedPath = await window.labControl.pickVideo();
  if (!pickedPath) return;
  videoPath = pickedPath;
  $('videoName').textContent = pickedPath.split('/').pop();
  $('videoName').title = pickedPath;
  render(lastStatus);
  const preview = await window.labControl.previewVideo({ videoPath: pickedPath });
  $('statusText').textContent = preview?.isOk
    ? '[준비] 첫 화면을 띄웠다 — 필요하면 ROI 편집으로 공유 화면 영역을 맞춘 뒤 시작'
    : `[준비] 첫 화면을 띄우지 못했다(시작은 할 수 있다): ${preview?.message || ''}`;
});

$('evalPresetChk').addEventListener('change', () => {
  if ($('evalPresetChk').checked) $('modeSelect').value = EVAL_PRESET_MODE;
});

$('roiBtn').addEventListener('click', async () => {
  const result = await window.labControl.setRoiEditing({ isEditing: !isRoiEditing });
  if (result?.isOk) isRoiEditing = !isRoiEditing;
  render(lastStatus);
});

$('startBtn').addEventListener('click', async () => {
  isRoiEditing = false;
  const result = await window.labControl.start({
    videoPath, mode: $('modeSelect').value, isEvalPreset: $('evalPresetChk').checked, asrLanguage: $('languageSelect').value,
  });
  if (!result?.isOk) $('statusText').textContent = `[시작 실패] ${result?.message || ''}`;
});

$('pauseBtn').addEventListener('click', () => {
  if (lastStatus.phase === 'paused') window.labControl.resume();
  else window.labControl.pause();
});

$('stopBtn').addEventListener('click', () => window.labControl.stop());
$('resultBtn').addEventListener('click', () => window.labControl.openResult());
$('demoBtn').addEventListener('click', () => window.labControl.openDemo());
$('subtitleBtn').addEventListener('click', () => window.labControl.openSubtitle());
$('flowBtn').addEventListener('click', () => window.labControl.openFlow());

window.labControl.onStatus(render);
window.labControl.getStatus().then(render);
