import {
  CROP_JPEG_QUALITY, NARRATION_TYPE_MAP, NARRATION_CLASS_MAP,
  PAGE_TRANSITION_KIND_MAP, USER_COMMAND_MAP, SUMMARY_TOGGLE_KEY, SUMMARY_STAGE_MAP,
  MEET_MEETING_URL_PATTERN, SPEAKER_SOURCE_MAP, DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, SCREEN_CHANGE_KIND_MAP,
} from '../core/constants.js';
import {
  MODE_MAP, DWELL_MS, IS_DELAY_BUFFER_ENABLED,
  computeWordBudget, computeSilenceWordBudget, canSwitchMode, getModePolicy, getCatchupRateRange,
  computeLookaheadMs, computeSentenceWaitMs, computeContextHoldMs, resolveBeforeAnchorTs,
  computeAnswerWordBudget,
} from '../core/mode/mode-policy.js';
import { CONTEXT_TOKEN_BUDGET } from '../core/mode/context-budget.js';
import {
  createFeatureToggleStore, FEATURE_KEY_MAP, FEATURE_KEY_LIST, FEATURE_LABEL_MAP, FEATURE_SHORTCUT_MAP,
  readFeatureKeyFromCode, listDisabledNarrationClass, isFeatureLockedDuringCapture,
  describeDisabledFeatureBadge, describeDisabledFeatureNotice, readFeatureLabel,
} from '../core/mode/feature-toggle-store.js';
import {
  createQuestionPresetStore, MAX_QUESTION_PRESET_COUNT, readQuestionPresetSlotFromKey, readQuestionPresetText,
} from '../core/mode/question-preset-store.js';
import {
  createCaptionLanguageStore, CAPTION_LANGUAGE_LIST, CAPTION_LANGUAGE_LABEL_MAP, isCaptionLanguageLocked,
  describeNonDefaultCaptionLanguage,
} from '../core/mode/caption-language-store.js';
import {
  createSlideTextBackendStore, SLIDE_TEXT_BACKEND_OPTION_LIST, readSlideTextBackendLabel,
} from '../core/mode/slide-text-backend-store.js';
import { createUiText, applyUiTextToDom } from '../core/i18n/ui-text.js';

import { DelayBuffer, isCaptionDroppable, EXCESS_DROP_MS } from '../core/audio-renderer/delay-buffer.js';
import { StreamDelaySource } from '../core/audio-renderer/stream-delay-source.js';
import { NarrationScheduler } from '../core/audio-renderer/narration-scheduler.js';
import { GapCandidateStore, resolveGapSearchFromMs } from '../core/audio-renderer/gap-candidate-store.js';
import { SilenceSpanTracker } from '../core/audio-renderer/silence-span-tracker.js';
import {
  AsrSegmentTimeline, buildInsertionGapList, resolveInsertionTargetMs, isAudioGapActive,
  GAP_CANDIDATE_SOURCE_MAP, SNAP_REASON_MAP,
} from '../core/audio-renderer/audio-gap-candidates.js';
import {
  isImmediateCaption, isAnchoredCaption, NarrationHoldGate, holdDuringAnswer, MANUAL_ANSWER_HOLD_MAX_MS,
} from '../core/audio-renderer/narration-entry.js';
import { QUEUE_DROP_LABEL_MAP, QUEUE_DROP_REASON_MAP } from '../core/audio-renderer/narration-queue.js';
import { NarrationAudioPrefetcher } from '../core/audio-renderer/narration-audio-prefetcher.js';
import { QuestionRecorder } from '../core/command/question-recorder.js';
import { MeetMicGuard } from '../core/command/meet-mic-guard.js';
import { MicQuestionController, MIC_PHASE_MAP } from '../core/command/mic-question-controller.js';
import { readQuestionBlockedTextKey } from '../core/command/question-gate.js';
import { CaptionNarrator } from '../core/audio-renderer/caption-narrator.js';
import { NarrationMixer } from '../core/audio-renderer/narration-mixer.js';
import { buildMeetReloadNotice } from '../core/ui/meet-reload-notice.js';
import { describeGpuTunnelStatus } from '../core/ui/gpu-tunnel-label.js';
import { buildSlideTransitionNotice } from '../core/ui/slide-transition-notice.js';
import { resolveAdCardTag } from '../core/ui/ad-card-tag.js';
import {
  TransitionOrderGate, LEADER_STATUS_MAP, resolveFollowerInsertMs,
  PendingTransitionTracker, resolveAfterTransitionInsertMs,
} from '../core/audio-renderer/transition-order-gate.js';

import { AudioMeter } from '../core/trigger/audio-meter.js';
import { AsrSegmenter } from '../core/trigger/asr-segmenter.js';
import { SpeakerTimeline } from '../core/trigger/speaker-timeline.js';
import {
  UtteranceBoundaryDetector, classifyUtteranceEnding, buildSegmentBoundaryList,
} from '../core/trigger/utterance-boundary-detector.js';
import { TranscriptWindow } from '../core/trigger/transcript-window.js';
import { DeixisDetector } from '../core/trigger/deixis-detector.js';
import { resolveLastSpeechWallTs } from '../core/trigger/speech-activity.js';
import {
  SilenceTrigger, evaluateSilencePrecondition, SILENCE_TRANSCRIPT_WINDOW_MS, SILENCE_SKIP_LABEL_MAP,
} from '../core/trigger/silence-trigger.js';
import {
  DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP, SUBMIT_RESULT_MAP,
} from '../core/trigger/deixis-candidate-scheduler.js';
import { judgeScreenDependency, SCREEN_DEPENDENCY_REASON_MAP } from '../core/trigger/screen-dependency.js';
import { PointingLocator, describeDirection } from '../core/trigger/pointing-locator.js';
import { createRecentPointingMemory } from '../core/trigger/recent-pointing.js';
import { createPointingMotionTracker } from '../core/trigger/pointing-motion-tracker.js';
import { SlideHistogramGate } from '../core/trigger/slide-histogram-gate.js';
import { createScreenChangeDetector } from '../core/trigger/screen-change-detector.js';
import { convertToGrayscale } from '../core/trigger/ssim.js';
import { createSlideCandidateGate } from '../core/trigger/slide-candidate-gate.js';
import { SlideEmbeddingRegistry } from '../core/trigger/slide-embedding-registry.js';
import { SlideDwellGate, DWELL_STATE_MAP } from '../core/trigger/slide-dwell-gate.js';
import { computeGridEmbedding } from '../core/trigger/frame-embedding.js';
import { showModal } from './modal.js';
import { formatMeetingLabel } from '../core/archive/meeting-label.js';
import { pickArchiveSummaryText, pickArchiveRefreshMeetingId } from '../core/archive/archive-summary-text.js';
import { computeAnchoredPanelPosition } from '../core/ui/anchored-panel-position.js';

import {
  RoiStore, SPEAKER_VERDICT_MAP, ROI_CHANGE_CAUSE_MAP, resolveRoiChangeReset,
} from '../core/roi/roi-store.js';
import { MeetCaptureSession } from '../core/capture/meet-capture-session.js';
import { fitWithinLongEdge } from '../core/capture/frame-scale.js';
import { captureWhenSettled } from '../core/capture/settled-capture.js';
import { captureDeixisFrameSet, toPointingRect } from '../core/capture/deixis-frame-set.js';
import { wallToVideoTimeMs, resolveSpeechEndWallTs, attachCandidateEventVideoTime } from '../core/capture/video-time.js';
import { createLogoTapCounter } from '../core/dev/logo-tap-counter.js';

const $ = (id) => document.getElementById(id);

const captureSource = new MeetCaptureSession();

const roiStore = new RoiStore({ isFullFrameFallback: false, isStabilized: true });
const speakerTimeline = new SpeakerTimeline();

const ROI_CHANGE_SUPPRESS_MS = 1500;
const FRAME_ASPECT_TOLERANCE = 0.02;
let lastScreenGeneration = 0;
let roiChangeSuppressUntil = 0;

let latestMeetUrl = '';
let latestMeetTileCount = 0;

let delayBuffer = null;

let narrationScheduler = null;

const gapCandidateStore = new GapCandidateStore({});
// 틈 위치를 잰 무음에서 고를 때(SEEON_GAP_SOURCE=audio) 쓴다. asr 이면 재기만 하고 쓰지 않는다.
const silenceSpanTracker = new SilenceSpanTracker();
const asrSegmentTimeline = new AsrSegmentTimeline();
let gapSource = GAP_CANDIDATE_SOURCE_MAP.asr;

let lastScreenNarration = '';

const getPlaybackVideo = () => delayBuffer?.delayedVideo || captureSource.liveVideo || null;

function handleNarrationStatus(text) {
  $('stDelay').textContent = text || '–';
}

// 저장소에 접근할 수 없으면 이번 실행 동안만 메모리 상태로 쓴다.
function readLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const featureToggleStore = createFeatureToggleStore({ storage: readLocalStorage() });
const captionLanguageStore = createCaptionLanguageStore({ storage: readLocalStorage() });
// 앱 화면 글자는 캡션 언어를 따른다. t 는 부를 때마다 지금 언어를 읽는다.
const t = createUiText({ getLanguage: () => captionLanguageStore.get() });
document.documentElement.lang = captionLanguageStore.get();
applyUiTextToDom({ root: document, t });
const slideTextBackendStore = createSlideTextBackendStore({ storage: readLocalStorage() });
const questionPresetStore = createQuestionPresetStore({ storage: readLocalStorage() });
const isNarrationEntryEnabled = (entry) => featureToggleStore.isClassOn(entry.narrationClass);

// 해설이 들리기 시작한 순간을 main 에 알린다(개발자 모드 흐름 창의 '재생됨').
// "들은 자리"는 교차 모드면 지연 재생 위치, 동시 모드면 원본 현재 위치다. 둘 다 캡처 영상 시각 축이다.
function reportNarrationPlayStart(info) {
  const report = {
    ...info,
    mode: getCurrentMode(),
    playbackVideoTimeMs: delayBuffer ? delayBuffer.getDelayedTimeMs() : null,
    liveVideoTimeMs: captureSource.videoTimeMs,
  };
  window.seeon.reportNarrationPlayback(report);
}

// Orchestrator → TTS → 전달 Layer: TTS 는 Orchestrator 를 통과한 해설만 만든다. 재생 차례가 가까운 2개는 미리 만들어
// 차례가 오면 바로 들리게 하고(NarrationAudioPrefetcher), 그보다 뒤는 앞 해설이 재생·버려질 때 차례로 만든다.
async function synthesizeEntryAudio(entry) {
  const result = await window.seeon.synthesizeNarration({ ts: entry.ts, text: entry.text, source: entry.source })
    .catch(() => null);
  const wavData = result?.isOk ? result.wavData : null;
  if (!wavData) return null;
  return wavData.buffer.slice(wavData.byteOffset, wavData.byteOffset + wavData.byteLength);
}

const narrationAudio = new NarrationAudioPrefetcher({ synthesize: synthesizeEntryAudio });

const narrator = new CaptionNarrator({
  prepareAudio: (entry) => narrationAudio.take(entry),
  getLiveVideo: getPlaybackVideo,
  onStatus: handleNarrationStatus,
  t,
  onDrop: handleNarrationDrop,
  onPlayStart: reportNarrationPlayStart,
  isEntryEnabled: isNarrationEntryEnabled,
  getRateRange: () => getCatchupRateRange({ mode: getCurrentMode() }),
  isCatchupDelegated: () => Boolean(delayBuffer),
  // 트리거에서 10초 넘게 멀어진 자동 해설을 버리는 기준. 교차 모드는 사용자가 듣고 있는 늦춘 위치다.
  getPlaybackTimeMs: () => (delayBuffer ? delayBuffer.getDelayedTimeMs() : captureSource.videoTimeMs),
});

let narrationMixer = null;

const getNarrationPlayer = () => narrationMixer || narrator;
const narrationGate = new NarrationHoldGate({
  deliver: (entry) => getNarrationPlayer()?.queueCaption(entry),
  deliverList: (entryList) => getNarrationPlayer()?.queueCaptionList(entryList),
});
const audioMeter = new AudioMeter();

function markDebug({ stage, verdict, reason, detail = '', narrationType = null }) {
  window.seeon.appendDebugLog({ stage, verdict, reason, detail, narrationType, ts: Date.now() });
}

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

// 카드 코드는 재생 분류(아키텍처 에이전트)로 고르고, 분류가 없을 때만 source 로 찾는다.
function appendLogCard({ narrationClass = null, source, text, ts = Date.now() }) {
  const stream = $('logStream');
  if (!stream) return;
  clearStreamEmpty();
  const tag = resolveAdCardTag({ narrationClass, source });
  const card = document.createElement('div');
  card.className = 'card';
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const tagEl = document.createElement('span');
  tagEl.className = 'card-tag';
  const aid = document.createElement('span');
  aid.className = 'aid';
  aid.textContent = tag.aid;
  tagEl.append(aid, document.createTextNode(t(tag.labelKey)));
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
  who.textContent = t('stream.askWho', { clock: formatClock(ts) });
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
    narrationMixer = new NarrationMixer({
      onStatus: handleNarrationStatus, onDrop: handleNarrationDrop, isEntryEnabled: isNarrationEntryEnabled, t,
      onPlayStart: reportNarrationPlayStart,
      prepareAudio: (entry) => narrationAudio.take(entry), getPlaybackTimeMs: () => captureSource.videoTimeMs,
    });
    narrationMixer.start(stream);

    captureSource.detachDirectAudio();
    console.log('[mix] 실시간 믹싱 모드 — 회의음 가운데, 해설 중엔 왼쪽 채널로 옮기고 덕킹 / 해설·답 오른쪽 채널');
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
    $('stBuffer').textContent = t('status.delayDisabled');
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
    onDue: ({ entry, captionCaptureMs }) => {
      console.log(`[delay] 삽입 시점 도달 (영상 ${Math.round(captionCaptureMs)}ms 지점)`);
      narrationGate.submit({ ...entry, dueAt: performance.now() });
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
  showNotice(t('mode.delayBufferFallback'));
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
    $('stBuffer').textContent = t('status.playing');
    setPrepOverlay({ isVisible: false });
    return;
  }
  const remainingSec = Math.ceil(remainingMs / 1000);
  $('stBuffer').textContent = t('status.buffering', { seconds: remainingSec });
  setPrepOverlay({ isVisible: true, remainingSec });
}

function setPrepOverlay({ isVisible, remainingSec = 0 }) {
  $('prepOverlay').hidden = !isVisible;
  $('prepRemain').textContent = isVisible ? t('prep.remaining', { seconds: remainingSec }) : '';
}

function stopDelayBuffer() {
  stopDriftMonitor();
  const unplayedList = narrationScheduler?.reset() || [];
  narrationScheduler = null;
  for (const item of unplayedList) reportUnplayedNarration({ entry: item.entry, reason: QUEUE_DROP_REASON_MAP.stopped });
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
  if (note) note.textContent = t('mode.note');
}

function handleClickModeButton({ mode }) {
  if (mode === currentMode) return;

  if (captureSource.isActive && !canSwitchMode({ fromMode: currentMode, toMode: mode })) {
    showNotice(t('mode.cannotRevert'));
    return;
  }
  const previousMode = currentMode;
  currentMode = mode;
  if (isCrossMode(mode)) lastCrossMode = mode;
  renderModeButtons();

  candidateScheduler.setLookaheadMs({ lookaheadMs: computeLookaheadMs({ mode }) });
  candidateScheduler.setSentenceWaitMs({ sentenceWaitMs: computeSentenceWaitMs({ mode }) });
  candidateScheduler.setHoldMs({ holdMs: computeContextHoldMs({ mode }) });
  const modePolicy = getModePolicy({ mode });
  asrSegmenter.setSegmentMs({
    segmentMs: modePolicy?.asrSegmentMs, minSegmentMs: modePolicy?.asrMinSegmentMs,
  });
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
  // 화자 안내를 끄면 화자 판별을 하지 않는다. 꺼진 구간은 이름 없음으로 남겨 켠 뒤에 앞 화자가 이어 붙지 않게 한다.
  speakerTimeline.record({ wallTs: Date.now(), name: isSpeakerTrackingOn() ? roiStore.getCurrentSpeakerName() : null });
  syncToggleAvailability();
});
// main 은 Meet 화면 크기를 바꾸기 직전에 새 크기를 알린다(패널 접기·펼치기, 전체 화면, 창 크기 변경).
window.seeon.onMeetViewResized(({ width, height }) => {
  roiStore.expectViewport({ vw: width, vh: height });
  console.log(`[roi] Meet 화면 크기 변경 ${width}×${height} — 새 좌표가 자리 잡을 때까지 화면을 자르지 않음`);
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

let deixisFrameSeq = 0;

const pointingLocator = new PointingLocator({ rowCount: 18, colCount: 32, cellChangeThreshold: 4 });
const recentPointingMemory = createRecentPointingMemory();
const pointingMotionTracker = createPointingMotionTracker();

const LOCAL_EMBED_MATCH_THRESHOLD = 0.02;
const histogramGate = new SlideHistogramGate({});
const slideRegistry = new SlideEmbeddingRegistry({});
// 슬라이드 전환을 확정한 영상 시각. 체류 판정 후 생성하는 모드에서도 원 사건 시각을 잃지 않게 보관한다.
const slideEventVideoTimeMap = new Map();
const slideTransitionWallTsMap = new Map();
// 선판정 모드는 체류 확정 전에 고지를 요청한다. 체류 미달로 취소되면 이 요청 시각으로 main 의 스크립트에서 그 전환을 뺀다.
const slideTransitionRequestTsMap = new Map();
const transitionOrderGate = new TransitionOrderGate();
// 전환을 확정한 뒤 고지가 정해지기 전에 도착한 화자 안내는 그 고지 뒤에 들려준다(공동 2순위: 전환 → 화자).
const pendingTransitions = new PendingTransitionTracker();

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
    pendingTransitions.settle({ slideLabel: label, status: LEADER_STATUS_MAP.cancelled });
    window.seeon.reportTransitionCancelled({
      slideLabel: label,
      requestTs: slideTransitionRequestTsMap.get(label) ?? null,
      transitionTs: slideTransitionWallTsMap.get(label) ?? null,
    });
    slideTransitionRequestTsMap.delete(label);
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
const slideCandidateGate = createSlideCandidateGate();
// 같은 슬라이드 안 화면 변화 감지기. 세션 시작 응답의 화면 변화 모드(SEEON_SCREEN_CHANGE)가 off 면 만들지 않는다.
const SCREEN_CHANGE_MODE_OFF = 'off';
const SCREEN_CHANGE_MODE_SHADOW = 'shadow';
// 감지기가 거른 사건(되돌아감·커서·영상·스크롤·가리킴)은 표본마다 생겨 사건별로 남기지 않고 30초마다 세어 남긴다.
const SCREEN_CHANGE_SKIP_FLUSH_MS = 30000;
const SCREEN_CHANGE_OUTLINE_COLOR = '#ff2020';
let screenChangeSession = null;
let screenChangeDetector = null;
let screenChangeSlideStart = null;
let screenChangeSkipCountMap = {};
let lastScreenChangeSkipFlushAt = 0;
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

async function captureFrameJpeg() {
  const frame = getFrameRegionPx();
  if (!frame) return null;
  return captureRegionJpeg(frame);
}

// 질문·명령·지시 해설·전환 고지는 그 순간의 화면이 있어야 한다. Meet 화면 크기가 바뀐 직후면 좌표가 자리 잡을 때까지 기다렸다가 찍는다.
function captureFrameJpegWhenSettled() {
  return captureWhenSettled({
    isSettling: () => roiStore.isLayoutSettling(),
    capture: () => captureFrameJpeg(),
  });
}

// 지시 판정 화면은 가리킨 영역이 있으면 잘린 그림(지시 해설용)과 같은 순간의 전체 화면(수치·척도 해설용)을 함께 찍는다.
function captureDeixisFrameSetWhenSettled(subRegion) {
  return captureWhenSettled({
    isSettling: () => roiStore.isLayoutSettling(),
    capture: () => captureDeixisFrameSet({
      frame: getFrameRegionPx(), subRegion, narrowRegion: narrowToPointingRegion, captureRegion: captureRegionJpeg,
    }),
  });
}

async function captureRegionJpeg(region) {
  if (!region || !captureSource.liveVideo) return null;
  const canvas = document.createElement('canvas');
  const { width, height } = fitWithinLongEdge({ width: region.w, height: region.h });
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(
    captureSource.liveVideo, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CROP_JPEG_QUALITY));
  return blob ? blob.arrayBuffer() : null;
}

function normRectToPx(rect, vw, vh) {
  return { x: rect.x * vw, y: rect.y * vh, w: rect.w * vw, h: rect.h * vh };
}

const ROI_CHANGE_REASON_MAP = {
  [ROI_CHANGE_CAUSE_MAP.screen]: 'ROI 좌표 변경 → 전환 감지기 리셋',
  [ROI_CHANGE_CAUSE_MAP.layout]: 'Meet 화면 크기 변경 → 전환 감지기 다시 기준 잡기',
};

// 공유 화면 좌표가 바뀌면 감지기 기준은 늘 다시 잡는다. Meet 화면 크기만 바뀐 경우는 같은 화면이 자리만 옮긴 것이라
// 체류 판정 중인 전환 고지를 살려 둔다.
function syncRoiGeneration({ ts }) {
  const generation = roiStore.getScreenGeneration();
  if (generation === lastScreenGeneration) return;
  lastScreenGeneration = generation;
  const cause = roiStore.getLastChangeCause();
  const { shouldResetDwell } = resolveRoiChangeReset({ cause });
  histogramGate.reset();
  pointingLocator.reset();
  recentPointingMemory.reset();
  pointingMotionTracker.reset();
  screenChangeDetector?.reset();
  lastPointingMotionAt = -Infinity;
  if (shouldResetDwell) slideDwellGate.reset();
  roiChangeSuppressUntil = ts + ROI_CHANGE_SUPPRESS_MS;
  markDebug({
    stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.info,
    reason: ROI_CHANGE_REASON_MAP[cause],
    detail: `세대=${generation} · 공유화면=${roiStore.hasScreenShare() ? '있음' : '없음'}`
      + ` · 체류 판정=${shouldResetDwell ? '초기화' : '유지'}`,
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
  attachPointingMotion();
  sampleScreenChange({ imageData, ts });
}

function toWallTs(perfTs) {
  return Date.now() - (performance.now() - perfTs);
}

function flushScreenChangeSkipCount({ ts }) {
  if (ts - lastScreenChangeSkipFlushAt < SCREEN_CHANGE_SKIP_FLUSH_MS) return;
  lastScreenChangeSkipFlushAt = ts;
  const countList = Object.entries(screenChangeSkipCountMap);
  if (!countList.length) return;
  screenChangeSkipCountMap = {};
  markDebug({
    stage: DEBUG_STAGE_MAP.screenChange, verdict: DEBUG_VERDICT_MAP.info,
    reason: '화면 변화 감지기 거름(30초 집계)', detail: countList.map(([reason, count]) => `${reason}=${count}`).join(' '),
  });
}

// 같은 슬라이드 안 변화: 칸 차이가 굳은 순간을 감지기가 고르면 화면을 찍어 main 에 보낸다. 해설할지는 main 이 정한다.
function sampleScreenChange({ imageData, ts }) {
  if (!screenChangeDetector) return;
  const slideLabel = slideRegistry.currentLabel();
  if (!slideLabel) return;
  const result = screenChangeDetector.sample({
    gray: convertToGrayscale(imageData), width: imageData.width, height: imageData.height, ts,
    videoTimeMs: captureSource.videoTimeMs,
    excludedCellMask: pointingLocator.findConstantChangeCells({ nowTs: ts }),
    // 펜·레이저처럼 여러 칸을 옮겨 다니는 움직임만 가리킴으로 본다. 한 자리에 값이 뜬 변화도 가리킴 표본기에는 영역으로 잡혀
    // 마지막 영역 시각(lastPointingMotionAt)으로 거르면 모든 변화가 가리킴이 된다.
    isPointingActive: pointingMotionTracker.isMoving({ nowTs: ts }),
    isConfirming: isConfirmingSlide,
  });
  if (result.skipReason) screenChangeSkipCountMap[result.skipReason] = (screenChangeSkipCountMap[result.skipReason] || 0) + 1;
  flushScreenChangeSkipCount({ ts });
  if (result.isBaselineCommitted) {
    sendScreenChangeBaseline({ slideLabel, isSlideStart: result.isSlideStart })
      .catch((error) => console.warn('[screen-change] 기준 화면 전송 오류', error));
  }
  if (result.event) {
    reportScreenChange({ event: result.event, slideLabel })
      .catch((error) => console.warn('[screen-change] 변화 전송 오류', error));
  }
}

async function canvasToJpeg(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CROP_JPEG_QUALITY));
  return blob ? blob.arrayBuffer() : null;
}

// 깨끗한 전체 화면(OCR·기준용)과 VLM 그림을 같은 영상 프레임에서 만든다. outline 은 바뀐 곳에 테두리를 그린 전체 화면이다
// (잘린 그림은 라벨·축 이름을 잃는다). crop 은 바뀐 곳만, full 은 따로 만들지 않는다.
async function captureScreenChangeFrameSet({ rectNorm, imageMode }) {
  const frame = getFrameRegionPx();
  if (!frame || !captureSource.liveVideo) return null;
  const canvas = document.createElement('canvas');
  const { width, height } = fitWithinLongEdge({ width: frame.w, height: frame.h });
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(captureSource.liveVideo, frame.x, frame.y, frame.w, frame.h, 0, 0, width, height);
  const buffer = await canvasToJpeg(canvas);
  if (imageMode === 'crop') return { buffer, vlmBuffer: await captureRegionJpeg(narrowToPointingRegion(frame, rectNorm)) };
  if (imageMode !== 'outline') return { buffer, vlmBuffer: null };
  const lineWidth = Math.max(3, Math.round(Math.min(width, height) * 0.006));
  const pad = lineWidth * 2;
  const x0 = Math.max(0, rectNorm.x * width - pad);
  const y0 = Math.max(0, rectNorm.y * height - pad);
  const x1 = Math.min(width, (rectNorm.x + rectNorm.w) * width + pad);
  const y1 = Math.min(height, (rectNorm.y + rectNorm.h) * height + pad);
  context.strokeStyle = SCREEN_CHANGE_OUTLINE_COLOR;
  context.lineWidth = lineWidth;
  context.strokeRect(x0, y0, x1 - x0, y1 - y0);
  return { buffer, vlmBuffer: await canvasToJpeg(canvas) };
}

async function reportScreenChange({ event, slideLabel }) {
  if (!screenChangeSession || roiStore.isLayoutSettling()) return;
  const sessionSeq = experimentSeq;
  const isShadow = screenChangeSession.mode === SCREEN_CHANGE_MODE_SHADOW;
  const wordBudget = buildWordBudget({ narrationType: NARRATION_TYPE_MAP.screenChange, subKind: SCREEN_CHANGE_KIND_MAP.newText });
  if (wordBudget.isDroppable && !isShadow) {
    markDebug({
      stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.screenChange,
      reason: '어절 예산이 유형 하한 미달 → 드롭', detail: `화면 변화 · 모드=${getCurrentMode()} 하한=${wordBudget.minWordCount}어절`,
    });
    return;
  }
  const frameSet = await captureScreenChangeFrameSet({
    rectNorm: event.rect, imageMode: isShadow ? null : screenChangeSession.image,
  });
  if (!frameSet?.buffer || !captureSource.isActive || sessionSeq !== experimentSeq) return;
  await window.seeon.sendScreenChange({
    ts: Date.now(), slideLabel, buffer: frameSet.buffer, vlmBuffer: frameSet.vlmBuffer,
    regionNorm: event.rect, changedRatio: event.changedRatio, cellCount: event.cellCount,
    firstSeenTs: toWallTs(event.firstSeenTs), firstSeenVideoTimeMs: event.firstSeenVideoTimeMs,
    recentTranscript: transcriptWindow.getBefore({ nowTs: performance.now(), windowMs: SILENCE_TRANSCRIPT_WINDOW_MS }),
    wordBudget, imageMode: screenChangeSession.image,
  });
}

// 감지기가 기준으로 삼은 화면을 main 에 보내 OCR 기준으로도 쓴다. 새 슬라이드 기준 화면이면 그 슬라이드가 시작된 시각을 함께 보낸다.
async function sendScreenChangeBaseline({ slideLabel, isSlideStart }) {
  const sessionSeq = experimentSeq;
  const buffer = await captureFrameJpeg();
  if (!buffer || !captureSource.isActive || sessionSeq !== experimentSeq) return;
  const slideStart = isSlideStart && screenChangeSlideStart?.slideLabel === slideLabel ? screenChangeSlideStart : null;
  await window.seeon.sendScreenChangeBaseline({
    ts: Date.now(), slideLabel, buffer, isSlideStart: Boolean(slideStart), slideStartTs: slideStart?.wallTs ?? null,
    eventVideoTimeMs: captureSource.videoTimeMs,
  });
}

function detectSlideTransition({ imageData, ts }) {
  const verdict = histogramGate.sample({ imageData, ts });

  if (ts - lastGateLogAt > 1000) {
    lastGateLogAt = ts;
    const region = roiStore.hasScreenShare() ? 'screen-roi' : 'full-frame';
    console.log(`[slide][gate] ff=${histogramGate.lastFrameToFrame.toFixed(3)} cvr=${histogramGate.lastChangeVsRef.toFixed(3)} state=${histogramGate.state} still=${histogramGate.stillCount} (motion≥${histogramGate.motionDistance}, still≤${histogramGate.stillDistance}, region=${region})`);
  }

  const candidate = slideCandidateGate.decide({
    verdict, ts, suppressUntil: roiChangeSuppressUntil, isConfirming: isConfirmingSlide,
  });
  if (!candidate.shouldConfirm) return;
  isConfirmingSlide = true;
  confirmSlideCandidate({ isFirst: candidate.isFirst, imageData })
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
  pointingLocator.resetChangeHistory();
  screenChangeSlideStart = { slideLabel: decision.label, wallTs: Date.now() };
  screenChangeDetector?.setBaseline({ ts: performance.now(), isSlideStart: true });
  const isRevisit = Boolean(decision.isRevisit);
  if (decision.isNew && buffer) {
    window.seeon.requestSlideText({ slideLabel: decision.label, buffer }).catch(() => {});
  }

  lastScreenTransitionAt = performance.now();
  pendingTransitions.open({ slideLabel: decision.label });
  slideEventVideoTimeMap.set(decision.label, captureSource.videoTimeMs);
  slideTransitionWallTsMap.set(decision.label, Date.now());
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

// 고지를 내지 않고 끝난 전환은 기다리는 화자 안내를 바로 풀어 준다.
function releasePendingTransition({ slideLabel }) {
  pendingTransitions.settle({ slideLabel, status: LEADER_STATUS_MAP.unscheduled });
}

async function requestPageTransitionNarration(decision) {
  const buffer = await captureFrameJpegWhenSettled();
  if (!buffer) {
    releasePendingTransition({ slideLabel: decision.label });
    return;
  }
  const ts = Date.now();
  slideTransitionRequestTsMap.set(decision.label, ts);
  const transitionNotice = buildSlideTransitionNotice({
    isRevisit: decision.isRevisit, isPageTransitionOn: featureToggleStore.isOn(FEATURE_KEY_MAP.pageTransition), t,
  });
  if (transitionNotice) showNotice(transitionNotice);

  saveSlideFrameWithMark({
    slideLabel: decision.label, frameKind: 'base', buffer,
    transitionTs: slideTransitionWallTsMap.get(decision.label) ?? null,
  }).catch(() => {});

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
    releasePendingTransition({ slideLabel: decision.label });
    return;
  }
  const result = await window.seeon.sendPipelineFrame({
    ts, buffer, slideLabel: decision.label, wordBudget, isRevisit: Boolean(decision.isRevisit),
    eventVideoTimeMs: slideEventVideoTimeMap.get(decision.label) ?? captureSource.videoTimeMs,
  }).catch(() => null);
  // 고지를 내보냈으면 캡션 도착(applyCaption)이 삽입 시각을 정하며 풀어 준다.
  if (!result?.isEmitted) releasePendingTransition({ slideLabel: decision.label });
}

const SPEAKER_POLL_MS = 2500;
const SPEAKER_VOICE_IDLE_MS = 2000;
let speakerPollTimer = null;
let isSpeakerRequestInFlight = false;

// 화자 확인에 찍을 참가자 타일 영역. 공유 화면 밖은 처리하지 않으므로, 타일 영역을 모르면 Meet 창 전체로 대신하지 않고 null 이다.
function getParticipantRegionPx() {
  const liveVideo = captureSource.liveVideo;
  if (!liveVideo || !liveVideo.videoWidth) return null;
  const vw = liveVideo.videoWidth; const vh = liveVideo.videoHeight;
  const rect = roiStore.getParticipantRectNorm();
  return rect ? normRectToPx(rect, vw, vh) : null;
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
  // 화자 안내를 끄면 안내만 막는 것이 아니라 화자 판별(DOM·VLM) 자체를 하지 않는다.
  if (!featureToggleStore.isOn(FEATURE_KEY_MAP.speakerIdentity)) return;
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
  if (!domVerdict.isDomResolved && !region) {
    markDebug({
      stage: DEBUG_STAGE_MAP.speaker, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.speakerIdentity,
      reason: '참가자 영역을 몰라 화자 확인을 건너뜀',
      detail: 'DOM 으로 정하지 못했고 참가자 타일 좌표가 없다 — 공유 화면 밖 창 전체는 보내지 않는다',
    });
    return;
  }
  let result = null;
  try {
    isSpeakerRequestInFlight = true;
    if (domVerdict.isDomResolved) {
      result = await window.seeon.sendPipelineSpeaker({
        ts: Date.now(), source: SPEAKER_SOURCE_MAP.dom, wordBudget,
        speakerName: domVerdict.speaker.name,
        position: domVerdict.speaker.position,
        participantId: domVerdict.speaker.participantId || '',
        eventVideoTimeMs: captureSource.videoTimeMs,
      });
    } else {
      const buffer = await captureRegionJpeg(region);
      if (!buffer) return;
      result = await window.seeon.sendPipelineSpeaker({
        ts: Date.now(), source: SPEAKER_SOURCE_MAP.vlm, buffer, wordBudget,
        eventVideoTimeMs: captureSource.videoTimeMs,
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

// 화자 식별 기능(C15)이 켜져 있을 때만 화자를 판별한다(안내·스크립트 모두).
function isSpeakerTrackingOn() {
  return featureToggleStore.isOn(FEATURE_KEY_MAP.speakerIdentity);
}

function getSpeakerHint() {
  if (!isSpeakerTrackingOn()) return null;
  const domName = roiStore.getCurrentSpeakerName();
  if (domName) return domName;
  const isFresh = performance.now() - lastResolvedSpeakerAt <= SPEAKER_HINT_TTL_MS;
  return lastResolvedSpeakerName && isFresh ? lastResolvedSpeakerName : null;
}

// 회의 스크립트는 발화마다 화자를 적는다. 조각 구간에 Meet 표시로 가장 오래 말한 사람, 없으면 지금 화자 힌트를 쓴다.
function resolveSegmentSpeaker({ startTs, endTs }) {
  if (!isSpeakerTrackingOn()) return null;
  return speakerTimeline.resolveDominant({ startTs, endTs }) || getSpeakerHint();
}

const asrSegmenter = new AsrSegmenter({
  onSegment: ({ startTs, endTs, buffer }) => {
    if (!isPipelineEnabled()) return;

    window.seeon.sendPipelineAudio({
      startTs, endTs, buffer, speakerHint: resolveSegmentSpeaker({ startTs, endTs }),
      isSpeakerTracked: isSpeakerTrackingOn(),
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

let lastSpeechBlindAt = 0;
const silenceTrigger = new SilenceTrigger();

function getLastSpeechWallTs() {
  return resolveLastSpeechWallTs({
    lastActiveAt: lastAudioActiveAt, lastBlindAt: lastSpeechBlindAt,
    nowPerf: performance.now(), nowWall: Date.now(),
  });
}

// 지시 판정에 마지막으로 들어간 시각(판정이 났거나 보류 중인 결정에 조각을 합친 때). 그 전 조각은 그 판정의 발화에 이미 들어갔다.
let lastDeixisDecidedAt = -Infinity;

const SUBMIT_RESULT_LABEL_MAP = {
  [SUBMIT_RESULT_MAP.started]: 'look-ahead 대기',
  [SUBMIT_RESULT_MAP.absorbed]: 'look-ahead 중인 후보에 합침',
  [SUBMIT_RESULT_MAP.merged]: '판단 전 보류 중인 결정에 합침',
};

const candidateScheduler = new DeixisCandidateScheduler({ onDecide: runDeixisDecision, getLastSpeechWallTs });
const deixisDetector = new DeixisDetector({
  onDeixis: ({ text, trigger, candidateList, captureTs, eventWallTs }) => {
    const { region, pointingOrderHint } = resolveDeixisPointing({ eventWallTs: eventWallTs ?? captureTs, trigger });
    const nowVideoTimeMs = captureSource.videoTimeMs;
    const nowTs = performance.now();
    const submitResult = candidateScheduler.submit({
      source: CANDIDATE_SOURCE_MAP.speech, utterance: text, trigger, candidateList, region, pointingOrderHint,
      captureTs: nowTs, videoTimeMs: nowVideoTimeMs,
      eventVideoTimeMs: wallToVideoTimeMs({ wallTs: eventWallTs, nowVideoTimeMs }) ?? nowVideoTimeMs,
      leadText: transcriptWindow.getOpenSentenceLead({ nowTs, sinceTs: lastDeixisDecidedAt }),
      chunkEndWallTs: captureTs,
    });
    console.log(`[deixis] 🗣 발화 지시 "${trigger}" → ${SUBMIT_RESULT_LABEL_MAP[submitResult] || submitResult}`);
  },
});

// 직전 창에 영역이 없으면, 트리거 발화보다 앞서 같은 슬라이드에서 가리킨 영역을 붙인다(말하면서 가리킨 경우).
function resolveDeixisPointing({ eventWallTs, trigger }) {
  const sequence = getPointingSequence();
  if (sequence.region) return sequence;
  const recalled = recentPointingMemory.recall({ eventWallTs, slideLabel: slideRegistry.currentLabel() });
  if (!recalled) return sequence;
  console.log(`[deixis] ✍ 직전 창에 영역 없음 → 발화 전 가리킨 영역을 붙임 트리거="${trigger}"`);
  markDebug({
    stage: DEBUG_STAGE_MAP.screenDependency, verdict: DEBUG_VERDICT_MAP.info, narrationType: NARRATION_TYPE_MAP.deixis,
    reason: '발화 전에 움직이며 가리킨 영역을 붙임', detail: `트리거="${trigger}" 슬라이드=${slideRegistry.currentLabel() || '-'}`,
  });
  return recalled;
}

function attachPointingMotion() {
  const now = performance.now();
  const motion = pointingLocator.locate({ nowTs: now });
  if (!motion.hasRegion) return;
  pointingMotionTracker.add({ ts: now, rect: motion.rect, changedRatio: motion.changedRatio });
  if (now - lastPointingMotionAt < POINTING_MOTION_DEBOUNCE_MS) return;
  lastPointingMotionAt = now;
  const { region, pointingOrderHint } = getPointingSequence();
  // 잡음(같은 자리 깜빡임·이웃 칸 오감)까지 기억하면 펜 없는 장면 발화에도 영역이 붙는다. 점이 움직일 때만 기억한다.
  if (pointingMotionTracker.isMoving({ nowTs: now })) {
    recentPointingMemory.remember({
      region: region || motion.rect, pointingOrderHint, wallTs: Date.now(), slideLabel: slideRegistry.currentLabel(),
    });
  }
  saveAnnotationSnapshot();
  const isAttached = candidateScheduler.attachPointing({
    region: region || motion.rect, pointingOrderHint,
  });
  console.log(`[deixis] ✍ 포인팅 모션 changedRatio=${(motion.changedRatio ?? 0).toFixed(3)}`
    + ` → ${isAttached ? '대기 중인 발화 후보에 영역 첨부' : '대기 후보 없음 (포인터는 트리거가 아니다)'}`);
}

// transitionTs 는 슬라이드가 실제로 바뀐 시각이다. 교차 모드는 체류 확정 뒤에 저장하므로 ts 보다 이르다.
async function saveSlideFrameWithMark({ slideLabel, frameKind, buffer, transitionTs = null }) {
  const ts = Date.now();
  const filePath = await window.seeon
    .saveSlideFrame({ slideLabel, kind: frameKind, buffer, sessionId: currentSessionId })
    .catch(() => null);
  if (!filePath) return;
  window.seeon.markSlideFrame({ ts, slideLabel, frameKind, filePath, transitionTs });
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
  [SCREEN_DEPENDENCY_REASON_MAP.unsupportedSource]: '발화가 아닌 출처 — 트리거로 쓰지 않는다',
};

// 화면은 판정이 난 지금 찍고, 판단 LLM 에는 보류(균형·품질 모드)가 끝난 결정을 보낸다.
// 보류 중에 들어온 뒤 조각과 그 후보도 이 결정에 합쳐져 함께 판단을 받는다.
async function runDeixisDecision(firedDecision) {
  lastDeixisDecidedAt = performance.now();
  const mode = getCurrentMode();
  const sessionSeq = experimentSeq;
  // 판정 화면을 찍기 시작한 시각. 이 뒤에 화면이 바뀌었는지로 늦은 근거 재시도를 짝짓는다.
  const frameTs = Date.now();
  const [{ buffer, fullBuffer }, decision] = await Promise.all([
    captureDeixisFrameSetWhenSettled(firedDecision.region), firedDecision.whenSealed ?? firedDecision,
  ]);
  if (!buffer || !decision) return;
  if (!captureSource.isActive || sessionSeq !== experimentSeq) return;

  const { source, utterance, triggerList, candidateList = [], region, pointingOrderHint,
    captureTs, videoTimeMs, eventVideoTimeMs = null,
    triggerUtterance = utterance, leadText = '', followText = '', isSentenceWaited = false, mergedChunkCount = 0 } = decision;
  const label = triggerList.join(', ') || '-';
  if (leadText || followText) {
    markDebug({
      stage: DEBUG_STAGE_MAP.asr, verdict: DEBUG_VERDICT_MAP.info,
      reason: '조각을 문장 단위로 이어 붙임',
      detail: `트리거 조각="${triggerUtterance}" → 문장="${utterance}"`
        + ` (앞="${leadText || '-'}" · 뒤="${followText || '-'}" · 문장 끝 추가 대기=${isSentenceWaited ? 'Y' : 'N'}`
        + `${mergedChunkCount > 0 ? ` · 판단 전 보류 중 합친 뒤 조각 ${mergedChunkCount}개` : ''})`,
    });
  }
  const { beforeMs, afterMs } = getModePolicy({ mode }) || {};

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
  const screenVerdict = judgeScreenDependency({ source, candidateList });
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
  // 잘린 그림이 있을 때만 그 영역의 비율 상자를 함께 보낸다(main 의 발화 ROI 가 발화로 찾은 곳과 견준다).
  const pointingRect = fullBuffer
    ? toPointingRect({ subRegion: firedDecision.region, margin: POINTING_CROP_MARGIN }) : null;
  const result = await window.seeon.sendPipelineDeixis({
    ts, buffer, fullBuffer, utterance, recentTranscript, beforeTranscript: before, afterTranscript: after,
    hasPointingRegion: Boolean(region), pointingOrderHint, slideLabel: slideRegistry.currentLabel(),
    wordBudgetMap, eventVideoTimeMs, triggerCandidateList: candidateList, pointingRect, frameTs,
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
  asrSegmentTimeline.add({ segmentList, chunkStartTs, chunkEndTs, nowWallTs: nowTs, nowVideoTimeMs });
  for (const boundary of boundaryList) {
    const boundaryTs = chunkStartTs + boundary.offsetMs;
    gapCandidateStore.add({
      videoTimeMs: nowVideoTimeMs - (nowTs - boundaryTs),
      kind: boundary.kind, silenceMs: boundary.silenceMs, text: boundary.text,
    });
  }
  return boundaryList.length;
}

function handleAsrTranscript({ text, ts, endTs, segmentList = [], triggerCandidateList = [] }) {
  const trimmed = (text || '').trim();
  if (trimmed) {
    markDebug({
      stage: DEBUG_STAGE_MAP.asr, verdict: DEBUG_VERDICT_MAP.pass,
      reason: '전사 도착', detail: `"${trimmed}"`,
    });

    transcriptWindow.push({ text: trimmed, ts: performance.now() });
    const timedCandidateList = attachCandidateEventVideoTime({
      candidateList: triggerCandidateList, text, chunkStartTs: ts, chunkEndTs: endTs, segmentList,
      nowVideoTimeMs: captureSource.videoTimeMs,
    });
    // 대기·보류 중인 지시 후보가 있으면 이 조각과 그 후보를 그 결정에 먼저 붙인다. 새 후보는 그다음 탐지에서 생긴다.
    // 이 조각으로 앞 후보의 판정이 났으면, 이미 그 문장에 쓴 조각이므로 새 후보의 트리거로 쓰지 않는다.
    const { isAppended, isDecided } = candidateScheduler.appendTranscript({
      text: trimmed, endTs, candidateList: timedCandidateList,
    });
    if (isAppended) lastDeixisDecidedAt = performance.now();
    if (!isDecided) {
      deixisDetector.handleTranscript({
        text: trimmed, candidateList: timedCandidateList, captureTs: endTs,
        resolveEventWallTs: ({ trigger }) => resolveSpeechEndWallTs({
          chunkStartTs: ts, chunkEndTs: endTs, segmentList, trigger,
        }),
      });
    }
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

function handleCaption({ text, source, narrationClass = null, eventVideoTimeMs = null }) {
  appendLogCard({ narrationClass, source, text });
  if (source === CAPTION_SOURCE_TRANSITION) lastScreenNarration = text;
  return Number.isFinite(eventVideoTimeMs) ? eventVideoTimeMs : captureSource.videoTimeMs;
}

const COMMAND_DEDUPE_MS = 400;
const lastCommandAtMap = new Map();

function isDuplicateCommand({ dedupeKey }) {
  const now = performance.now();
  const lastAt = lastCommandAtMap.get(dedupeKey);
  if (lastAt !== undefined && now - lastAt < COMMAND_DEDUPE_MS) return true;
  lastCommandAtMap.set(dedupeKey, now);
  return false;
}

// main 에 넘기는 질문 문구(questionLabel)는 한국어 그대로 둔다. 화면의 질문 말풍선만 캡션 언어로 보인다.
const USER_COMMAND_LABEL_MAP = {
  [USER_COMMAND_MAP.screenMaterial]: '지금 화면에 무슨 자료가 있어?',
  [USER_COMMAND_MAP.pageSummary]: '지금 화면을 요약해줘',
  [USER_COMMAND_MAP.graphAxis]: '그래프 축이 뭐야?',
};

const USER_COMMAND_LABEL_KEY_MAP = {
  [USER_COMMAND_MAP.screenMaterial]: 'command.screenMaterial',
  [USER_COMMAND_MAP.pageSummary]: 'command.pageSummary',
  [USER_COMMAND_MAP.graphAxis]: 'command.graphAxis',
};

function readUserCommandLabel(command) {
  const key = USER_COMMAND_LABEL_KEY_MAP[command];
  return key ? t(key) : '';
}

// 지금 질문을 받을 수 없으면 그 까닭의 문구 키(캡처 전·일시정지 중), 받을 수 있으면 null.
function readQuestionBlockedTextKeyNow() {
  return readQuestionBlockedTextKey({ isCapturing: captureSource.isActive, isPaused: isExperimentPaused });
}

// 프리셋 커맨드(command)와 자유 자연어 질문(questionText)을 함께 처리한다.
// 자유 질문이면 최근 발화(recentTranscript)를 근거로 붙인다 — 심화 질의응답 경로.
async function askQuestion({ command = null, questionText = null, inputSource = 'typed', dedupeKey = command }) {
  if (dedupeKey && isDuplicateCommand({ dedupeKey })) return;
  const blockedTextKey = readQuestionBlockedTextKeyNow();
  if (blockedTextKey) {
    announce(t(blockedTextKey));
    return;
  }
  appendAskBubble({ text: questionText || readUserCommandLabel(command) || command });
  // 답(수동 AD)이 나올 때까지 자동 해설을 보류한다(최대 20초). 재생 중인 해설은 끊지 않고 끝난 뒤 답을 바로 낸다.
  await holdDuringAnswer({ gate: narrationGate, task: () => requestAnswer({ command, questionText, inputSource }) });
}

async function requestAnswer({ command, questionText, inputSource }) {
  const buffer = await captureFrameJpegWhenSettled();
  if (!buffer) {
    announce(t('question.captureFailed'));
    return;
  }
  const ts = Date.now();
  const wordBudget = computeAnswerWordBudget();
  if (!questionText) {
    await window.seeon.sendPipelineCommand({
      ts, buffer, command, questionLabel: USER_COMMAND_LABEL_MAP[command] || '', wordBudget,
      eventVideoTimeMs: captureSource.videoTimeMs,
    }).catch(() => null);
    return;
  }
  // 교차 모드는 회의를 늦게 듣는다. "방금·지금"을 사용자가 듣고 있는 위치 기준으로 답하도록 그 위치를 넘긴다.
  const heardVideoTimeMs = delayBuffer ? delayBuffer.getDelayedTimeMs() : captureSource.videoTimeMs;
  const heardWallTs = Date.now() - Math.max(0, captureSource.videoTimeMs - heardVideoTimeMs);
  const result = await window.seeon.sendPipelineQuestion({
    ts, buffer, questionText, wordBudget, inputSource, heardWallTs, heardVideoTimeMs,
    currentSlideLabel: slideRegistry.currentLabel(), speakerHintNow: getSpeakerHint(),
    eventVideoTimeMs: captureSource.videoTimeMs,
  }).catch(() => null);
  if (!result?.isOk) announce(t('question.answerFailed'));
}

// 질문 프리셋(Ctrl+1~9·질문 버튼). 기본 문구는 전용 명령으로, 고치거나 넣은 문구는 자유 질문으로 묻는다.
function askQuestionPreset({ slot }) {
  const preset = questionPresetStore.get(slot);
  if (!preset) {
    announce(t('question.presetEmpty', { slot }));
    return;
  }
  if (preset.command) {
    askQuestion({ command: preset.command });
    return;
  }
  askQuestion({ questionText: preset.text, inputSource: 'preset', dedupeKey: `preset:${slot}` });
}
window.seeon.onQuestionPreset(askQuestionPreset);

// 기능별 켜기·끄기(C15). 페이지 전환·화자 안내를 꺼도 데이터는 계속 모으고 main 이 캡션만 내보내지 않는다.

// 설정 스위치는 스크린리더가 바뀐 상태(aria-checked)를 읽으므로 화면 알림만 띄운다. 단축키는 따로 읽어 준다.
let isSwitchToggle = false;

function isFeatureLockedNow(key) {
  return isFeatureLockedDuringCapture(key) && captureSource.isActive;
}

function toggleFeature({ key, isFromSwitch = false }) {
  if (isFeatureLockedNow(key)) {
    announce(t('feature.lockedDuringCapture', { label: readFeatureLabel({ key, t }) }));
    return;
  }
  isSwitchToggle = isFromSwitch;
  try {
    featureToggleStore.toggle(key);
  } finally {
    isSwitchToggle = false;
  }
}

function syncFeatureTogglesToMain() {
  const disabledClassList = listDisabledNarrationClass({ store: featureToggleStore });
  window.seeon.setFeatureToggles({ disabledClassList }).catch((error) => {
    console.warn('[toggle] main 에 기능 토글을 알리지 못함:', error.message);
  });
}

// 회의 요약 스위치를 회의 중에 바꾸면 main 의 회의 중 구간 요약도 따라 멈추거나 다시 한다.
function syncMeetingSummaryToMain({ isOn }) {
  window.seeon.setMeetingSummaryEnabled({ isEnabled: isOn }).catch((error) => {
    console.warn('[toggle] main 에 회의 요약 스위치를 알리지 못함:', error.message);
  });
}

function buildFeatureToggleList() {
  const container = $('featureToggleList');
  if (!container) return;
  container.replaceChildren(...FEATURE_KEY_LIST.map((key) => {
    const shortcut = FEATURE_SHORTCUT_MAP[key];
    const featureLabel = readFeatureLabel({ key, t });
    const row = document.createElement('div');
    row.className = 'set-row';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = `${featureLabel} (${shortcut.text})`;
    label.setAttribute('aria-hidden', 'true');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'set-toggle';
    button.dataset.feature = key;
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', t('feature.switchAriaLabel', { label: featureLabel, shortcut: shortcut.spoken }));
    button.addEventListener('click', () => toggleFeature({ key, isFromSwitch: true }));
    row.append(label, button);
    return row;
  }));
  syncFeatureToggleUi();
}

// 버튼을 다시 만들지 않고 상태만 바꾼다. 스크린리더 포커스가 누른 스위치에 남는다.
function syncFeatureToggleUi() {
  for (const button of document.querySelectorAll('#featureToggleList [data-feature]')) {
    const isOn = featureToggleStore.isOn(button.dataset.feature);
    button.classList.toggle('on', isOn);
    button.setAttribute('aria-checked', String(isOn));
    // 잠긴 스위치도 초점을 받아 눌렀을 때 왜 못 바꾸는지 들을 수 있게 disabled 대신 aria-disabled 를 쓴다.
    button.setAttribute('aria-disabled', String(isFeatureLockedNow(button.dataset.feature)));
    button.textContent = t(isOn ? 'feature.on' : 'feature.off');
  }
  syncFeatureOffBadge();
}

function syncFeatureOffBadge() {
  const badge = $('featureOffBadge');
  if (!badge) return;
  const text = describeDisabledFeatureBadge({ store: featureToggleStore, t });
  badge.textContent = text;
  badge.hidden = !text;
}

featureToggleStore.subscribe(({ key, isOn }) => {
  const changedText = t(isOn ? 'feature.turnedOn' : 'feature.turnedOff', { label: readFeatureLabel({ key, t }) });
  if (isSwitchToggle) showNotice(changedText);
  else announce(changedText);
  markDebug({
    stage: DEBUG_STAGE_MAP.toggle, verdict: DEBUG_VERDICT_MAP.info,
    reason: '기능 토글', detail: `${FEATURE_LABEL_MAP[key]} ${isOn ? '켜짐' : '꺼짐'}`,
  });
  syncFeatureTogglesToMain();
  if (key === FEATURE_KEY_MAP.meetingSummary) syncMeetingSummaryToMain({ isOn });
  syncFeatureToggleUi();
});

window.seeon.onSummaryToggle(() => toggleFeature({ key: FEATURE_KEY_MAP.meetingSummary }));
window.seeon.onFeatureToggle(({ feature }) => {
  if (FEATURE_KEY_LIST.includes(feature)) toggleFeature({ key: feature });
});
buildFeatureToggleList();
syncFeatureTogglesToMain();

// 캡션 언어(한국어·English)는 여기서 고르기만 하고, 캡처를 시작할 때 main 에 한 번 넘겨 그 회의 동안 쓴다.
// 회의 받아쓰기는 고르지 않는다(늘 자동). 사용자에게 들리는 말과 화면 글자가 이 언어를 따른다.
// 화자 안내처럼 잠긴 동안에도 초점을 받아 왜 못 바꾸는지 들을 수 있게 disabled 대신 aria-disabled 를 쓴다.
const CAPTION_LANGUAGE_OPEN_KEY_LIST = [' ', 'Enter', 'ArrowUp', 'ArrowDown'];

function isCaptionLanguageLockedNow() {
  return isCaptionLanguageLocked({ isCaptureActive: captureSource.isActive });
}

function announceCaptionLanguageLocked() {
  announce(t('captionLanguage.locked'));
}

// 잠긴 선택 상자는 펼치지 않는다. 그래도 값이 바뀌면(문자 입력 등) change 에서 되돌린다.
function blockLockedCaptionLanguageInput(event) {
  if (!isCaptionLanguageLockedNow()) return;
  if (event.type === 'keydown' && !CAPTION_LANGUAGE_OPEN_KEY_LIST.includes(event.key)) return;
  event.preventDefault();
  announceCaptionLanguageLocked();
}

function handleChangeCaptionLanguage() {
  const select = $('captionLanguageSelect');
  if (isCaptionLanguageLockedNow()) {
    select.value = captionLanguageStore.get();
    announceCaptionLanguageLocked();
    return;
  }
  captionLanguageStore.set(select.value);
}

function buildCaptionLanguageSelect() {
  const select = $('captionLanguageSelect');
  if (!select) return;
  select.replaceChildren(...CAPTION_LANGUAGE_LIST.map((language) => {
    const option = document.createElement('option');
    option.value = language;
    option.textContent = CAPTION_LANGUAGE_LABEL_MAP[language];
    return option;
  }));
  select.addEventListener('mousedown', blockLockedCaptionLanguageInput);
  select.addEventListener('keydown', blockLockedCaptionLanguageInput);
  select.addEventListener('change', handleChangeCaptionLanguage);
  syncCaptionLanguageUi();
}

function syncCaptionLanguageUi() {
  const select = $('captionLanguageSelect');
  if (!select) return;
  select.value = captionLanguageStore.get();
  select.setAttribute('aria-disabled', String(isCaptionLanguageLockedNow()));
}

// 캡션 언어가 바뀌면 화면 글자를 그 언어로 다시 입힌다. 고정 글자는 data-ui-text 로, 글자를 넣어 만든 부분은 다시 그린다.
// 캡션 언어는 회의 캡처 중에는 바뀌지 않으므로 대기 상태 그대로 통째로 다시 그려도 된다.
function applyCaptionLanguageToUi({ language }) {
  document.documentElement.lang = language;
  applyUiTextToDom({ root: document, t });
  setToggleUi(captureSource.isActive);
  setPauseUi(isExperimentPaused);
  syncToggleAvailability();
  renderModeButtons();
  buildFeatureToggleList();
  renderSlideTextBackendOptions();
  buildQuestionPresetChips();
  buildQuestionPresetEditor();
  rerenderGpuTunnelStatus();
}

// 선택 상자는 스크린리더가 바뀐 값을 읽으므로 화면 알림만 띄운다.
captionLanguageStore.subscribe(({ language }) => {
  applyCaptionLanguageToUi({ language });
  showNotice(t('captionLanguage.changed', { language: CAPTION_LANGUAGE_LABEL_MAP[language] }));
  syncCaptionLanguageUi();
});

buildCaptionLanguageSelect();

// 화면 글자 읽기(VLM·OCR)도 캡션 언어처럼 캡처를 시작할 때 main 에 넘겨 그 회의 동안 쓴다.
// 고른 적이 없으면 main 의 .env 값(SEEON_SLIDE_TEXT_BACKEND)을 보여 주고, 그 값으로 읽는다.
let slideTextBackendDefault = null;

function readShownSlideTextBackend() {
  return slideTextBackendStore.get() || slideTextBackendDefault || SLIDE_TEXT_BACKEND_OPTION_LIST[0];
}

function announceSlideTextBackendLocked() {
  announce(t('slideText.locked'));
}

function blockLockedSlideTextBackendInput(event) {
  if (!captureSource.isActive) return;
  if (event.type === 'keydown' && !CAPTION_LANGUAGE_OPEN_KEY_LIST.includes(event.key)) return;
  event.preventDefault();
  announceSlideTextBackendLocked();
}

function handleChangeSlideTextBackend() {
  const select = $('slideTextBackendSelect');
  if (captureSource.isActive) {
    select.value = readShownSlideTextBackend();
    announceSlideTextBackendLocked();
    return;
  }
  slideTextBackendStore.set(select.value);
}

// 선택지 이름은 캡션 언어가 바뀌면 다시 만든다. 이벤트는 buildSlideTextBackendSelect 에서 한 번만 단다.
function renderSlideTextBackendOptions() {
  const select = $('slideTextBackendSelect');
  if (!select) return;
  select.replaceChildren(...SLIDE_TEXT_BACKEND_OPTION_LIST.map((backend) => {
    const option = document.createElement('option');
    option.value = backend;
    option.textContent = readSlideTextBackendLabel({ backend, t });
    return option;
  }));
  syncSlideTextBackendUi();
}

function buildSlideTextBackendSelect() {
  const select = $('slideTextBackendSelect');
  if (!select) return;
  select.addEventListener('mousedown', blockLockedSlideTextBackendInput);
  select.addEventListener('keydown', blockLockedSlideTextBackendInput);
  select.addEventListener('change', handleChangeSlideTextBackend);
  renderSlideTextBackendOptions();
}

function syncSlideTextBackendUi() {
  const select = $('slideTextBackendSelect');
  if (!select) return;
  select.value = readShownSlideTextBackend();
  select.setAttribute('aria-disabled', String(Boolean(captureSource.isActive)));
}

slideTextBackendStore.subscribe(({ backend }) => {
  showNotice(t('slideText.changed', { backend: readSlideTextBackendLabel({ backend, t }) }));
  syncSlideTextBackendUi();
});

buildSlideTextBackendSelect();
window.seeon.getSlideTextBackendDefault?.()
  .then(({ backend } = {}) => {
    slideTextBackendDefault = backend || null;
    syncSlideTextBackendUi();
  })
  .catch(() => {});

// 지난 회의: 사용자 문서 폴더(SEEON 회의 기록)에 날짜별로 남긴 요약·대화 스크립트를 앱 안에서 읽는다.
function setArchiveStatus(text) {
  $('archiveStatus').textContent = text;
}

async function showArchiveList() {
  $('archiveDetail').hidden = true;
  const list = $('archiveList');
  list.hidden = false;
  list.replaceChildren();
  setArchiveStatus(t('archive.loading'));
  const result = await window.seeon.listMeetingArchive().catch(() => null);
  const meetingList = result?.isOk ? result.meetingList : [];
  if (!result?.isOk) { setArchiveStatus(t('archive.loadFailed')); return; }
  if (!meetingList.length) { setArchiveStatus(t('archive.empty')); return; }
  for (const meeting of meetingList) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = formatMeetingLabel({ meeting, t });
    button.addEventListener('click', () => showArchiveMeeting({ id: meeting.id }));
    item.append(button);
    list.append(item);
  }
  setArchiveStatus(t('archive.listReady', { count: meetingList.length }));
  list.querySelector('button')?.focus();
}

// 지난 회의 상세의 제목과 요약 칸. 제목도 요약 상태(만드는 중·실패)를 읽는다.
function fillArchiveDetailSummary({ result }) {
  $('archiveDetailTitle').textContent = formatMeetingLabel({
    meeting: { ...result.meeting, hasSummary: Boolean(result.summaryText) }, t,
  });
  $('archiveSummary').textContent = pickArchiveSummaryText({
    summaryText: result.summaryText, summaryStatus: result.meeting.summaryStatus, t,
  });
}

async function showArchiveMeeting({ id }) {
  const result = await window.seeon.readMeetingArchive({ id }).catch(() => null);
  if (!result?.isOk) { setArchiveStatus(result?.message || t('archive.readFailed')); return; }
  $('archiveList').hidden = true;
  $('archiveDetail').hidden = false;
  $('archiveDetail').dataset.meetingId = id;
  $('archiveDetail').dataset.sessionId = result.meeting.sessionId || '';
  $('archiveScript').textContent = result.scriptText || t('archive.noScript');
  fillArchiveDetailSummary({ result });
  setArchiveStatus(t('archive.detailOpened'));
  $('archiveDetailTitle').focus();
}

// 요약이 저장·실패한 뒤 열려 있는 상세의 제목·요약 칸만 다시 채운다. 읽던 자리를 잃지 않게 포커스는 옮기지 않는다.
async function refreshArchiveDetailSummary({ id }) {
  const result = await window.seeon.readMeetingArchive({ id }).catch(() => null);
  if (!result?.isOk || $('archiveDetail').hidden || $('archiveDetail').dataset.meetingId !== id) return;
  fillArchiveDetailSummary({ result });
}

// 요약 저장·실패·음성 저장 고지. 지난 회의 창은 showModal 로 열려 창 밖 안내(#srAnnounce)가 스크린리더에 막힐 수 있어,
// 창이 열려 있으면 창 안 상태 줄(aria-live)에도 쓰고 그 회의 상세가 열려 있으면 요약 칸을 다시 채운다.
function announceSummaryNotice({ text, sessionId = null }) {
  announce(text);
  if (!$('archiveModal').open) return;
  setArchiveStatus(text);
  const meetingId = pickArchiveRefreshMeetingId({
    isDetailShown: !$('archiveDetail').hidden,
    detailMeetingId: $('archiveDetail').dataset.meetingId || null,
    detailSessionId: $('archiveDetail').dataset.sessionId || null,
    summarySessionId: sessionId,
  });
  if (meetingId) refreshArchiveDetailSummary({ id: meetingId });
}

// 개발자 모드: 로고를 2초 안에 5번 누르면 이번 회의의 파이프라인 흐름 창(단계별 통과/미통과)을 열고,
// 설정 패널에 개발자 진단 영역(캡션 파이프라인·화면 글자 읽기·캡처 상태)을 보인다. 앱을 다시 켜면 다시 숨는다.
const logoTapCounter = createLogoTapCounter();
$('brandLogo').addEventListener('click', () => {
  if (!logoTapCounter.tap()) return;
  $('devSettingsSection').hidden = false;
  window.seeon.openDevFlow().catch(() => {});
});

$('archiveBtn').addEventListener('click', () => {
  $('archiveModal').showModal();
  showArchiveList();
});
$('archiveCloseBtn').addEventListener('click', () => $('archiveModal').close());
$('archiveBackBtn').addEventListener('click', () => showArchiveList());
$('archiveFolderBtn').addEventListener('click', async () => {
  const id = $('archiveDetail').hidden ? null : $('archiveDetail').dataset.meetingId;
  const result = await window.seeon.openMeetingArchiveFolder({ id }).catch(() => null);
  if (!result?.isOk) setArchiveStatus(result?.message || t('archive.folderFailed'));
});

// 화면 공유가 검게 보일 때 Meet 화면만 다시 불러온다. 회의 중이었다면 다시 참여해야 한다.
$('meetReloadBtn').addEventListener('click', () => {
  window.seeon.reloadMeet().catch(() => showNotice(t('meetReload.failed')));
});
window.seeon.onMeetReloaded(({ reason, target }) => {
  const notice = buildMeetReloadNotice({ target, isCaptureActive: captureSource.isActive, t });
  showNotice(notice);
  announce(notice);
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: 'Meet 화면 새로고침',
    detail: `경로=${reason} · 대상=${target} · 캡처=${captureSource.isActive ? '진행 중' : '꺼짐'}`,
  });
});

// GPU 서버 터널 상태: 처음 한 번 물어 오고, 이후에는 main 이 바뀔 때마다 알려 준다.
// 캡션 언어가 바뀌면 마지막으로 받은 상태를 그 언어로 다시 쓴다.
let lastGpuTunnelStatus = null;

function renderGpuTunnelStatus(snapshot) {
  lastGpuTunnelStatus = snapshot;
  $('stGpuTunnel').textContent = describeGpuTunnelStatus({ ...snapshot, t }) || '–';
}

function rerenderGpuTunnelStatus() {
  if (lastGpuTunnelStatus) renderGpuTunnelStatus(lastGpuTunnelStatus);
}
window.seeon.getGpuTunnelStatus().then(renderGpuTunnelStatus).catch(() => {});
window.seeon.onGpuTunnelStatus(renderGpuTunnelStatus);

// 실제 키 입력은 main 이 먼저 받아 막는다(before-input-event). 여기는 main 을 거치지 않은 입력용이다.
// 글자 키는 Control 만(맥 Cmd+Q·W 는 그대로), 숫자 키는 Control·Cmd 둘 다 받는다.
document.addEventListener('keydown', (event) => {
  if (event.altKey || event.shiftKey || event.repeat) return;
  const featureKey = event.ctrlKey && !event.metaKey ? readFeatureKeyFromCode(event.code) : null;
  if (featureKey) {
    event.preventDefault();
    toggleFeature({ key: featureKey });
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === SUMMARY_TOGGLE_KEY) {
    event.preventDefault();
    toggleFeature({ key: FEATURE_KEY_MAP.meetingSummary });
    return;
  }
  const slot = readQuestionPresetSlotFromKey(event.key);
  if (!slot) return;
  event.preventDefault();
  askQuestionPreset({ slot });
});

const GAP_SAFETY_MS = 2000;

function toNarrationType({ source }) {
  return source === CAPTION_SOURCE_TRANSITION ? NARRATION_TYPE_MAP.pageTransition : source;
}

function isAudioGapActiveNow() {
  return isAudioGapActive({
    gapSource, hasDelayBuffer: Boolean(delayBuffer), delayMs: delayBuffer?.targetDelayMs ?? 0,
  });
}

function collectInsertionGapList({ triggerVideoTimeMs, fromVideoTimeMs, toVideoTimeMs }) {
  return buildInsertionGapList({
    isActive: isAudioGapActiveNow(),
    asrList: gapCandidateStore.getCandidateList({ triggerVideoTimeMs, fromVideoTimeMs, toVideoTimeMs }),
    spanList: silenceSpanTracker.getSpanList(), segmentList: asrSegmentTimeline.getSegmentList(),
    isTranscribedAt: (videoTimeMs) => asrSegmentTimeline.isTranscribedAt(videoTimeMs),
    isMeasuredAt: (videoTimeMs) => silenceSpanTracker.isMeasuredAt(videoTimeMs),
    triggerVideoTimeMs, fromVideoTimeMs, toVideoTimeMs,
  });
}

const SNAP_REASON_LABEL_MAP = {
  [SNAP_REASON_MAP.inSilence]: '같은 무음 안에서 보호 간격·재생 헤드 뒤로',
  [SNAP_REASON_MAP.snapped]: '말하는 자리라 3초 안의 다음 무음으로',
};

// 넣기 직전에 그 자리가 조용한지 다시 본다(audio·품질·균형일 때만). 틈이 없어 트리거 지점에 넣거나 답이 늦어
// 재생이 고른 자리를 지나쳤을 때 말 한가운데서 멈추지 않게 한다. 옮길 무음이 없으면 그대로 둔다.
function snapInsertionToSilence({ targetMs, payload, narrationType }) {
  const { insertMs, reason } = resolveInsertionTargetMs({
    isActive: isAudioGapActiveNow(), targetMs, playheadMs: delayBuffer?.getDelayedTimeMs(),
    liveMs: captureSource.videoTimeMs, spanList: silenceSpanTracker.getSpanList(),
  });
  if (insertMs === targetMs) return targetMs;
  const shiftSec = (insertMs - targetMs) / 1000;
  markDebug({
    stage: DEBUG_STAGE_MAP.gap, verdict: DEBUG_VERDICT_MAP.info, narrationType,
    reason: `넣기 직전 자리 옮김 — ${SNAP_REASON_LABEL_MAP[reason]}`,
    detail: `"${payload.text}" · ${Math.round(targetMs)}ms → ${Math.round(insertMs)}ms (+${shiftSec.toFixed(1)}초)`,
  });
  return insertMs;
}

async function resolveInsertionTimeMs({ payload, captionCaptureMs }) {
  if (!delayBuffer || !Number.isFinite(captionCaptureMs)) return captionCaptureMs;
  const narrationType = toNarrationType({ source: payload.source });
  const gapList = collectInsertionGapList({
    triggerVideoTimeMs: captionCaptureMs,
    fromVideoTimeMs: resolveGapSearchFromMs({
      eventVideoTimeMs: captionCaptureMs,
      delayedTimeMs: delayBuffer.getDelayedTimeMs(),
      safetyMs: GAP_SAFETY_MS,
      isBeforeAllowed: narrationType === NARRATION_TYPE_MAP.speakerIdentity,
    }),
    toVideoTimeMs: captureSource.videoTimeMs,
  });
  if (!gapList.length) {
    markDebug({
      stage: DEBUG_STAGE_MAP.gap, verdict: DEBUG_VERDICT_MAP.skip, narrationType,
      reason: '후보 틈 없음 → 트리거 지점 삽입',
      detail: `"${payload.text}" · 재생 ${Math.round(delayBuffer.getDelayedTimeMs())}ms`
        + ` · 트리거 ${Math.round(captionCaptureMs)}ms`,
    });
    return snapInsertionToSilence({ targetMs: captionCaptureMs, payload, narrationType });
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
  if (!chosen) return snapInsertionToSilence({ targetMs: captionCaptureMs, payload, narrationType });
  console.log(`[gap] 삽입 위치 ${Math.round(captionCaptureMs)}ms → ${Math.round(chosen.videoTimeMs)}ms`
    + ` (${chosen.offsetMs >= 0 ? '+' : ''}${(chosen.offsetMs / 1000).toFixed(1)}초, ${result.source}) "${result.reason}"`);
  return snapInsertionToSilence({ targetMs: chosen.videoTimeMs, payload, narrationType });
}

// 사진 단독 묘사처럼 전환 고지에 딸려 오는 캡션.
function isTransitionFollower(payload) {
  return payload.source !== CAPTION_SOURCE_TRANSITION
    && payload.narrationClass === NARRATION_CLASS_MAP.pageTransition
    && Boolean(payload.slideLabel);
}

function isSpeakerCaption(payload) {
  return payload.narrationClass === NARRATION_CLASS_MAP.speakerIdentity;
}

async function emitCaption(payload, { leaderHandle = null } = {}) {
  const isFollower = isTransitionFollower(payload);
  const isSpeaker = isSpeakerCaption(payload);
  if (isSpeaker && pendingTransitions.hasPending) {
    markDebug({
      stage: DEBUG_STAGE_MAP.queue, verdict: DEBUG_VERDICT_MAP.info,
      narrationType: NARRATION_TYPE_MAP.speakerIdentity,
      reason: '진행 중인 화면 전환 고지 뒤로 화자 안내를 미룸',
      detail: `"${payload.text}"`,
    });
  }
  const transitionLeaderList = isSpeaker ? await pendingTransitions.waitAll() : [];
  const leader = isFollower ? await transitionOrderGate.waitLeader({ slideLabel: payload.slideLabel }) : null;
  if (isFollower && leader.status === LEADER_STATUS_MAP.cancelled) {
    reportUnplayedNarration({ entry: toNarrationEntry(payload), reason: QUEUE_DROP_REASON_MAP.leaderCancelled });
    return;
  }
  const captionCaptureMs = handleCaption(payload);
  // 소리는 아직 없다. 재생 차례가 가까우면 미리 만들고, 아니면 대기 줄이 고를 때 만든다(narrationAudio).
  const entry = {
    ...toNarrationEntry(payload), eventTimeMs: captionCaptureMs,
  };
  narrationAudio.register(entry);
  if (isImmediateCaption(payload)) {
    leaderHandle?.settle({ status: LEADER_STATUS_MAP.unscheduled });
    getNarrationPlayer()?.queueCaption({ ...entry, dueAt: performance.now() });
    return;
  }
  const ownInsertVideoTimeMs = isFollower
    ? resolveFollowerInsertMs({ eventVideoTimeMs: captionCaptureMs, leader })
    : isAnchoredCaption(payload) ? captionCaptureMs : await resolveInsertionTimeMs({ payload, captionCaptureMs });
  const insertVideoTimeMs = isSpeaker
    ? resolveAfterTransitionInsertMs({ insertVideoTimeMs: ownInsertVideoTimeMs, leaderList: transitionLeaderList })
    : ownInsertVideoTimeMs;
  leaderHandle?.settle({ status: LEADER_STATUS_MAP.scheduled, insertVideoTimeMs });
  if (insertVideoTimeMs === null) {
    reportUnplayedNarration({ entry, reason: QUEUE_DROP_REASON_MAP.leaderCancelled });
    return;
  }
  scheduleNarration({ entry, captionCaptureMs: insertVideoTimeMs });
}

function emitCaptionSafely(payload, { leaderHandle = null } = {}) {
  emitCaption(payload, { leaderHandle }).catch((error) => {
    leaderHandle?.settle({ status: LEADER_STATUS_MAP.unscheduled });
    console.warn('[caption] 발행 실패(무시):', error.message);
    reportUnplayedNarration({ entry: toNarrationEntry(payload), reason: QUEUE_DROP_REASON_MAP.emitFailed });
  });
}

function applyCaption(payload) {
  const isTransition = payload.source === CAPTION_SOURCE_TRANSITION;
  if (!isTransition || !payload.slideLabel) { emitCaptionSafely(payload); return; }
  const orderHandle = transitionOrderGate.registerLeader({ slideLabel: payload.slideLabel });
  const leaderHandle = {
    settle: (result) => {
      orderHandle.settle(result);
      pendingTransitions.settle({ slideLabel: payload.slideLabel, ...result });
    },
  };
  const state = slideDwellGate.getState({ label: payload.slideLabel });
  if (state === DWELL_STATE_MAP.waiting) {
    console.log(`[slide] 고지 보류 — 슬라이드 ${payload.slideLabel} 체류 판정 대기 중`);
  }
  slideDwellGate.whenResolved({
    label: payload.slideLabel,
    callback: (isSatisfied) => {
      if (isSatisfied) { emitCaptionSafely(payload, { leaderHandle }); return; }
      leaderHandle.settle({ status: LEADER_STATUS_MAP.cancelled });
      reportUnplayedNarration({ entry: toNarrationEntry(payload), reason: QUEUE_DROP_REASON_MAP.dwellCancelled });
    },
  });
}

window.seeon.onPipelineEvent((payload) => {
  if (payload.type === 'asr') { handleAsrTranscript(payload); return; }
  if (payload.type === 'debug') return;
  if (payload.type !== 'caption') return;
  applyCaption(payload);
});

// 요약 시작·저장·실패 고지는 requestMeetingSummary 가 띄운다. 음성은 글을 저장한 뒤 따로 만들어지므로 그 저장만 여기서 알린다.
window.seeon.onSummaryProgress(({ stage, message, sessionId }) => {
  if (stage === SUMMARY_STAGE_MAP.audioDone) announceSummaryNotice({ text: t('summary.audioSaved'), sessionId });
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '회의 요약 진행', detail: message,
  });
});

function scheduleNarration({ entry, captionCaptureMs }) {
  if (delayBuffer) {
    const excessMs = delayBuffer.getExcessMs();
    if (isCaptionDroppable({ excessMs, dropThresholdMs: EXCESS_DROP_MS })) {
      console.log(`[delay] 캡션 드롭 — 누적 지연 ${Math.round(excessMs)}ms (상한 ${EXCESS_DROP_MS}ms)`);
      reportUnplayedNarration({
        entry, reason: QUEUE_DROP_REASON_MAP.delayExceeded,
        detailSuffix: ` · 초과 ${Math.round(excessMs)}ms / 상한 ${EXCESS_DROP_MS}ms · 모드=${getCurrentMode()}`,
      });
      return;
    }
  }
  if (!narrationScheduler || !Number.isFinite(captionCaptureMs)) {
    narrationGate.submit({ ...entry, dueAt: performance.now() });
    return;
  }
  const waitMs = Math.max(0, captionCaptureMs - delayBuffer.getDelayedTimeMs());
  if (waitMs > 0) {
    console.log(`[delay] 캡션 삽입 대기 ~${Math.round(waitMs)}ms (영상 ${Math.round(captionCaptureMs)}ms 지점)`);
  }
  narrationScheduler.schedule({ entry, captionCaptureMs });
}

function toNarrationEntry(payload) {
  return {
    narrationClass: payload.narrationClass, slideLabel: payload.slideLabel ?? null,
    source: payload.source, text: payload.text, ts: payload.ts,
  };
}

// 사용자가 듣지 못한 해설. main 은 해설을 내보낼 때 이미 "말했음"(간격 억제·중복·재설명 금지·맥락 저장소)으로 적어 두므로,
// 재생하지 못하고 버리는 모든 경로는 여기로 알려 그 기록을 되돌린다. 미리 만들던 소리 자리도 다음 해설에 넘긴다.
function reportUnplayedNarration({ entry, reason, waitedMs = null, detailSuffix = '' }) {
  narrationAudio.discard(entry);
  window.seeon.reportNarrationDropped({
    ts: entry.ts, text: entry.text, slideLabel: entry.slideLabel, source: entry.source,
    narrationClass: entry.narrationClass, reason,
  });
  const label = QUEUE_DROP_LABEL_MAP[reason] || reason;
  const waitedText = Number.isFinite(waitedMs) ? ` · 대기 ${(waitedMs / 1000).toFixed(1)}초` : '';
  console.log(`[queue] ${label} [${entry.narrationClass}] "${entry.text}"${waitedText}${detailSuffix}`);
  markDebug({
    stage: DEBUG_STAGE_MAP.queue, verdict: DEBUG_VERDICT_MAP.skip,
    narrationType: entry.source || null,
    reason: label,
    detail: `"${entry.text}" · 분류=${entry.narrationClass}`
      + `${entry.slideLabel !== null && entry.slideLabel !== undefined ? ` · 슬라이드 ${entry.slideLabel}` : ''}${waitedText}${detailSuffix}`,
  });
}

// 재생 대기 줄에서 버려지거나 질문 답에 끊긴 해설.
function handleNarrationDrop({ entry, reason, waitedMs = null }) {
  reportUnplayedNarration({ entry, reason, waitedMs });
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
  // 해설 소리는 측정 신호(라이브 회의 소리)에 섞이지 않으므로 해설 중에도 무음을 잰다.
  silenceSpanTracker.update({ videoTimeMs: captureSource.videoTimeMs, level: audioMeter.sampleLevel() });
  if (isNarrationEchoWindow()) { lastSpeechBlindAt = performance.now(); return; }
  const nowPerf = performance.now();
  if (audioMeter.getLevel() > AUDIO_SPEAK_THRESHOLD) lastAudioActiveAt = nowPerf;
  // 해설 재생 구간은 lastSpeechBlindAt 으로 말소리가 이어진 것으로 본다. 그래서 해설이 끝난 뒤부터 무음을 센다.
  const lastHeardAt = Math.max(lastAudioActiveAt, lastSpeechBlindAt);
  const isMicQuestionActive = Boolean(micQuestionController) && micQuestionController.phase !== MIC_PHASE_MAP.idle;
  if (silenceTrigger.update({ nowPerf, lastHeardAt, isSuspended: isExperimentPaused || isMicQuestionActive })) {
    handleSilenceTrigger({ silenceMs: nowPerf - lastHeardAt }).catch((error) => {
      console.warn('[silence] 무발화 처리 오류', error);
    });
  }
}, 100);

async function handleSilenceTrigger({ silenceMs }) {
  if (!isPipelineEnabled()) return;
  const sessionSeq = experimentSeq;
  const slideLabel = slideRegistry.currentLabel();
  const recentTranscript = transcriptWindow.getBefore({
    nowTs: performance.now(), windowMs: SILENCE_TRANSCRIPT_WINDOW_MS,
  });
  const wordBudget = computeSilenceWordBudget({ mode: getCurrentMode() });
  const precondition = evaluateSilencePrecondition({ slideLabel, recentTranscript, wordBudget });
  const silenceLog = `무음 ${Math.round(silenceMs / 1000)}초 · 슬라이드=${slideLabel || '-'} · 모드=${getCurrentMode()}`;
  if (!precondition.isReady) {
    markDebug({
      stage: DEBUG_STAGE_MAP.silence, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.visualDescription,
      reason: SILENCE_SKIP_LABEL_MAP[precondition.reason], detail: silenceLog,
    });
    return;
  }
  const buffer = await captureFrameJpeg();
  // 캡처를 기다리는 사이 정지·재시작했으면 이전 세션의 무음이라 보내지 않는다.
  if (!captureSource.isActive || sessionSeq !== experimentSeq || isExperimentPaused) return;
  if (!buffer) {
    markDebug({
      stage: DEBUG_STAGE_MAP.silence, verdict: DEBUG_VERDICT_MAP.skip,
      narrationType: NARRATION_TYPE_MAP.visualDescription,
      reason: SILENCE_SKIP_LABEL_MAP.no_screen, detail: `${silenceLog} · 화면 캡처 실패`,
    });
    return;
  }
  await window.seeon.sendPipelineSilence({
    ts: Date.now(), buffer, slideLabel, recentTranscript, silenceMs, wordBudget,
    eventVideoTimeMs: captureSource.videoTimeMs,
  });
}

function setToggleUi(isRunning) {
  $('toggleBtn').textContent = t(isRunning ? 'capture.stop' : 'capture.start');
  $('toggleBtn').classList.toggle('on', isRunning);
  $('live').classList.toggle('on', isRunning);
  $('liveState').textContent = isRunning ? 'LIVE' : t('capture.idle');
  const railLabel = t(isRunning ? 'capture.railActive' : 'capture.idle');
  $('railLive').classList.toggle('on', isRunning);
  $('railLive').setAttribute('aria-label', railLabel);
  $('railLive').title = railLabel;
}

function setPauseUi(isPaused) {
  $('pauseBtn').textContent = t(isPaused ? 'capture.resume' : 'capture.pause');
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
  // 녹음 중인 질문은 버린다. 두면 일시정지 중에 받아쓰기·답을 GPU 로 보낸다.
  micQuestionController.cancel();
  stopNarrationPlayer();
  setPauseUi(true);
  $('stCapture').textContent = t('status.paused');
}

function resumeExperiment() {
  if (!captureSource.isActive || !isExperimentPaused) return;
  isExperimentPaused = false;
  const { stream, liveVideo } = captureSource;
  startNarrationPlayer({ stream });
  delayBuffer?.release();
  pointingLocator.reset();
  recentPointingMemory.reset();
  pointingMotionTracker.reset();
  screenChangeDetector?.reset();
  silenceTrigger.reset({ nowPerf: performance.now() });

  lastPointingMotionAt = -Infinity;
  pointingSampleTimer = setInterval(samplePointingFrame, POINTING_SAMPLE_MS);
  speakerPollTimer = setInterval(pollSpeakerIdentity, SPEAKER_POLL_MS);
  asrSegmenter.start(stream);
  liveVideo?.play().catch(() => {});
  setPauseUi(false);
  $('stCapture').textContent = t('status.playing');
}

async function attemptStartExperiment() {
  if (!isCaptureStartable() || captureSource.isActive) return;
  $('toggleBtn').disabled = true;
  try {
    showNotice(t('notice.captureStarted'));
    // 꺼 둔 기능과 고른 캡션 언어는 다음 실행에도 남는다. 모르고 회의를 듣지 않게 시작할 때 알린다.
    // 연달아 announce 하면 앞 문구가 스크린리더에서 묻히므로 한 번에 읽는다.
    const startNoticeList = [];
    const languageNotice = describeNonDefaultCaptionLanguage({ language: captionLanguageStore.get(), t });
    if (languageNotice) startNoticeList.push(t('captionLanguage.startNotice', { notice: languageNotice }));
    const disabledFeatureNotice = describeDisabledFeatureNotice({ store: featureToggleStore, t });
    if (disabledFeatureNotice) startNoticeList.push(disabledFeatureNotice);
    if (startNoticeList.length) announce(startNoticeList.join(' '));

    const sessionResult = await window.seeon.startPipelineSession({
      mode: getCurrentMode(), captionLanguage: captionLanguageStore.get(), slideTextBackend: slideTextBackendStore.get(),
      isMeetingSummaryEnabled: featureToggleStore.isOn(FEATURE_KEY_MAP.meetingSummary),
    }).catch(() => null);
    currentSessionId = sessionResult?.sessionId || null;
    gapSource = sessionResult?.gapSource === GAP_CANDIDATE_SOURCE_MAP.audio
      ? GAP_CANDIDATE_SOURCE_MAP.audio : GAP_CANDIDATE_SOURCE_MAP.asr;
    const screenChangeMode = sessionResult?.screenChange?.mode;
    screenChangeSession = screenChangeMode && screenChangeMode !== SCREEN_CHANGE_MODE_OFF ? sessionResult.screenChange : null;
    screenChangeDetector = screenChangeSession ? createScreenChangeDetector() : null;
    screenChangeSlideStart = null;
    screenChangeSkipCountMap = {};
    lastScreenChangeSkipFlushAt = performance.now();

    const contextPolicy = getModePolicy({ mode: getCurrentMode() });
    const lookaheadMs = computeLookaheadMs({ mode: getCurrentMode() });
    const holdMs = computeContextHoldMs({ mode: getCurrentMode() });
    candidateScheduler.setLookaheadMs({ lookaheadMs });
    candidateScheduler.setSentenceWaitMs({ sentenceWaitMs: computeSentenceWaitMs({ mode: getCurrentMode() }) });
    candidateScheduler.setHoldMs({ holdMs });

    asrSegmenter.setSegmentMs({
      segmentMs: contextPolicy?.asrSegmentMs, minSegmentMs: contextPolicy?.asrMinSegmentMs,
    });

    lastScreenTransitionAt = performance.now();
    experimentSeq += 1;
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '캡처 시작',
      detail: `모드=${getCurrentMode()} · 시작 시점 = 회의 시작 시점(0초)`
        + ` · 앞 맥락 ${describeBeforeWindow({ mode: getCurrentMode(), anchorTs: lastScreenTransitionAt })}`
        + ` · 뒤 맥락 ${Math.round((contextPolicy?.afterMs ?? 0) / 1000)}초`
        + ` (ASR 청크 ${contextPolicy?.asrSegmentMs}ms(무음 절단 ${contextPolicy?.asrMinSegmentMs}ms 이후)`
        + ` + look-ahead ${lookaheadMs}ms + 보류 ${holdMs}ms) · 틈 후보=${gapSource}`,
    });

    const { audioTrack } = await captureSource.start();
    const { stream, liveVideo } = captureSource;
    const settings = stream.getVideoTracks()[0].getSettings();
    $('stCapture').textContent = t(audioTrack ? 'status.playingWithAudio' : 'status.playingVideoOnly');
    $('stRes').textContent = `${settings.width ?? liveVideo.videoWidth}×${settings.height ?? liveVideo.videoHeight}`;

    startDelayBufferIfNeeded();

    audioMeter.start(stream);
    startNarrationPlayer({ stream });
    boundaryDetector.reset();
    silenceTrigger.reset({ nowPerf: performance.now() });
    candidateScheduler.reset();
    pointingLocator.reset();
    recentPointingMemory.reset();
    pointingMotionTracker.reset();
    lastPointingMotionAt = -Infinity;

    roiStore.reset();
    lastScreenGeneration = 0;
    roiChangeSuppressUntil = 0;
    histogramGate.reset();
    slideCandidateGate.reset();
    slideRegistry.reset();
    slideEventVideoTimeMap.clear();
    slideTransitionWallTsMap.clear();
    slideTransitionRequestTsMap.clear();
    transitionOrderGate.reset();
    pendingTransitions.reset();
    slideDwellGate.reset();
    isConfirmingSlide = false;
    hasWarnedLocalEmbedding = false;
    transcriptWindow.reset();
    gapCandidateStore.reset();
    silenceSpanTracker.reset();
    asrSegmentTimeline.reset();
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
    syncFeatureToggleUi();
    syncCaptionLanguageUi();
    syncSlideTextBackendUi();
    renderModeButtons();

    if (!audioTrack) {
      showModal({
        title: t('modal.noAudioTitle'),
        message: t('modal.noAudioMessage'),
        buttons: [{ label: t('common.close'), secondary: true }],
      });
    }
  } catch (err) {
    stopExperiment();
    $('stCapture').textContent = t('status.captureFailed', { message: err.message });
    showModal({
      title: t('modal.captureFailedTitle'),
      message: t('modal.captureFailedMessage', { errorName: err.name, errorMessage: err.message }),
      buttons: [{ label: t('common.close'), secondary: true }],
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
    ['후보 스케줄러', () => candidateScheduler.reset()],
    ['마이크 질문', () => micQuestionController.cancel()],
    ['해설 보류 게이트', () => {
      for (const entry of narrationGate.clear()) reportUnplayedNarration({ entry, reason: QUEUE_DROP_REASON_MAP.stopped });
      narrationAudio.reset();
    }],
    ['인접 발화 창', () => transcriptWindow.reset()],
    ['삽입 후보 틈', () => {
      gapCandidateStore.reset();
      silenceSpanTracker.reset();
      asrSegmentTimeline.reset();
    }],
    ['프레임 샘플러', () => {
      if (pointingSampleTimer) { clearInterval(pointingSampleTimer); pointingSampleTimer = null; }
    }],
    ['발화자 폴링', () => {
      if (speakerPollTimer) { clearInterval(speakerPollTimer); speakerPollTimer = null; }
    }],
    ['포인팅 로컬라이저', () => { pointingLocator.reset(); recentPointingMemory.reset(); pointingMotionTracker.reset(); }],
    ['화면 변화 감지기', () => { screenChangeDetector = null; screenChangeSession = null; screenChangeSlideStart = null; }],
    ['슬라이드 히스토그램 게이트', () => { histogramGate.reset(); slideCandidateGate.reset(); }],
    ['슬라이드 레지스트리', () => {
      slideRegistry.reset(); slideEventVideoTimeMap.clear(); slideTransitionWallTsMap.clear(); transitionOrderGate.reset();
      slideTransitionRequestTsMap.clear(); pendingTransitions.reset();
    }],
    ['전환 체류 게이트', () => slideDwellGate.reset()],
    ['ROI 스토어', () => roiStore.reset()],
    ['발화자 힌트', () => { lastResolvedSpeakerName = ''; lastResolvedSpeakerAt = 0; speakerTimeline.reset(); }],
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
  syncFeatureToggleUi();
  syncCaptionLanguageUi();
  syncSlideTextBackendUi();
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
  if (!featureToggleStore.isOn(FEATURE_KEY_MAP.meetingSummary)) {
    announce(t('summary.off'));
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.skip,
      reason: '회의 요약 꺼짐', detail: '사용자가 요약 기능을 껐습니다',
    });
    return;
  }
  // 요약은 뒤에서 만들어진다. 시작·저장·실패는 화면을 막는 창 없이 고지 줄과 스크린리더 안내로 알린다.
  announce(t('summary.generating'));
  const result = await window.seeon.generateSummary().catch((error) => ({
    isOk: false, message: error.message,
  }));
  if (!result?.isOk) {
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.fail,
      reason: '회의 요약 실패', detail: result?.message || '알 수 없는 오류',
    });
    announceSummaryNotice({
      text: t('summary.failedNotice', { message: result?.message || t('summary.unknownError') }),
      sessionId: result?.sessionId,
    });
    return;
  }
  markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
    reason: '회의 요약 완료',
    detail: `${result.textFilePath}${result.isTruncated ? ' (길이 제한으로 잘림)' : ''}`,
  });
  announceSummaryNotice({ text: t('summary.savedText'), sessionId: result.sessionId });

  console.log(`[summary] 저장 완료 — ${result.textFilePath}`);
}

function handleCaptureEnded() {
  stopExperiment();
  showNotice(t('notice.captureEnded'));
}

function isCaptureStartable() {
  return MEET_MEETING_URL_PATTERN.test(latestMeetUrl) && latestMeetTileCount > 0;
}

function syncToggleAvailability() {
  if (captureSource.isActive) return;
  $('toggleBtn').disabled = !isCaptureStartable();
  $('meetHint').textContent = isCaptureStartable()
    ? t('hint.meetJoined', { count: latestMeetTileCount })
    : t('hint.joinToStart');
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
  // 지금 받을 수 없는 질문이면 까닭만 알리고, 적은 글은 다시 보낼 수 있게 남겨 둔다.
  const blockedTextKey = readQuestionBlockedTextKeyNow();
  if (blockedTextKey) {
    announce(t(blockedTextKey));
    return;
  }
  input.value = '';
  askQuestion({ questionText: text });
}

$('cmdInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submitTypedQuestion(); }
});
$('cmdSend').addEventListener('click', submitTypedQuestion);

// 화면 안내와 함께 스크린리더로도 읽는다. 같은 문구를 연달아 알릴 때도 읽히도록 비웠다가 넣는다.
function announce(text) {
  showNotice(text);
  const region = $('srAnnounce');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = text; });
}

// 마이크 질문(Ctrl+M): 사용자 마이크만 녹음해 별도 경로로 전사한 뒤 자유 질문과 같은 경로로 묻는다.
function setMicUi(isRecording) {
  const mic = $('cmdMic');
  mic.classList.toggle('recording', isRecording);
  mic.setAttribute('aria-pressed', String(isRecording));
}

const meetMicGuard = new MeetMicGuard({
  getSelfMicState: () => roiStore.getSelfMicState(),
  toggleMeetMic: () => window.seeon.toggleMeetMic().catch(() => ({ isOk: false })),
  notify: (text) => announce(text),
  t,
});

async function beginMicQuestionSession() {
  narrationGate.hold();
  await meetMicGuard.muteForRecording();
}

// 녹음을 마친 경우는 답이 나온 뒤(releaseMicAnswerHold) 보류를 푼다. 취소면 바로 푼다.
async function endMicQuestionSession({ isAwaitingAnswer = false } = {}) {
  await meetMicGuard.restoreAfterRecording();
  if (!isAwaitingAnswer) narrationGate.release();
}

// 음성 인식·답 생성이 멈춰도 자동 해설이 계속 막히지 않게 답을 기다리는 시간에 상한을 둔다.
function askQuestionFromAudioWithinHold(event) {
  return Promise.race([askQuestionFromAudio(event), waitFor({ ms: MANUAL_ANSWER_HOLD_MAX_MS })]);
}

async function askQuestionFromAudio({ buffer, startTs }) {
  // 녹음을 마친 뒤 받아쓰기 전에 일시정지했으면 소리를 GPU 로 보내지 않는다.
  const blockedTextKey = readQuestionBlockedTextKeyNow();
  if (blockedTextKey) {
    announce(t(blockedTextKey));
    return;
  }
  announce(t('mic.listening'));
  const result = await window.seeon.sendQuestionAudio({ buffer, startTs }).catch(() => null);
  if (!result?.isOk) {
    announce(t('mic.asrUnavailable'));
    return;
  }
  if (!result.text) {
    announce(t('mic.notUnderstood'));
    return;
  }
  await askQuestion({ questionText: result.text, inputSource: 'mic' });
}

let micQuestionController = null;
const questionRecorder = new QuestionRecorder({
  onFinish: (event) => micQuestionController.handleFinish(event),
  onCancel: (event) => micQuestionController.handleCancel(event),
});
micQuestionController = new MicQuestionController({
  recorder: questionRecorder,
  readStartBlockedTextKey: readQuestionBlockedTextKeyNow,
  beginSession: beginMicQuestionSession,
  endSession: endMicQuestionSession,
  announce,
  setUi: setMicUi,
  onQuestionAudio: askQuestionFromAudioWithinHold,
  onAnswerSettled: () => narrationGate.release(),
  t,
});

$('cmdMic').addEventListener('click', () => { micQuestionController.toggle(); });
window.seeon.onMicToggle(() => { micQuestionController.toggle(); });
// 질문 버튼과 설정의 질문 프리셋 칸은 프리셋 저장소에서 만든다. 버튼 N 번째 = Ctrl+N.
// 기본 프리셋은 캡션 언어의 이름으로, 사용자가 넣은 문구는 그대로 보인다(readQuestionPresetText).
function buildQuestionPresetChips() {
  $('cmdChips').replaceChildren(...questionPresetStore.list().map((preset) => {
    const { slot } = preset;
    const text = readQuestionPresetText({ preset, t });
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.title = `${text} (Ctrl+${slot})`;
    chip.setAttribute('aria-label', t('preset.chipAriaLabel', { text, slot }));
    const keyMark = document.createElement('span');
    keyMark.className = 'chip-key';
    keyMark.textContent = String(slot);
    keyMark.setAttribute('aria-hidden', 'true');
    chip.append(keyMark, text);
    chip.addEventListener('click', () => askQuestionPreset({ slot }));
    return chip;
  }));
}

function createPresetRow({ slot, text = '', isNew = false }) {
  const row = document.createElement('div');
  row.className = 'preset-row';
  const keyLabel = document.createElement('label');
  keyLabel.className = 'preset-key';
  keyLabel.htmlFor = `questionPresetInput${slot}`;
  keyLabel.textContent = `Ctrl+${slot}`;
  keyLabel.setAttribute('aria-hidden', 'true');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'preset-input';
  input.id = `questionPresetInput${slot}`;
  input.maxLength = 100;
  input.value = text;
  input.dataset.presetSlot = String(slot);
  input.dataset.presetRole = 'input';
  input.placeholder = isNew ? t('preset.newPlaceholder') : '';
  input.setAttribute('aria-label', isNew ? t('preset.newAriaLabel', { slot }) : t('preset.inputAriaLabel', { slot }));
  // Enter 뒤에 change 가 한 번 더 올 수 있다. 새 칸은 한 번만 넣는다.
  let isAdded = false;
  const commit = () => {
    // 기본 프리셋은 캡션 언어의 이름으로 보인다. 고치지 않은 채 넣으면 저장된 문구(전용 명령)를 그대로 둔다.
    if (!isNew && input.value.trim() === text) return;
    if (!isNew) { questionPresetStore.setText(slot, input.value); return; }
    if (!isAdded) isAdded = questionPresetStore.add(input.value);
  };
  input.addEventListener('change', commit);
  // 새 칸에서 Enter 로 넣으면 다음 새 칸으로 초점을 옮겨 이어서 넣게 한다.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (isNew && input.value.trim()) pendingPresetFocus = { slot: slot + 1, role: 'input' };
    commit();
  });
  row.append(keyLabel, input);
  if (!isNew) {
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'preset-remove';
    removeButton.textContent = '×';
    removeButton.dataset.presetSlot = String(slot);
    removeButton.dataset.presetRole = 'remove';
    removeButton.setAttribute('aria-label', t('preset.removeAriaLabel', { slot }));
    removeButton.addEventListener('click', () => {
      pendingPresetFocus = { slot, role: 'input' };
      questionPresetStore.remove(slot);
      announce(t('preset.removed', { slot }));
    });
    row.append(removeButton);
  }
  return row;
}

let pendingPresetFocus = null;

// 다시 그려도 스크린리더 초점이 같은 번호의 칸에 남게 한다.
function buildQuestionPresetEditor() {
  const container = $('questionPresetList');
  const active = document.activeElement;
  const focusTarget = pendingPresetFocus
    || (container.contains(active) && active.dataset.presetSlot
      ? { slot: Number(active.dataset.presetSlot), role: active.dataset.presetRole } : null);
  pendingPresetFocus = null;
  const presetList = questionPresetStore.list();
  const rowList = presetList.map((preset) => createPresetRow({ slot: preset.slot, text: readQuestionPresetText({ preset, t }) }));
  if (presetList.length < MAX_QUESTION_PRESET_COUNT) rowList.push(createPresetRow({ slot: presetList.length + 1, isNew: true }));
  container.replaceChildren(...rowList);
  if (!focusTarget) return;
  const target = container.querySelector(`[data-preset-slot="${focusTarget.slot}"][data-preset-role="${focusTarget.role}"]`)
    || container.querySelector(`[data-preset-slot="${focusTarget.slot}"]`);
  target?.focus();
}

// change 는 초점이 다른 칸으로 옮겨 가기 전에 온다. 옮겨 간 뒤에 다시 그려야 Tab 으로 옮긴 초점을 빼앗지 않는다.
questionPresetStore.subscribe(() => {
  buildQuestionPresetChips();
  setTimeout(buildQuestionPresetEditor, 0);
});
$('questionPresetResetBtn').addEventListener('click', () => {
  questionPresetStore.resetToDefault();
  announce(t('preset.resetDone'));
});
buildQuestionPresetChips();
buildQuestionPresetEditor();

// 설정 패널은 버튼 바로 아래에 띄운다. 화면이 좁아 머리줄이 접히면 버튼이 내려가는데,
// 고정 위치로 띄우면 패널이 버튼을 덮어 다시 눌러 닫을 수 없다. Esc·바깥 클릭으로도 닫는다.
function placeSettingsPanel() {
  const panel = $('settingsPanel');
  const { top, right, maxHeight } = computeAnchoredPanelPosition({
    anchorRect: $('settingsBtn').getBoundingClientRect(),
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, panelWidth: panel.offsetWidth,
  });
  panel.style.top = `${top}px`;
  panel.style.right = `${right}px`;
  panel.style.maxHeight = `${maxHeight}px`;
}

function setSettingsPanelOpen(isOpen) {
  const panel = $('settingsPanel');
  panel.hidden = !isOpen;
  $('settingsBtn').classList.toggle('on', isOpen);
  $('settingsBtn').setAttribute('aria-expanded', String(isOpen));
  if (!isOpen) return;
  placeSettingsPanel();
  syncFeatureToggleUi();
  syncCaptionLanguageUi();
  syncSlideTextBackendUi();
}

$('settingsBtn').addEventListener('click', () => setSettingsPanelOpen($('settingsPanel').hidden));
window.addEventListener('resize', () => {
  if (!$('settingsPanel').hidden) placeSettingsPanel();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('settingsPanel').hidden) return;
  setSettingsPanelOpen(false);
  $('settingsBtn').focus();
});
document.addEventListener('pointerdown', (event) => {
  if ($('settingsPanel').hidden) return;
  if ($('settingsPanel').contains(event.target) || $('settingsBtn').contains(event.target)) return;
  setSettingsPanelOpen(false);
});

// 패널 접기·펼치기(Ctrl+B): Meet 화면 폭은 main 이 바꾸고, 여기서는 패널과 띠 중 무엇을 보일지만 바꾼다.
// 화면 낭독기 안내 영역은 패널 밖에 두어 접혀 있어도 해설·안내를 읽는다.
function renderViewerPanel({ isCollapsed }) {
  const hadFocusInPanel = document.querySelector('.app').contains(document.activeElement);
  const hadFocusOnRail = document.activeElement === $('panelExpandBtn');
  if (isCollapsed) setSettingsPanelOpen(false);
  document.body.classList.toggle('panel-collapsed', isCollapsed);
  if (isCollapsed) {
    if (hadFocusInPanel) $('panelExpandBtn').focus();
    return;
  }
  // 접혀 있는 동안 쌓인 기록은 목록이 숨어 있어 아래로 내려가지 않았다.
  $('logStream').scrollTop = $('logStream').scrollHeight;
  if (hadFocusOnRail) $('panelCollapseBtn').focus();
}

function requestViewerPanelCollapsed(isCollapsed) {
  window.seeon.setViewerPanelCollapsed({ isCollapsed }).catch(() => {});
}

$('panelCollapseBtn').addEventListener('click', () => requestViewerPanelCollapsed(true));
$('panelExpandBtn').addEventListener('click', () => requestViewerPanelCollapsed(false));
window.seeon.onViewerPanelChanged(renderViewerPanel);

// 알림 창·지난 회의 창·소리 모으는 중 안내는 패널 안에 뜨므로, 접혀 있으면 펼쳐서 보이게 한다.
const panelPopupObserver = new MutationObserver(() => {
  if (!document.body.classList.contains('panel-collapsed')) return;
  const isPopupShown = $('permModal').open || $('archiveModal').open || !$('prepOverlay').hidden;
  if (isPopupShown) requestViewerPanelCollapsed(false);
});
for (const id of ['permModal', 'archiveModal', 'prepOverlay']) {
  panelPopupObserver.observe($(id), { attributes: true, attributeFilter: ['open', 'hidden'] });
}
