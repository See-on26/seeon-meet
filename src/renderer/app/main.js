import {
  CROP_JPEG_QUALITY, NARRATION_TYPE_MAP,
  PAGE_TRANSITION_KIND_MAP, USER_COMMAND_KEY_MAP, USER_COMMAND_MAP, SUMMARY_TOGGLE_KEY,
  MEET_MEETING_URL_PATTERN, SPEAKER_SOURCE_MAP, DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP,
} from '../core/constants.js';
import {
  MODE_MAP, DWELL_MS, IS_DELAY_BUFFER_ENABLED,
  computeWordBudget, canSwitchMode, getModePolicy, getCatchupRateRange,
  computeLookaheadMs, computeContextHoldMs, resolveBeforeAnchorTs,
} from '../core/mode/mode-policy.js';
import { CONTEXT_TOKEN_BUDGET } from '../core/mode/context-budget.js';

import { DelayBuffer, isCaptionDroppable, EXCESS_DROP_MS } from '../core/audio-renderer/delay-buffer.js';
import { StreamDelaySource } from '../core/audio-renderer/stream-delay-source.js';
import { NarrationScheduler } from '../core/audio-renderer/narration-scheduler.js';
import { GapCandidateStore } from '../core/audio-renderer/gap-candidate-store.js';
import { CaptionNarrator } from '../core/audio-renderer/caption-narrator.js';
import { NarrationMixer } from '../core/audio-renderer/narration-mixer.js';

import { AudioMeter } from '../core/trigger/audio-meter.js';
import { AsrSegmenter } from '../core/trigger/asr-segmenter.js';
import {
  UtteranceBoundaryDetector, classifyUtteranceEnding, buildSegmentBoundaryList,
} from '../core/trigger/utterance-boundary-detector.js';
import { TranscriptWindow } from '../core/trigger/transcript-window.js';
import { DeixisDetector } from '../core/trigger/deixis-detector.js';
import { DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP } from '../core/trigger/deixis-candidate-scheduler.js';
import { judgeScreenDependency, SCREEN_DEPENDENCY_REASON_MAP } from '../core/trigger/screen-dependency.js';
import { PointingLocator, describeDirection } from '../core/trigger/pointing-locator.js';
import { SlideHistogramGate } from '../core/trigger/slide-histogram-gate.js';
import { SlideEmbeddingRegistry } from '../core/trigger/slide-embedding-registry.js';
import { SlideDwellGate, DWELL_STATE_MAP } from '../core/trigger/slide-dwell-gate.js';
import { computeGridEmbedding } from '../core/trigger/frame-embedding.js';
import { showModal } from './modal.js';

import { RoiStore, SPEAKER_VERDICT_MAP } from '../core/roi/roi-store.js';
import { MeetCaptureSession } from '../core/capture/meet-capture-session.js';

const $ = (id) => document.getElementById(id);

const captureSource = new MeetCaptureSession();

const roiStore = new RoiStore({ isFullFrameFallback: false, isStabilized: true });

const ROI_CHANGE_SUPPRESS_MS = 1500;
const FRAME_ASPECT_TOLERANCE = 0.02;
let lastScreenGeneration = 0;
let roiChangeSuppressUntil = 0;

let latestMeetUrl = '';
let latestMeetTileCount = 0;

let delayBuffer = null;

let narrationScheduler = null;

const gapCandidateStore = new GapCandidateStore({});

let lastScreenNarration = '';

const getPlaybackVideo = () => delayBuffer?.delayedVideo || captureSource.liveVideo || null;

function handleNarrationStatus(text) {
  $('stDelay').textContent = text || '–';
}

const narrator = new CaptionNarrator({
  getLiveVideo: getPlaybackVideo,
  onStatus: handleNarrationStatus,
  getRateRange: () => getCatchupRateRange({ mode: getCurrentMode() }),
  isCatchupDelegated: () => Boolean(delayBuffer),
});

let narrationMixer = null;

const getNarrationPlayer = () => narrationMixer || narrator;
const audioMeter = new AudioMeter();

function markDebug({ stage, verdict, reason, detail = '', narrationType = null }) {
  window.seeon.appendDebugLog({ stage, verdict, reason, detail, narrationType, ts: Date.now() });
}

const LOG_TAG_MAP = {
  'page-transition': { aid: 'A1', label: '페이지 전환' },
  [NARRATION_TYPE_MAP.pageTransition]: { aid: 'A1', label: '페이지 전환' },
  [NARRATION_TYPE_MAP.deixis]: { aid: 'A2', label: '지시 대상' },
  [NARRATION_TYPE_MAP.interpretation]: { aid: 'A3', label: '수치 의미' },
  [NARRATION_TYPE_MAP.visualDescription]: { aid: 'A4', label: '시각 정보' },
  [NARRATION_TYPE_MAP.userCommand]: { aid: 'Q', label: '명령 응답' },
  [NARRATION_TYPE_MAP.speakerIdentity]: { aid: 'S', label: '발화자' },
};

const pad2 = (n) => String(n).padStart(2, '0');
function formatClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function clearStreamEmpty() {
  $('streamEmpty')?.remove();
}

function scrollStreamToBottom() {
  const stream = $('logStream');
  if (stream) stream.scrollTop = stream.scrollHeight;
}

function appendLogCard({ source, text, ts = Date.now() }) {
  const stream = $('logStream');
  if (!stream) return;
  clearStreamEmpty();
  const tag = LOG_TAG_MAP[source] || { aid: '·', label: '화면 해설' };
  const card = document.createElement('div');
  card.className = 'card';
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const tagEl = document.createElement('span');
  tagEl.className = 'card-tag';
  const aid = document.createElement('span');
  aid.className = 'aid';
  aid.textContent = tag.aid;
  tagEl.append(aid, document.createTextNode(tag.label));
  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatClock(ts);
  meta.append(tagEl, time);
  const body = document.createElement('div');
  body.className = 'card-body';
  body.textContent = text;
  card.append(meta, body);
  stream.append(card);
  scrollStreamToBottom();
}

function appendAskBubble({ text, ts = Date.now() }) {
  const stream = $('logStream');
  if (!stream) return;
  clearStreamEmpty();
  const ask = document.createElement('div');
  ask.className = 'ask';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = `나 · ${formatClock(ts)}`;
  ask.append(bubble, who);
  stream.append(ask);
  scrollStreamToBottom();
}

function showNotice(text) {
  const stream = $('logStream');
  if (!stream) return;
  clearStreamEmpty();
  const sys = document.createElement('div');
  sys.className = 'sys';
  sys.textContent = text;
  stream.append(sys);
  scrollStreamToBottom();
}

const isPipelineEnabled = () => $('pipeChk').checked;
let isExperimentPaused = false;

let currentMode = MODE_MAP.realtimeMix;

const ONLINE_SUPPORTED_MODE_LIST = [
  MODE_MAP.listening, MODE_MAP.delayed, MODE_MAP.realtimeSic, MODE_MAP.realtimeMix,
];

const DRIFT_WARN_MS = 500;

const MODE_BUTTON_LIST = [
  { mode: MODE_MAP.listening, axis: 'delayed', label: '품질', out: '화면 해설 내레이션이 가장 정확한 자리에 들어갑니다' },
  { mode: MODE_MAP.delayed, axis: 'delayed', label: '균형', out: '정확도와 실시간성의 균형' },
  { mode: MODE_MAP.realtimeSic, axis: 'delayed', label: '성능', out: '회의를 거의 실시간으로 따라갑니다' },
  { mode: MODE_MAP.realtimeMix, axis: 'concurrent', label: '동시', out: '회의와 화면 해설 내레이션을 함께 들려줍니다 (정지 없음)' },
];

const getCurrentMode = () => currentMode;

function buildWordBudget({ narrationType, subKind = null }) {
  return computeWordBudget({ mode: getCurrentMode(), narrationType, subKind, currentDelayMs: 0 });
}

const ROUTABLE_TYPE_LIST = [
  NARRATION_TYPE_MAP.deixis, NARRATION_TYPE_MAP.interpretation, NARRATION_TYPE_MAP.visualDescription,
];

function buildWordBudgetMap() {
  const budgetMap = {};
  for (const narrationType of ROUTABLE_TYPE_LIST) {
    budgetMap[narrationType] = buildWordBudget({ narrationType });
  }
  return budgetMap;
}

function startNarrationPlayer({ stream }) {
  const policy = getModePolicy({ mode: getCurrentMode() });
  if (policy?.isMixed) {
    narrationMixer = new NarrationMixer({ onStatus: handleNarrationStatus });
    narrationMixer.start(stream);

    captureSource.detachDirectAudio();
    console.log('[mix] 실시간 믹싱 모드 — 회의음 우측 덕킹 / 내레이션 좌측');
    return;
  }

  if (!delayBuffer) captureSource.attachDirectAudio();
  narrator.start(stream);
}

function stopNarrationPlayer() {
  if (narrationMixer) { narrationMixer.stop(); narrationMixer = null; return; }
  narrator.stop();
}

function startDelayBufferIfNeeded({ fromTimeMs = null } = {}) {
  const policy = getModePolicy({ mode: getCurrentMode() });

  if (!IS_DELAY_BUFFER_ENABLED) {
    $('stBuffer').textContent = '지연 기능 임시 해제';
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '지연 버퍼 임시 해제',
      detail: `모드=${getCurrentMode()} · 라이브 재생 · 출력=${describeModeOutput({ mode: getCurrentMode() })}`,
    });
    return;
  }
  if (!policy || policy.isMixed) {
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '믹싱 모드 — 지연 버퍼 없음',
      detail: `모드=${getCurrentMode()} · 라이브 스트림을 좌우로 믹싱`,
    });
    return;
  }
  const delaySource = new StreamDelaySource({
    stream: captureSource.stream,
    getVideoTimeMs: () => captureSource.videoTimeMs,
    targetDelayMs: policy.delayMs,
    onError: handleDelaySourceError,
  });
  delayBuffer = new DelayBuffer({
    source: delaySource,
    targetDelayMs: policy.delayMs,
    rateMin: policy.rateMin,
    rateMax: policy.rateMax,
    onBufferChange: handleDelayBufferChange,
  });
  const delayedAudio = delayBuffer.start({ fromTimeMs });
  captureSource.detachDirectAudio();
  document.body.appendChild(delayedAudio);
  delayedAudio.style.display = 'none';
  startDriftMonitor({ delaySource });

  narrationScheduler = new NarrationScheduler({
    getPlaybackTimeMs: () => (delayBuffer ? delayBuffer.getDelayedTimeMs() : Infinity),
    onDue: ({ wavArrayBuffer, captionCaptureMs }) => {
      console.log(`[delay] 삽입 시점 도달 (영상 ${Math.round(captionCaptureMs)}ms 지점)`);
      getNarrationPlayer().queueCaption(wavArrayBuffer);
    },
  });
  narrationScheduler.start();
  console.log(`[delay] 지연 버퍼 시작 — 목표 ${policy.delayMs}ms, 배속 ${policy.rateMin}~${policy.rateMax}`);
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '지연 버퍼 시작',
    detail: `모드=${getCurrentMode()} 목표 지연=${policy.delayMs}ms · 버퍼가 찰 때까지 화면·소리가 나오지 않는 것이 정상`,
  });
}

let driftTimerHandle = null;

function handleDelaySourceError({ reason, detail }) {
  console.warn(`[delay] ${reason}: ${detail}`);
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.skip,
    reason, detail: `${detail} · 실시간 믹싱으로 내려간다`,
  });
  showNotice('지연 버퍼에 문제가 생겨 실시간 믹싱으로 전환합니다');
  stopDelayBuffer();
  currentMode = MODE_MAP.realtimeMix;
  renderModeButtons();
  applyNarrationPlayerForMode();
}

function startDriftMonitor({ delaySource }) {
  stopDriftMonitor();
  driftTimerHandle = setInterval(() => {
    const driftMs = delaySource.getDriftMs();
    if (Math.abs(driftMs) <= DRIFT_WARN_MS) return;
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '재생 시계 드리프트',
      detail: `벽시계 대비 ${Math.round(driftMs)}ms · 삽입 지점이 그만큼 밀린다`,
    });
  }, 10000);
}

function stopDriftMonitor() {
  if (driftTimerHandle === null) return;
  clearInterval(driftTimerHandle);
  driftTimerHandle = null;
}

function handleDelayBufferChange({ isBuffering, remainingMs }) {
  if (!isBuffering) {
    $('stBuffer').textContent = '재생 중';
    setPrepOverlay({ isVisible: false });
    return;
  }
  const remainingSec = Math.ceil(remainingMs / 1000);
  $('stBuffer').textContent = `버퍼 채우는 중 ${remainingSec}초`;
  setPrepOverlay({ isVisible: true, remainingSec });
}

function setPrepOverlay({ isVisible, remainingSec = 0 }) {
  $('prepOverlay').hidden = !isVisible;
  $('prepRemain').textContent = isVisible ? `${remainingSec}초 후 시작됩니다` : '';
}

function stopDelayBuffer() {
  stopDriftMonitor();
  narrationScheduler?.reset();
  narrationScheduler = null;
  $('stBuffer').textContent = '–';
  setPrepOverlay({ isVisible: false });
  if (!delayBuffer) return;
  delayBuffer.delayedVideo?.remove();
  delayBuffer.stop();
  delayBuffer = null;
}

function describeModeOutput({ mode }) {
  const entry = MODE_BUTTON_LIST.find((item) => item.mode === mode);
  return entry ? entry.out : '';
}

const CROSS_MODE_LIST = [MODE_MAP.listening, MODE_MAP.delayed, MODE_MAP.realtimeSic];
const CONCURRENT_MODE = MODE_MAP.realtimeMix;
const isCrossMode = (mode) => CROSS_MODE_LIST.includes(mode);
let lastCrossMode = MODE_MAP.realtimeSic;

function buildModeButtons() {
  const toggle = $('modeToggle');
  for (const opt of toggle.querySelectorAll('.opt')) {
    opt.addEventListener('click', () => handleClickModeAxis({ axis: opt.dataset.axis }));
  }
  for (const button of $('modeSegment').querySelectorAll('button')) {
    button.addEventListener('click', () => handleClickModeButton({ mode: button.dataset.mode }));
  }
  renderModeButtons();
}

function handleClickModeAxis({ axis }) {
  handleClickModeButton({ mode: axis === 'concurrent' ? CONCURRENT_MODE : lastCrossMode });
}

function renderModeButtons() {
  const toggle = $('modeToggle');
  const segment = $('modeSegment');
  if (!toggle || !segment) return;
  const axis = isCrossMode(currentMode) ? 'delayed' : 'concurrent';
  const active = captureSource.isActive;
  toggle.dataset.axis = axis;

  for (const opt of toggle.querySelectorAll('.opt')) {
    const target = opt.dataset.axis === 'concurrent' ? CONCURRENT_MODE : lastCrossMode;
    opt.classList.toggle('active', opt.dataset.axis === axis);
    opt.disabled = active && target !== currentMode
      && !canSwitchMode({ fromMode: currentMode, toMode: target });
  }

  $('segmentField').hidden = axis !== 'delayed';
  for (const button of segment.querySelectorAll('button')) {
    const mode = button.dataset.mode;
    const isOn = isCrossMode(currentMode) ? mode === currentMode : mode === lastCrossMode;
    button.classList.toggle('on', isOn);
    if (!ONLINE_SUPPORTED_MODE_LIST.includes(mode)) { button.disabled = true; continue; }
    button.disabled = active && mode !== currentMode
      && !canSwitchMode({ fromMode: currentMode, toMode: mode });
  }

  const note = $('modeNote');
  if (note) {
    note.textContent = '교차모드는 화면 해설 내레이션을 다듬어 조금 늦게, 동시모드는 회의와 겹쳐 바로 들려줍니다.'
      + ' 품질·균형으로 바꾼 뒤에는 되돌릴 수 없습니다.';
  }
}

function handleClickModeButton({ mode }) {
  if (mode === currentMode) return;

  if (captureSource.isActive && !canSwitchMode({ fromMode: currentMode, toMode: mode })) {
    showNotice('품질·균형으로 바꾼 뒤에는 되돌릴 수 없습니다'
      + ' (놓친 구간 없이 들려드리기 위해서입니다)');
    return;
  }
  const previousMode = currentMode;
  currentMode = mode;
  if (isCrossMode(mode)) lastCrossMode = mode;
  renderModeButtons();

  candidateScheduler.setLookaheadMs({ lookaheadMs: computeLookaheadMs({ mode }) });
  asrSegmenter.setSegmentMs({ segmentMs: getModePolicy({ mode })?.asrSegmentMs });
  const isDelayStarted = applyDelayBufferForMode();
  applyNarrationPlayerForMode();
  console.log(`[mode] ${previousMode} → ${currentMode} (${describeModeOutput({ mode })})`);
  if (!captureSource.isActive) return;
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '모드 전환',
    detail: `${previousMode} → ${currentMode} · ${describeModeOutput({ mode })}`
      + (isDelayStarted ? ` · 지연 ${getModePolicy({ mode })?.delayMs}ms를 지금부터 쌓는다(준비 화면)` : ''),
  });
}

function applyDelayBufferForMode() {
  if (!captureSource.isActive) return false;
  const policy = getModePolicy({ mode: getCurrentMode() });
  if (!policy || policy.isMixed || delayBuffer) return false;

  const liveVideo = captureSource.liveVideo;
  const fromTimeMs = liveVideo ? liveVideo.currentTime * 1000 : 0;
  if (liveVideo) liveVideo.playbackRate = 1.0;
  startDelayBufferIfNeeded({ fromTimeMs });
  return Boolean(delayBuffer);
}

function applyNarrationPlayerForMode() {
  if (!captureSource.isActive || isExperimentPaused) return;
  const isMixedNow = Boolean(narrationMixer);
  const isMixedNext = Boolean(getModePolicy({ mode: getCurrentMode() })?.isMixed);
  if (isMixedNow === isMixedNext) return;
  stopNarrationPlayer();

  if (!delayBuffer?.isBuffering) getPlaybackVideo()?.play().catch(() => {});

  startNarrationPlayer({ stream: captureSource.stream });
}

window.seeon.onRoiUpdate((payload) => {
  latestMeetUrl = payload.url || '';
  latestMeetTileCount = payload.roiList.length;
  roiStore.submitViewportRoiList(payload);
  syncToggleAvailability();
});
buildModeButtons();

const POINTING_SAMPLE_MS = 400;
const POINTING_SAMPLE_WIDTH = 480;
const POINTING_SAMPLE_HEIGHT = 270;
const POINTING_CROP_MARGIN = 0.12;
const POINTING_MOTION_DEBOUNCE_MS = 800;

const transcriptWindow = new TranscriptWindow({});

let lastScreenTransitionAt = null;

let experimentSeq = 0;

let currentSessionId = null;

let isSummaryEnabled = true;
let deixisFrameSeq = 0;

const pointingLocator = new PointingLocator({ rowCount: 18, colCount: 32, cellChangeThreshold: 4 });

const LOCAL_EMBED_MATCH_THRESHOLD = 0.02;
const histogramGate = new SlideHistogramGate({});
const slideRegistry = new SlideEmbeddingRegistry({});

const slideDwellGate = new SlideDwellGate({
  onSatisfied: ({ label, isRevisit }) => {
    console.log(`[slide] 체류 확정 ${label}${isRevisit ? ' (재방문)' : ''}`);
    markDebug({
      stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.pass,
      narrationType: NARRATION_TYPE_MAP.pageTransition,
      reason: `체류 확정 (${DWELL_MS}ms)`,
      detail: `슬라이드 ${label}${isRevisit ? ' 재방문' : ''} · ${isSpeculativeMode() ? '선판정분 재생 허용' : '지금 고지 생성'}`,
    });

    if (!isSpeculativeMode()) requestPageTransitionNarration({ label, isRevisit });
  },
  onCancelled: ({ label, isRevisit }) => {
    console.log(`[slide] 체류 미달 — 고지 취소 ${label}`);
    markDebug({
      stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.pageTransition,
      reason: `체류 미달 (${DWELL_MS}ms 못 채움)`,
      detail: `슬라이드 ${label}${isRevisit ? ' 재방문' : ''} — 스쳐 지나간 화면은 고지하지 않는다(§5.4)`,
    });
  },
});

function isSpeculativeMode() {
  return Boolean(getModePolicy({ mode: getCurrentMode() })?.isSpeculative);
}
let isConfirmingSlide = false;
let hasWarnedLocalEmbedding = false;
let lastGateLogAt = 0;
let pointingSampleTimer = null;
let pointingSampleCanvas = null;
let lastPointingMotionAt = -Infinity;

function getPointingSequence() {
  const sequence = pointingLocator.locateSequence({ nowTs: performance.now() });
  const pointingOrderHint = sequence.events.length >= 2
    ? sequence.events.map((event, i) => `${i + 1}) ${describeDirection(event.centroid)}`).join(', ')
    : '';
  return { region: sequence.hasRegion ? sequence.unionRect : null, pointingOrderHint };
}

function getFrameRegionPx() {
  const liveVideo = captureSource.liveVideo;
  if (!liveVideo || !liveVideo.videoWidth) return null;
  const vw = liveVideo.videoWidth; const vh = liveVideo.videoHeight;

  const viewport = roiStore.getViewport();
  if (viewport && Math.abs((vw / vh) / (viewport.vw / viewport.vh) - 1) > FRAME_ASPECT_TOLERANCE) return null;
  const screen = roiStore.getScreenRectNorm();
  return screen ? normRectToPx(screen, vw, vh) : null;
}

function narrowToPointingRegion(frame, sub) {
  const x0 = Math.max(0, sub.x - POINTING_CROP_MARGIN);
  const y0 = Math.max(0, sub.y - POINTING_CROP_MARGIN);
  const x1 = Math.min(1, sub.x + sub.w + POINTING_CROP_MARGIN);
  const y1 = Math.min(1, sub.y + sub.h + POINTING_CROP_MARGIN);
  return { x: frame.x + x0 * frame.w, y: frame.y + y0 * frame.h, w: (x1 - x0) * frame.w, h: (y1 - y0) * frame.h };
}

async function captureFrameJpeg(subRegion = null) {
  const frame = getFrameRegionPx();
  if (!frame) return null;
  return captureRegionJpeg(subRegion ? narrowToPointingRegion(frame, subRegion) : frame);
}

async function captureRegionJpeg(region) {
  if (!region || !captureSource.liveVideo) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(region.w));
  canvas.height = Math.max(2, Math.round(region.h));
  canvas.getContext('2d').drawImage(
    captureSource.liveVideo, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CROP_JPEG_QUALITY));
  return blob ? blob.arrayBuffer() : null;
}

function normRectToPx(rect, vw, vh) {
  return { x: rect.x * vw, y: rect.y * vh, w: rect.w * vw, h: rect.h * vh };
}

function syncRoiGeneration({ ts }) {
  const generation = roiStore.getScreenGeneration();
  if (generation === lastScreenGeneration) return;
  lastScreenGeneration = generation;
  histogramGate.reset();
  pointingLocator.reset();
  lastPointingMotionAt = -Infinity;
  slideDwellGate.reset();
  roiChangeSuppressUntil = ts + ROI_CHANGE_SUPPRESS_MS;
  markDebug({
    stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.info,
    reason: 'ROI 좌표 변경 → 전환 감지기 리셋',
    detail: `세대=${generation} · 공유화면=${roiStore.hasScreenShare() ? '있음' : '없음'}`,
  });
}

function samplePointingFrame() {
  const ts = performance.now();
  syncRoiGeneration({ ts });
  const frame = getFrameRegionPx();
  if (!frame) return;
  if (!pointingSampleCanvas) {
    pointingSampleCanvas = document.createElement('canvas');
    pointingSampleCanvas.width = POINTING_SAMPLE_WIDTH;
    pointingSampleCanvas.height = POINTING_SAMPLE_HEIGHT;
  }
  const context = pointingSampleCanvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(
    captureSource.liveVideo, frame.x, frame.y, frame.w, frame.h,
    0, 0, POINTING_SAMPLE_WIDTH, POINTING_SAMPLE_HEIGHT);
  const imageData = context.getImageData(0, 0, POINTING_SAMPLE_WIDTH, POINTING_SAMPLE_HEIGHT);
  pointingLocator.sample({ imageData, ts });
  detectSlideTransition({ imageData, ts });
  submitPointingMotionCandidate();
}

function detectSlideTransition({ imageData, ts }) {
  const verdict = histogramGate.sample({ imageData, ts });

  if (ts - lastGateLogAt > 1000) {
    lastGateLogAt = ts;
    const region = roiStore.hasScreenShare() ? 'screen-roi' : 'full-frame';
    console.log(`[slide][gate] ff=${histogramGate.lastFrameToFrame.toFixed(3)} cvr=${histogramGate.lastChangeVsRef.toFixed(3)} state=${histogramGate.state} still=${histogramGate.stillCount} (motion≥${histogramGate.motionDistance}, still≤${histogramGate.stillDistance}, region=${region})`);
  }

  if (ts < roiChangeSuppressUntil) return;
  if (!verdict.isTransition && !verdict.isFirst) return;
  if (isConfirmingSlide) return;
  isConfirmingSlide = true;
  confirmSlideCandidate({ isFirst: verdict.isFirst, imageData })
    .catch((error) => console.warn('[slide] 전환 확정 오류', error))
    .finally(() => { isConfirmingSlide = false; });
}

async function confirmSlideCandidate({ isFirst, imageData }) {
  const buffer = await captureFrameJpeg();
  const remote = buffer ? await window.seeon.embedFrame({ buffer }).catch(() => null) : null;
  const isRemoteEmbedding = Boolean(remote?.isOk && Array.isArray(remote.embedding));
  const embedding = isRemoteEmbedding ? remote.embedding : computeGridEmbedding(imageData);
  if (!isRemoteEmbedding && !hasWarnedLocalEmbedding) {
    hasWarnedLocalEmbedding = true;
    console.warn('[slide] GPU 임베딩 서버 미연결 — 로컬 그리드 임베딩으로 폴백(정확도 낮음, 고지는 유지)');
  }

  const decision = slideRegistry.handleCandidate(isRemoteEmbedding
    ? { embedding }
    : { embedding, matchThreshold: LOCAL_EMBED_MATCH_THRESHOLD });
  const distance = decision.distance.toFixed(3);
  const source = isRemoteEmbedding ? 'gpu' : 'local';
  if (decision.isSameSlide) {
    console.log(`[slide] 동일 슬라이드 ${decision.label} (거리=${distance} src=${source}) → 고지 안 함`);
    markDebug({
      stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.pageTransition,
      reason: '동일 슬라이드 — 전환 아님',
      detail: `슬라이드 ${decision.label} 거리=${distance} 임베딩=${source}`,
    });
    return;
  }
  if (!decision.isNew && !decision.isRevisit) return;
  const isRevisit = Boolean(decision.isRevisit);

  lastScreenTransitionAt = performance.now();
  console.log(`[slide] ${isRevisit ? '재방문' : (isFirst ? '첫' : '새')} 슬라이드 ${decision.label} (거리=${distance} src=${source}) → 체류 ${DWELL_MS}ms 판정`);
  markDebug({
    stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.info,
    narrationType: NARRATION_TYPE_MAP.pageTransition,
    reason: `${isRevisit ? '재방문' : (isFirst ? '첫' : '새')} 슬라이드 확정`,
    detail: `슬라이드 ${decision.label} 거리=${distance} 임베딩=${source} → 체류 ${DWELL_MS}ms ${isSpeculativeMode() ? '선판정(즉시 생성, 재생 전 취소)' : '후판정(확정 후 생성)'}`,
  });

  slideDwellGate.enter({ label: decision.label, isRevisit });

  if (isSpeculativeMode()) requestPageTransitionNarration({ label: decision.label, isRevisit });
}

async function requestPageTransitionNarration(decision) {
  const buffer = await captureFrameJpeg();
  if (!buffer) return;
  const ts = Date.now();
  showNotice(decision.isRevisit
    ? `이전 슬라이드 ${decision.label}로 복귀 — 고지 생성 중…`
    : `슬라이드 ${decision.label} 전환 — 화면 고지 생성 중…`);

  saveSlideFrameWithMark({ slideLabel: decision.label, frameKind: 'base', buffer }).catch(() => {});

  const wordBudget = buildWordBudget({
    narrationType: NARRATION_TYPE_MAP.pageTransition, subKind: PAGE_TRANSITION_KIND_MAP.slide,
  });
  if (wordBudget.isDroppable) {
    console.log(`[slide] ${decision.label} 어절 예산 부족 → 고지 스킵`);
    markDebug({
      stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.pageTransition,
      reason: '어절 예산이 유형 하한 미달 → 드롭',
      detail: `슬라이드 ${decision.label} 모드=${getCurrentMode()} 하한=${wordBudget.minWordCount}어절`,
    });
    return;
  }
  const result = await window.seeon.sendPipelineFrame({
    ts, buffer, slideLabel: decision.label, wordBudget, isRevisit: Boolean(decision.isRevisit),
  }).catch(() => null);
}

const SPEAKER_POLL_MS = 2500;
const SPEAKER_VOICE_IDLE_MS = 2000;
let speakerPollTimer = null;
let isSpeakerRequestInFlight = false;

function getParticipantRegionPx() {
  const liveVideo = captureSource.liveVideo;
  if (!liveVideo || !liveVideo.videoWidth) return null;
  const vw = liveVideo.videoWidth; const vh = liveVideo.videoHeight;
  const rect = roiStore.getParticipantRectNorm();
  return rect ? normRectToPx(rect, vw, vh) : { x: 0, y: 0, w: vw, h: vh };
}

function resolveDomSpeakerForPoll() {
  const verdict = roiStore.getSpeakerVerdict();
  if (verdict.kind === SPEAKER_VERDICT_MAP.unique) {
    return { isDomResolved: true, isSkipped: false, speaker: verdict.speaker, kind: verdict.kind };
  }
  const isSkipped = verdict.kind === SPEAKER_VERDICT_MAP.multiple
    || verdict.kind === SPEAKER_VERDICT_MAP.selfOnly
    || verdict.kind === SPEAKER_VERDICT_MAP.stale;
  return { isDomResolved: false, isSkipped, speaker: null, kind: verdict.kind };
}

async function pollSpeakerIdentity() {
  if (!isPipelineEnabled() || isExperimentPaused || !captureSource.isActive) return;
  if (isSpeakerRequestInFlight) return;
  if (performance.now() - lastAudioActiveAt > SPEAKER_VOICE_IDLE_MS) return;
  const wordBudget = buildWordBudget({ narrationType: NARRATION_TYPE_MAP.speakerIdentity });
  if (wordBudget.isDroppable) {
    markDebug({
      stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.speakerIdentity,
      reason: '어절 예산이 유형 하한 미달 → 드롭',
      detail: `모드=${getCurrentMode()} 하한=${wordBudget.minWordCount}어절`,
    });
    return;
  }
  const domVerdict = resolveDomSpeakerForPoll();
  if (domVerdict.isSkipped) {
    markDebug({
      stage: DEBUG_STAGE_MAP.speaker, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.speakerIdentity,
      reason: `DOM 판정으로 고지하지 않음 (${domVerdict.kind})`,
      detail: 'multiple=동시 발화 · self_only=본인 발화 · stale=좌표 낡음',
    });
    return;
  }
  const region = domVerdict.isDomResolved ? null : getParticipantRegionPx();
  if (!domVerdict.isDomResolved && !region) return;
  let result = null;
  try {
    isSpeakerRequestInFlight = true;
    if (domVerdict.isDomResolved) {
      result = await window.seeon.sendPipelineSpeaker({
        ts: Date.now(), source: SPEAKER_SOURCE_MAP.dom, wordBudget,
        speakerName: domVerdict.speaker.name,
        position: domVerdict.speaker.position,
        participantId: domVerdict.speaker.participantId || '',
      });
    } else {
      const buffer = await captureRegionJpeg(region);
      if (!buffer) return;
      result = await window.seeon.sendPipelineSpeaker({
        ts: Date.now(), source: SPEAKER_SOURCE_MAP.vlm, buffer, wordBudget,
      });
    }
  } catch (error) {
    console.warn(`[speaker] 발화자 판정 요청 실패(무시): ${error.message}`);
  } finally {
    isSpeakerRequestInFlight = false;
  }
  if (result?.speakerName) {
    lastResolvedSpeakerName = result.speakerName;
    lastResolvedSpeakerAt = performance.now();
  }
  if (result?.isAnnounced) {
    return;
  }
}

function getSpeakerHint() {
  const domName = roiStore.getCurrentSpeakerName();
  if (domName) return domName;
  const isFresh = performance.now() - lastResolvedSpeakerAt <= SPEAKER_HINT_TTL_MS;
  return lastResolvedSpeakerName && isFresh ? lastResolvedSpeakerName : null;
}

const asrSegmenter = new AsrSegmenter({
  onSegment: ({ startTs, endTs, buffer }) => {
    if (!isPipelineEnabled()) return;

    window.seeon.sendPipelineAudio({
      startTs, endTs, buffer, speakerHint: getSpeakerHint(),
    }).catch(() => {});
  },
  onError: (error) => console.warn('[pipeline] ASR 세그먼트 오류', error),
  getVoiceLevel: () => audioMeter.getLevel(),
});

const boundaryDetector = new UtteranceBoundaryDetector({ onBoundary: () => {} });
let lastAudioActiveAt = 0;
const AUDIO_SPEAK_THRESHOLD = 0.02;
const NARRATION_ECHO_TAIL_MS = 500;
let narrationEchoUntil = 0;
const SPEAKER_HINT_TTL_MS = 8000;
let lastResolvedSpeakerName = '';
let lastResolvedSpeakerAt = 0;

const candidateScheduler = new DeixisCandidateScheduler({ onDecide: runDeixisDecision });
const deixisDetector = new DeixisDetector({
  onDeixis: ({ text, trigger }) => {
    const { region, pointingOrderHint } = getPointingSequence();
    console.log(`[deixis] 🗣 발화 지시 "${trigger}" → look-ahead 대기`);

    candidateScheduler.submit({
      source: CANDIDATE_SOURCE_MAP.speech, utterance: text, trigger, region, pointingOrderHint,
      captureTs: performance.now(), videoTimeMs: captureSource.videoTimeMs,
    });
  },
});

function submitPointingMotionCandidate() {
  const now = performance.now();
  const motion = pointingLocator.locate({ nowTs: now });
  if (!motion.hasRegion) return;
  if (now - lastPointingMotionAt < POINTING_MOTION_DEBOUNCE_MS) return;
  lastPointingMotionAt = now;
  const { region, pointingOrderHint } = getPointingSequence();
  saveAnnotationSnapshot();
  console.log(`[deixis] ✍ 포인팅 모션 감지 changedRatio=${(motion.changedRatio ?? 0).toFixed(3)} → 후보`);
  candidateScheduler.submit({
    source: CANDIDATE_SOURCE_MAP.pointing, trigger: '필기/포인터',
    region: region || motion.rect, pointingOrderHint,
    captureTs: now, videoTimeMs: captureSource.videoTimeMs,
  });
}

async function saveSlideFrameWithMark({ slideLabel, frameKind, buffer }) {
  const ts = Date.now();
  const filePath = await window.seeon
    .saveSlideFrame({ slideLabel, kind: frameKind, buffer, sessionId: currentSessionId })
    .catch(() => null);
  if (!filePath) return;
  window.seeon.markSlideFrame({ ts, slideLabel, frameKind, filePath });
}

const ANNOTATION_SNAPSHOT_MIN_INTERVAL_MS = 2000;
let lastAnnotationSnapshotAt = -Infinity;

async function saveAnnotationSnapshot() {
  const annotation = slideRegistry.handleAnnotation();
  if (!annotation) return;
  const now = performance.now();
  if (now - lastAnnotationSnapshotAt < ANNOTATION_SNAPSHOT_MIN_INTERVAL_MS) return;
  lastAnnotationSnapshotAt = now;
  const buffer = await captureFrameJpeg();
  if (!buffer) return;
  saveSlideFrameWithMark({ slideLabel: annotation.label, frameKind: 'annotation', buffer }).catch(() => {});
}

function waitFor({ ms }) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function describeBeforeWindow({ mode, anchorTs }) {
  const { beforeMs } = getModePolicy({ mode }) || {};
  if (Number.isFinite(anchorTs)) {
    const sinceSec = Math.round((performance.now() - anchorTs) / 1000);
    const capText = Number.isFinite(beforeMs) ? ` (상한 ${Math.round(beforeMs / 1000)}초)` : ' (상한 없음)';
    return `화면 전환 후 ${sinceSec}초${capText}`;
  }
  return `최근 ${Math.round((beforeMs ?? 60000) / 1000)}초`;
}

const SCREEN_DEPENDENCY_LABEL_MAP = {
  [SCREEN_DEPENDENCY_REASON_MAP.speechTrigger]: '발화 지시가 트리거',
  [SCREEN_DEPENDENCY_REASON_MAP.deicticReference]: '인접 발화가 지시 표현으로만 가리킴 — 화면을 봐야 안다',
  [SCREEN_DEPENDENCY_REASON_MAP.noAdjacentSpeech]: '인접 발화 없음 — 설명할 내용이 없다',
  [SCREEN_DEPENDENCY_REASON_MAP.spokenReference]: '발화가 대상을 특정함 — 말로 충분하다',
};

async function runDeixisDecision({ source, utterance, triggerList, region, pointingOrderHint,
  captureTs, videoTimeMs }) {
  const label = triggerList.join(', ') || '필기/포인터';
  const mode = getCurrentMode();
  const { beforeMs, afterMs } = getModePolicy({ mode }) || {};

  const buffer = await captureFrameJpeg(region);
  if (!buffer) return;

  const holdMs = computeContextHoldMs({ mode });
  if (holdMs > 0) {
    const sessionSeq = experimentSeq;
    await waitFor({ ms: holdMs });

    if (!captureSource.isActive || sessionSeq !== experimentSeq) return;
  }

  const anchorTs = resolveBeforeAnchorTs({ mode, screenTransitionTs: lastScreenTransitionAt });
  const { before, after, tokenCount, droppedCount } = transcriptWindow.getContext({
    triggerTs: captureTs, beforeMs: beforeMs ?? 60000, afterMs: afterMs ?? 2000, anchorTs,
  });
  if (droppedCount > 0) {
    markDebug({
      stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.info,
      reason: '앞 맥락이 토큰 예산으로 절삭됨',
      detail: `버린 발화 ${droppedCount}건 · 남은 맥락 ${tokenCount}토큰 (예산 ${CONTEXT_TOKEN_BUDGET})`,
    });
  }
  const screenVerdict = judgeScreenDependency({ source, utterance, before, after });
  if (!screenVerdict.isScreenDependent) {
    console.log(`[deixis] 화면 의존성 없음 → 스킵 label="${label}" (${screenVerdict.reason})`);
    markDebug({
      stage: DEBUG_STAGE_MAP.screenDependency, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.deixis,
      reason: SCREEN_DEPENDENCY_LABEL_MAP[screenVerdict.reason] || screenVerdict.reason,
      detail: `트리거="${label}" 발화="${utterance || '(없음)'}" 뒤="${after || '(없음)'}" 앞="${before || '(없음)'}"`,
    });
    return;
  }
  markDebug({
    stage: DEBUG_STAGE_MAP.screenDependency, verdict: DEBUG_VERDICT_MAP.pass,
    narrationType: NARRATION_TYPE_MAP.deixis,
    reason: SCREEN_DEPENDENCY_LABEL_MAP[screenVerdict.reason] || screenVerdict.reason,
    detail: `근거="${screenVerdict.trigger || label}" 앞맥락 ${describeBeforeWindow({ mode, anchorTs })}`
      + ` · 뒤맥락(${Math.round((afterMs ?? 2000) / 1000)}초 창)="${after || '(없음)'}"`,
  });

  const recentTranscript = [before, after].filter(Boolean).join(' ');
  const ts = Date.now();
  console.log(`[deixis] 결정 발행 label="${label}" region=${region ? 'Y' : 'N'} utterance="${utterance || '(없음)'}"`);

  const wordBudgetMap = buildWordBudgetMap();
  if (Object.values(wordBudgetMap).every((budget) => budget.isDroppable)) {
    console.log(`[deixis] 어절 예산 부족 → 요청 스킵 label="${label}"`);
    markDebug({
      stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.skip,
      reason: '모든 후보 유형이 어절 예산 하한 미달 → 드롭',
      detail: `모드=${getCurrentMode()} 트리거="${label}" 발화="${utterance || '(없음)'}"`,
    });
    return;
  }
  markDebug({
    stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.pass,
    reason: '지시 후보 발행',
    detail: `트리거="${label}" 발화="${utterance || '(없음)'}" 영역=${region ? '포인팅' : '프레임 전체'} 슬라이드=${slideRegistry.currentLabel() || '-'}`,
  });
  const result = await window.seeon.sendPipelineDeixis({
    ts, buffer, utterance, recentTranscript, beforeTranscript: before, afterTranscript: after,
    hasPointingRegion: Boolean(region), pointingOrderHint, slideLabel: slideRegistry.currentLabel(),
    wordBudgetMap,
  }).catch(() => null);

  const isNarrated = Boolean(result?.isOk && result.isGrounded);
  deixisFrameSeq += 1;
  const secondsLabel = (videoTimeMs / 1000).toFixed(2).padStart(8, '0');
  const frameName = `${secondsLabel}s-${String(deixisFrameSeq).padStart(3, '0')}.jpg`;
  window.seeon.saveDeixisFrame({ name: frameName, buffer, isGrounded: isNarrated }).catch(() => {});
  if (isNarrated) {
  } else if (result?.isOk) {
  } else {
  }
}

function collectGapCandidateList({ segmentList, chunkStartTs, chunkEndTs }) {
  const chunkDurationMs = Math.max(0, chunkEndTs - chunkStartTs);
  const boundaryList = buildSegmentBoundaryList({ segmentList, chunkDurationMs });
  const nowVideoTimeMs = captureSource.videoTimeMs;
  const nowTs = Date.now();
  for (const boundary of boundaryList) {
    const boundaryTs = chunkStartTs + boundary.offsetMs;
    gapCandidateStore.add({
      videoTimeMs: nowVideoTimeMs - (nowTs - boundaryTs),
      kind: boundary.kind, silenceMs: boundary.silenceMs, text: boundary.text,
    });
  }
  return boundaryList.length;
}

function handleAsrTranscript({ text, ts, endTs, segmentList = [] }) {
  const trimmed = (text || '').trim();
  if (trimmed) {
    markDebug({
      stage: DEBUG_STAGE_MAP.asr, verdict: DEBUG_VERDICT_MAP.pass,
      reason: '전사 도착', detail: `"${trimmed}"`,
    });

    transcriptWindow.push({ text: trimmed, ts: performance.now() });
    deixisDetector.handleTranscript({ text: trimmed, captureTs: endTs });
  }

  const candidateCount = collectGapCandidateList({
    segmentList, chunkStartTs: ts, chunkEndTs: endTs,
  });

  const ending = classifyUtteranceEnding(text);
  if (!ending) return;

  const silenceMsAfter = lastAudioActiveAt ? Math.max(0, Math.round(performance.now() - lastAudioActiveAt)) : 0;
  const boundary = boundaryDetector.handleTranscript({ text, captureEndTs: endTs, silenceMsAfter });
  window.seeon.appendBoundaryLog({
    captureTs: endTs, text, ending, silenceMsAfter,
    emitted: Boolean(boundary), kind: boundary?.kind || null,
    segmentCount: segmentList.length, candidateCount,
  });
}

const CAPTION_SOURCE_TRANSITION = 'page-transition';

function handleCaption({ text, source }) {
  appendLogCard({ source, text });
  if (source === CAPTION_SOURCE_TRANSITION) lastScreenNarration = text;
  return captureSource.videoTimeMs;
}

const COMMAND_DEDUPE_MS = 400;
const lastCommandAtMap = new Map();

function isDuplicateCommand({ command }) {
  const now = performance.now();
  const lastAt = lastCommandAtMap.get(command);
  if (lastAt !== undefined && now - lastAt < COMMAND_DEDUPE_MS) return true;
  lastCommandAtMap.set(command, now);
  return false;
}

const USER_COMMAND_LABEL_MAP = {
  [USER_COMMAND_MAP.screenMaterial]: '지금 화면에 무슨 자료가 있어?',
  [USER_COMMAND_MAP.pageSummary]: '지금 화면을 요약해줘',
  [USER_COMMAND_MAP.graphAxis]: '그래프 축이 뭐야?',
};

// 프리셋 커맨드(command)와 자유 자연어 질문(questionText)을 함께 처리한다.
// 자유 질문이면 최근 발화(recentTranscript)를 근거로 붙인다 — 심화 질의응답 경로.
async function askQuestion({ command = null, questionText = null }) {
  if (command && isDuplicateCommand({ command })) return;
  if (!captureSource.isActive) {
    showNotice('회의 캡처를 시작해야 질문할 수 있습니다');
    return;
  }
  appendAskBubble({ text: questionText || USER_COMMAND_LABEL_MAP[command] || command });
  const buffer = await captureFrameJpeg();
  if (!buffer) return;
  const ts = Date.now();
  const wordBudget = buildWordBudget({ narrationType: NARRATION_TYPE_MAP.userCommand });
  const recentTranscript = questionText
    ? transcriptWindow.getBefore({ nowTs: performance.now(), windowMs: 60000 })
    : '';
  const result = await window.seeon.sendPipelineCommand({
    ts, buffer, command, questionText, recentTranscript, wordBudget,
  }).catch(() => null);
  if (!result?.isGrounded && questionText) {
    showNotice('화면에서 답을 찾지 못했어요');
  }
}

function handleUserCommand({ command }) {
  return askQuestion({ command });
}
window.seeon.onUserCommand(handleUserCommand);

function toggleSummaryEnabled() {
  isSummaryEnabled = !isSummaryEnabled;
  const stateText = isSummaryEnabled ? '켜짐' : '꺼짐';
  showNotice(`회의 요약 ${stateText}`);
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '회의 요약 토글', detail: `회의 요약 ${stateText}`,
  });
}
window.seeon.onSummaryToggle(toggleSummaryEnabled);

document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;

  if (event.key === SUMMARY_TOGGLE_KEY) {
    event.preventDefault();
    toggleSummaryEnabled();
    return;
  }
  const command = USER_COMMAND_KEY_MAP[event.key];
  if (!command) return;
  event.preventDefault();
  handleUserCommand({ command });
});

const GAP_SAFETY_MS = 2000;

function toNarrationType({ source }) {
  return source === CAPTION_SOURCE_TRANSITION ? NARRATION_TYPE_MAP.pageTransition : source;
}

async function resolveInsertionTimeMs({ payload, captionCaptureMs }) {
  if (!delayBuffer || !Number.isFinite(captionCaptureMs)) return captionCaptureMs;
  const narrationType = toNarrationType({ source: payload.source });
  const gapList = gapCandidateStore.getCandidateList({
    triggerVideoTimeMs: captionCaptureMs,
    fromVideoTimeMs: delayBuffer.getDelayedTimeMs() + GAP_SAFETY_MS,
    toVideoTimeMs: captureSource.videoTimeMs,
  });
  if (!gapList.length) {
    markDebug({
      stage: DEBUG_STAGE_MAP.gap, verdict: DEBUG_VERDICT_MAP.skip, narrationType,
      reason: '후보 틈 없음 → 트리거 지점 삽입',
      detail: `"${payload.text}" · 재생 ${Math.round(delayBuffer.getDelayedTimeMs())}ms`
        + ` · 트리거 ${Math.round(captionCaptureMs)}ms`,
    });
    return captionCaptureMs;
  }
  const rationale = [
    payload.rationale?.utterance ? `발화="${payload.rationale.utterance}"` : '',
    payload.rationale?.summary || '',
  ].filter(Boolean).join(' · ');
  const result = await window.seeon.inferInsertionGap({
    mode: getCurrentMode(),
    ts: payload.ts, narrationText: payload.text, narrationType,
    subKind: payload.rationale?.subKind || null,
    rationale,
    screenSummary: [payload.slideLabel ? `슬라이드 ${payload.slideLabel}` : '', lastScreenNarration]
      .filter(Boolean).join(' — '),
    gapList,
  }).catch(() => null);
  const chosen = Number.isInteger(result?.gapIndex) ? gapList[result.gapIndex] : null;
  if (!chosen) return captionCaptureMs;
  console.log(`[gap] 삽입 위치 ${Math.round(captionCaptureMs)}ms → ${Math.round(chosen.videoTimeMs)}ms`
    + ` (${chosen.offsetMs >= 0 ? '+' : ''}${(chosen.offsetMs / 1000).toFixed(1)}초, ${result.source}) "${result.reason}"`);
  return chosen.videoTimeMs;
}

async function emitCaption(payload) {
  const captionCaptureMs = handleCaption(payload);
  if (!payload.wavData) return;
  const wavArrayBuffer = payload.wavData.buffer.slice(
    payload.wavData.byteOffset, payload.wavData.byteOffset + payload.wavData.byteLength);
  const insertVideoTimeMs = await resolveInsertionTimeMs({ payload, captionCaptureMs });
  scheduleNarration({ wavArrayBuffer, captionCaptureMs: insertVideoTimeMs });
}

function emitCaptionSafely(payload) {
  emitCaption(payload).catch((error) => console.warn('[caption] 발행 실패(무시):', error.message));
}

function applyCaption(payload) {
  const isTransition = payload.source === CAPTION_SOURCE_TRANSITION;
  if (!isTransition || !payload.slideLabel) { emitCaptionSafely(payload); return; }
  const state = slideDwellGate.getState({ label: payload.slideLabel });
  if (state === DWELL_STATE_MAP.waiting) {
    console.log(`[slide] 고지 보류 — 슬라이드 ${payload.slideLabel} 체류 판정 대기 중`);
  }
  slideDwellGate.whenResolved({
    label: payload.slideLabel,
    callback: (isSatisfied) => {
      if (isSatisfied) { emitCaptionSafely(payload); return; }
      markDebug({
        stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.skip,
        narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: '체류 미달 — 재생 전 취소(선판정 후취소)',
        detail: `슬라이드 ${payload.slideLabel} "${payload.text}"`,
      });
    },
  });
}

window.seeon.onPipelineEvent((payload) => {
  if (payload.type === 'asr') { handleAsrTranscript(payload); return; }
  if (payload.type === 'debug') return;
  if (payload.type !== 'caption') return;
  applyCaption(payload);
});

window.seeon.onSummaryProgress(({ message }) => {
  showNotice(message);
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '회의 요약 진행', detail: message,
  });
});

function scheduleNarration({ wavArrayBuffer, captionCaptureMs }) {
  if (delayBuffer) {
    const excessMs = delayBuffer.getExcessMs();
    if (isCaptionDroppable({ excessMs, dropThresholdMs: EXCESS_DROP_MS })) {
      console.log(`[delay] 캡션 드롭 — 누적 지연 ${Math.round(excessMs)}ms (상한 ${EXCESS_DROP_MS}ms)`);
      markDebug({
        stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.skip,
        reason: '누적 지연 상한 초과 — 캡션 드롭',
        detail: `초과 ${Math.round(excessMs)}ms / 상한 ${EXCESS_DROP_MS}ms`
          + ` · 모드=${getCurrentMode()} · 회수되면 다시 받는다`,
      });
      return;
    }
  }
  if (!narrationScheduler || !Number.isFinite(captionCaptureMs)) {
    getNarrationPlayer().queueCaption(wavArrayBuffer);
    return;
  }
  const waitMs = Math.max(0, captionCaptureMs - delayBuffer.getDelayedTimeMs());
  if (waitMs > 0) {
    console.log(`[delay] 캡션 삽입 대기 ~${Math.round(waitMs)}ms (영상 ${Math.round(captionCaptureMs)}ms 지점)`);
  }
  narrationScheduler.schedule({ wavArrayBuffer, captionCaptureMs });
}

function isNarrationEchoWindow() {
  const now = performance.now();
  if (getNarrationPlayer()?.getSicState?.().isInserting) {
    narrationEchoUntil = now + NARRATION_ECHO_TAIL_MS;
    return true;
  }
  return now < narrationEchoUntil;
}

setInterval(() => {
  if (!captureSource.isActive) return;
  if (isNarrationEchoWindow()) return;
  if (audioMeter.getLevel() > AUDIO_SPEAK_THRESHOLD) lastAudioActiveAt = performance.now();
}, 100);

function setToggleUi(isRunning) {
  $('toggleBtn').textContent = isRunning ? '회의 캡처 정지' : '회의 캡처 시작';
  $('toggleBtn').classList.toggle('on', isRunning);
  $('live').classList.toggle('on', isRunning);
  $('liveState').textContent = isRunning ? 'LIVE' : '대기 중';
}

function setPauseUi(isPaused) {
  $('pauseBtn').textContent = isPaused ? '재개' : '일시정지';
  $('pauseBtn').classList.toggle('on', isPaused);
}

function pauseExperiment() {
  if (!captureSource.isActive || isExperimentPaused) return;
  isExperimentPaused = true;
  captureSource.liveVideo?.pause();
  delayBuffer?.hold();
  asrSegmenter.stop();
  if (pointingSampleTimer) { clearInterval(pointingSampleTimer); pointingSampleTimer = null; }
  if (speakerPollTimer) { clearInterval(speakerPollTimer); speakerPollTimer = null; }
  stopNarrationPlayer();
  setPauseUi(true);
  $('stCapture').textContent = '일시정지';
}

function resumeExperiment() {
  if (!captureSource.isActive || !isExperimentPaused) return;
  isExperimentPaused = false;
  const { stream, liveVideo } = captureSource;
  startNarrationPlayer({ stream });
  delayBuffer?.release();
  pointingLocator.reset();

  lastPointingMotionAt = -Infinity;
  pointingSampleTimer = setInterval(samplePointingFrame, POINTING_SAMPLE_MS);
  speakerPollTimer = setInterval(pollSpeakerIdentity, SPEAKER_POLL_MS);
  asrSegmenter.start(stream);
  liveVideo?.play().catch(() => {});
  setPauseUi(false);
  $('stCapture').textContent = '재생 중';
}

async function attemptStartExperiment() {
  if (!isCaptureStartable() || captureSource.isActive) return;
  $('toggleBtn').disabled = true;
  try {
    showNotice('회의 캡처를 시작했습니다 — 화면 해설이 곧 표시됩니다.');

    const sessionResult = await window.seeon.startPipelineSession({ mode: getCurrentMode() }).catch(() => null);
    currentSessionId = sessionResult?.sessionId || null;

    const contextPolicy = getModePolicy({ mode: getCurrentMode() });
    const lookaheadMs = computeLookaheadMs({ mode: getCurrentMode() });
    const holdMs = computeContextHoldMs({ mode: getCurrentMode() });
    candidateScheduler.setLookaheadMs({ lookaheadMs });

    asrSegmenter.setSegmentMs({ segmentMs: contextPolicy?.asrSegmentMs });

    lastScreenTransitionAt = performance.now();
    experimentSeq += 1;
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '캡처 시작',
      detail: `모드=${getCurrentMode()} · 시작 시점 = 회의 시작 시점(0초)`
        + ` · 앞 맥락 ${describeBeforeWindow({ mode: getCurrentMode(), anchorTs: lastScreenTransitionAt })}`
        + ` · 뒤 맥락 ${Math.round((contextPolicy?.afterMs ?? 0) / 1000)}초`
        + ` (ASR 청크 ${contextPolicy?.asrSegmentMs}ms + look-ahead ${lookaheadMs}ms + 보류 ${holdMs}ms)`,
    });

    const { audioTrack } = await captureSource.start();
    const { stream, liveVideo } = captureSource;
    const settings = stream.getVideoTracks()[0].getSettings();
    $('stCapture').textContent = audioTrack ? '재생 중 (video+audio)' : '재생 중 (video만! audio track 없음)';
    $('stRes').textContent = `${settings.width ?? liveVideo.videoWidth}×${settings.height ?? liveVideo.videoHeight}`;

    startDelayBufferIfNeeded();

    audioMeter.start(stream);
    startNarrationPlayer({ stream });
    boundaryDetector.reset();
    deixisDetector.reset();
    candidateScheduler.reset();
    pointingLocator.reset();
    lastPointingMotionAt = -Infinity;

    roiStore.reset();
    lastScreenGeneration = 0;
    roiChangeSuppressUntil = 0;
    histogramGate.reset();
    slideRegistry.reset();
    slideDwellGate.reset();
    isConfirmingSlide = false;
    hasWarnedLocalEmbedding = false;
    transcriptWindow.reset();
    gapCandidateStore.reset();
    lastScreenNarration = '';
    deixisFrameSeq = 0;
    isSpeakerRequestInFlight = false;
    pointingSampleTimer = setInterval(samplePointingFrame, POINTING_SAMPLE_MS);
    speakerPollTimer = setInterval(pollSpeakerIdentity, SPEAKER_POLL_MS);
    asrSegmenter.start(stream);
    isExperimentPaused = false;
    setPauseUi(false);
    $('pauseBtn').disabled = false;
    setToggleUi(true);
    renderModeButtons();

    if (!audioTrack) {
      showModal({
        title: '오디오 트랙 없음',
        message: '영상은 재생되지만 오디오 트랙을 받지 못했습니다.\n오디오가 없는 파일이면 ASR·캡션이 동작하지 않습니다.',
        buttons: [{ label: '닫기', secondary: true }],
      });
    }
  } catch (err) {
    stopExperiment();
    $('stCapture').textContent = `실패: ${err.message}`;
    showModal({
      title: '회의 캡처 실패',
      message: `왼쪽 Meet 창을 캡처하지 못했습니다.\n(${err.name}: ${err.message})\n회의에 참여한 상태인지 확인한 뒤 다시 시도해 주세요.`,
      buttons: [{ label: '닫기', secondary: true }],
    });
  } finally {
    $('toggleBtn').disabled = false;
  }
}

function runTeardownStep({ label, run }) {
  try { run(); } catch (error) { console.warn(`[stop] ${label} 정리 실패(무시): ${error.message}`); }
}

function stopExperiment() {
  let asrFinalFlushPromise = Promise.resolve();
  const stepList = [
    ['오디오 미터', () => audioMeter.stop()],
    ['내레이션 출력기', () => stopNarrationPlayer()],
    ['ASR 세그먼터', () => { asrFinalFlushPromise = asrSegmenter.stop() || Promise.resolve(); }],
    ['경계 탐지기', () => boundaryDetector.reset()],
    ['지시 탐지기', () => deixisDetector.reset()],
    ['후보 스케줄러', () => candidateScheduler.reset()],
    ['인접 발화 창', () => transcriptWindow.reset()],
    ['삽입 후보 틈', () => gapCandidateStore.reset()],
    ['프레임 샘플러', () => {
      if (pointingSampleTimer) { clearInterval(pointingSampleTimer); pointingSampleTimer = null; }
    }],
    ['발화자 폴링', () => {
      if (speakerPollTimer) { clearInterval(speakerPollTimer); speakerPollTimer = null; }
    }],
    ['포인팅 로컬라이저', () => pointingLocator.reset()],
    ['슬라이드 히스토그램 게이트', () => histogramGate.reset()],
    ['슬라이드 레지스트리', () => slideRegistry.reset()],
    ['전환 체류 게이트', () => slideDwellGate.reset()],
    ['ROI 스토어', () => roiStore.reset()],
    ['발화자 힌트', () => { lastResolvedSpeakerName = ''; lastResolvedSpeakerAt = 0; }],
    ['지연 버퍼', () => stopDelayBuffer()],
    ['캡처 세션', () => captureSource.stop()],
    ['PiP', () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); }],
  ];
  for (const [label, run] of stepList) runTeardownStep({ label, run });
  lastPointingMotionAt = -Infinity;
  lastAnnotationSnapshotAt = -Infinity;
  lastScreenGeneration = 0;
  roiChangeSuppressUntil = 0;
  isConfirmingSlide = false;
  isSpeakerRequestInFlight = false;
  experimentSeq += 1;
  isExperimentPaused = false;
  setPauseUi(false);
  $('pauseBtn').disabled = true;
  $('stCapture').textContent = 'off';
  $('stRes').textContent = $('stDelay').textContent = '–';
  $('stBuffer').textContent = '–';
  setToggleUi(false);
  renderModeButtons();
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '회의 캡처 정지',
  });
  finalizeSession({ asrFinalFlushPromise });
}

function finalizeSession({ asrFinalFlushPromise }) {
  if (!currentSessionId) return;
  currentSessionId = null;
  asrFinalFlushPromise
    .catch(() => {})
    .then(() => window.seeon.endPipelineSession())
    .then((result) => {
      if (!result?.isOk) return null;
      markDebug({
        stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
        reason: '세션 스냅샷 확정',
        detail: `${result.sessionId} · 발화 ${result.asrCount}건 · 슬라이드 ${result.slideMarkCount}건`,
      });
      return requestMeetingSummary();
    })
    .catch(() => {});
}

async function requestMeetingSummary() {
  if (!isSummaryEnabled) {
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.skip,
      reason: '회의 요약 꺼짐', detail: '사용자가 요약 기능을 껐습니다',
    });
    return;
  }
  const result = await window.seeon.generateSummary().catch((error) => ({
    isOk: false, message: error.message,
  }));
  if (!result?.isOk) {
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.fail,
      reason: '회의 요약 실패', detail: result?.message || '알 수 없는 오류',
    });
    const failureMessage = result?.message || '알 수 없는 오류';
    showNotice(`회의 요약 생성 실패 — ${failureMessage}`);

    showModal({
      title: '회의 요약 실패',
      message: `요약본을 만들지 못했습니다.\n${failureMessage}`,
      buttons: [{ label: '닫기', secondary: true }],
    });
    return;
  }
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '회의 요약 완료',
    detail: `${result.textFilePath}${result.audioFilePath ? ` · ${result.audioFilePath}` : ' (음성 없음)'}`
      + `${result.isTruncated ? ' (길이 제한으로 잘림)' : ''}`,
  });
  showNotice(result.audioFilePath
    ? '회의 요약본과 음성 파일이 저장되었습니다.'
    : '회의 요약본이 저장되었습니다. 음성 파일은 만들지 못했습니다.');

  console.log(`[summary] 저장 완료 — ${result.textFilePath}`
    + `${result.audioFilePath ? ` · ${result.audioFilePath}` : ''}`);
}

function handleCaptureEnded() {
  stopExperiment();
  showNotice('회의 캡처가 종료되었습니다 — 회의를 나갔거나 Meet 창이 닫혔습니다.');
}

function isCaptureStartable() {
  return MEET_MEETING_URL_PATTERN.test(latestMeetUrl) && latestMeetTileCount > 0;
}

function syncToggleAvailability() {
  if (captureSource.isActive) return;
  $('toggleBtn').disabled = !isCaptureStartable();
  $('meetHint').textContent = isCaptureStartable()
    ? `회의 참여 확인 (타일 ${latestMeetTileCount}개)`
    : '왼쪽 Meet 창에서 회의에 참여하면 시작할 수 있습니다';
}

syncToggleAvailability();

$('toggleBtn').addEventListener('click', () => {
  if (captureSource.isActive) stopExperiment();
  else attemptStartExperiment();
});

$('pauseBtn').addEventListener('click', () => {
  if (isExperimentPaused) resumeExperiment();
  else pauseExperiment();
});

function submitTypedQuestion() {
  const input = $('cmdInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  askQuestion({ questionText: text });
}

$('cmdInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submitTypedQuestion(); }
});
$('cmdSend').addEventListener('click', submitTypedQuestion);

// 마이크 — 데모 스텁: 실제 녹음/음성 인식은 없다. 녹음 중 UI(빨간 표시 + 경과 타이머)만 보여준다.
let micStubTimer = null;
let micStubStartedAt = 0;
function stopMicStub() {
  if (micStubTimer) { clearInterval(micStubTimer); micStubTimer = null; }
  $('cmdMic').classList.remove('recording');
}
$('cmdMic').addEventListener('click', () => {
  const mic = $('cmdMic');
  if (micStubTimer) {
    stopMicStub();
    showNotice('음성 인식은 준비 중입니다 — 타이핑하거나 빠른 명령을 이용해 주세요.');
    return;
  }
  mic.classList.add('recording');
  micStubStartedAt = performance.now();
  const tick = () => {
    const sec = Math.floor((performance.now() - micStubStartedAt) / 1000);
    showNotice(`녹음 중… ${String(Math.floor(sec / 60)).padStart(1, '0')}:${String(sec % 60).padStart(2, '0')} (다시 눌러 정지)`);
  };
  tick();
  micStubTimer = setInterval(tick, 1000);
});
for (const chip of $('cmdChips').querySelectorAll('.chip')) {
  chip.addEventListener('click', () => handleUserCommand({ command: chip.dataset.command }));
}

function syncSettingsUi() {
  const summary = $('setSummary');
  summary.classList.toggle('on', isSummaryEnabled);
  summary.textContent = isSummaryEnabled ? '켜짐' : '꺼짐';
}

$('settingsBtn').addEventListener('click', () => {
  const panel = $('settingsPanel');
  panel.hidden = !panel.hidden;
  $('settingsBtn').classList.toggle('on', !panel.hidden);
  if (!panel.hidden) syncSettingsUi();
});
$('setSummary').addEventListener('click', () => {
  toggleSummaryEnabled();
  syncSettingsUi();
});
syncSettingsUi();
