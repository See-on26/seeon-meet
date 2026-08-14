const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seeon', {
  checkOsPermissions() {
    return ipcRenderer.invoke('check-os-permissions');
  },
  openPrivacySettings(pane) {
    ipcRenderer.send('open-privacy-settings', pane);
  },
  saveAudio({ name, buffer }) {
    return ipcRenderer.invoke('save-audio', { name, buffer: new Uint8Array(buffer) });
  },
  saveVideo({ name, buffer }) {
    return ipcRenderer.invoke('save-video', { name, buffer: new Uint8Array(buffer) });
  },
  saveFrame({ name, buffer }) {
    return ipcRenderer.invoke('save-frame', { name, buffer: new Uint8Array(buffer) });
  },
  saveText({ name, text }) {
    return ipcRenderer.invoke('save-text', { name, text });
  },
  saveDeixisFrame({ name, buffer, isGrounded }) {
    return ipcRenderer.invoke('save-deixis-frame',
      { name, buffer: new Uint8Array(buffer), isGrounded });
  },
  showInFolder(filePath) {
    ipcRenderer.send('show-in-folder', filePath);
  },
  sendPipelineAudio(args) { return ipcRenderer.invoke('pipeline-audio', args); },
  sendPipelineFrame({ ts, buffer, slideLabel, wordBudget = null, isRevisit = false, eventVideoTimeMs = null }) {
    return ipcRenderer.invoke('pipeline-frame',
      { ts, buffer: new Uint8Array(buffer), slideLabel, wordBudget, isRevisit, eventVideoTimeMs });
  },
  sendPipelineSpeaker({
    ts, source, buffer = null, speakerName = '', position = '', participantId = '', wordBudget = null,
    eventVideoTimeMs = null,
  }) {
    return ipcRenderer.invoke('pipeline-speaker', {
      ts, source, buffer: buffer ? new Uint8Array(buffer) : null,
      speakerName, position, participantId, wordBudget, eventVideoTimeMs,
    });
  },
  sendPipelineSilence({ ts, buffer, slideLabel, recentTranscript, silenceMs, wordBudget, eventVideoTimeMs = null }) {
    return ipcRenderer.invoke('pipeline-silence', {
      ts, buffer: new Uint8Array(buffer), slideLabel, recentTranscript, silenceMs, wordBudget, eventVideoTimeMs,
    });
  },
  embedFrame({ buffer }) {
    return ipcRenderer.invoke('embed-frame', { buffer: new Uint8Array(buffer) });
  },
  saveSlideFrame({ slideLabel, kind, buffer, sessionId = null }) {
    return ipcRenderer.invoke('save-slide-frame', { slideLabel, kind, buffer: new Uint8Array(buffer), sessionId });
  },
  markSlideFrame(entry) { ipcRenderer.send('pipeline-slide-mark', entry); },
  requestSlideText({ slideLabel, buffer }) {
    return ipcRenderer.invoke('pipeline-slide-text', { slideLabel, buffer: new Uint8Array(buffer) });
  },
  sendPipelineDeixis({ ts, buffer, fullBuffer = null, utterance, recentTranscript, beforeTranscript = '', afterTranscript = '', hasPointingRegion = false, pointingOrderHint = '', slideLabel = null, wordBudgetMap = null, eventVideoTimeMs = null, triggerCandidateList = [], pointingRect = null, frameTs = null }) {
    return ipcRenderer.invoke('pipeline-deixis',
      { ts, buffer: new Uint8Array(buffer), fullBuffer: fullBuffer ? new Uint8Array(fullBuffer) : null, utterance, recentTranscript, beforeTranscript, afterTranscript, hasPointingRegion, pointingOrderHint, slideLabel, wordBudgetMap, eventVideoTimeMs, triggerCandidateList, pointingRect, frameTs });
  },
  // 같은 슬라이드 안 화면 변화 사건. buffer 는 깨끗한 전체 화면(OCR·기준용), vlmBuffer 는 VLM 에 보낼 그림(테두리·잘라 냄)이다.
  sendScreenChange({ ts, slideLabel, buffer, vlmBuffer = null, regionNorm = null, changedRatio = null, cellCount = null,
    firstSeenTs = null, firstSeenVideoTimeMs = null, recentTranscript = '', wordBudget = null, imageMode = null }) {
    return ipcRenderer.invoke('pipeline-screen-change', {
      ts, slideLabel, buffer: new Uint8Array(buffer), vlmBuffer: vlmBuffer ? new Uint8Array(vlmBuffer) : null,
      regionNorm, changedRatio, cellCount, firstSeenTs, firstSeenVideoTimeMs, recentTranscript, wordBudget, imageMode,
    });
  },
  sendScreenChangeBaseline({ ts, slideLabel, buffer, isSlideStart = false, slideStartTs = null, eventVideoTimeMs = null }) {
    return ipcRenderer.invoke('pipeline-screen-change-baseline', {
      ts, slideLabel, buffer: new Uint8Array(buffer), isSlideStart, slideStartTs, eventVideoTimeMs,
    });
  },
  sendPipelineCommand({ ts, buffer, command = null, questionText = null, questionLabel = '', recentTranscript = '', wordBudget = null, eventVideoTimeMs = null }) {
    return ipcRenderer.invoke('pipeline-command',
      { ts, buffer: new Uint8Array(buffer), command, questionText, questionLabel, recentTranscript, wordBudget, eventVideoTimeMs });
  },
  sendPipelineQuestion({ ts, buffer, questionText, wordBudget = null, currentSlideLabel = null, speakerHintNow = null, inputSource = 'typed', eventVideoTimeMs = null, heardWallTs = null, heardVideoTimeMs = null }) {
    return ipcRenderer.invoke('pipeline-question',
      { ts, buffer: new Uint8Array(buffer), questionText, wordBudget, currentSlideLabel, speakerHintNow, inputSource, eventVideoTimeMs, heardWallTs, heardVideoTimeMs });
  },
  sendQuestionAudio({ buffer, startTs }) {
    return ipcRenderer.invoke('pipeline-question-audio', { buffer: new Uint8Array(buffer), startTs });
  },
  onMicToggle(callback) { ipcRenderer.on('mic-toggle', () => callback()); },
  toggleMeetMic() { return ipcRenderer.invoke('meet-mic-toggle'); },
  inferInsertionGap(args) { return ipcRenderer.invoke('pipeline-gap', args); },
  onQuestionPreset(callback) { ipcRenderer.on('question-preset', (_e, payload) => callback(payload)); },
  onSummaryToggle(callback) { ipcRenderer.on('summary-toggle', () => callback()); },
  onFeatureToggle(callback) { ipcRenderer.on('feature-toggle', (_e, payload) => callback(payload)); },
  setFeatureToggles({ disabledClassList }) {
    return ipcRenderer.invoke('pipeline-feature-toggles', { disabledClassList });
  },
  reloadMeet() { return ipcRenderer.invoke('meet-reload'); },
  setViewerPanelCollapsed({ isCollapsed }) { return ipcRenderer.invoke('viewer-panel-set', { isCollapsed }); },
  onViewerPanelChanged(callback) { ipcRenderer.on('viewer-panel-changed', (_e, payload) => callback(payload)); },
  onMeetViewResized(callback) { ipcRenderer.on('meet-view-resized', (_e, payload) => callback(payload)); },
  getGpuTunnelStatus() { return ipcRenderer.invoke('gpu-tunnel-status'); },
  onGpuTunnelStatus(callback) { ipcRenderer.on('gpu-tunnel-status-changed', (_e, payload) => callback(payload)); },
  onMeetReloaded(callback) { ipcRenderer.on('meet-reloaded', (_e, payload) => callback(payload)); },
  onPipelineEvent(callback) { ipcRenderer.on('pipeline-event', (_e, payload) => callback(payload)); },
  onRoiUpdate(callback) { ipcRenderer.on('roi-update', (_e, payload) => callback(payload)); },
  appendBoundaryLog(entry) { ipcRenderer.send('pipeline-boundary', entry); },
  startPipelineSession({ mode, asrLanguage, captionLanguage, slideTextBackend, isMeetingSummaryEnabled }) {
    return ipcRenderer.invoke('pipeline-session-start', {
      mode, asrLanguage, captionLanguage, slideTextBackend, isMeetingSummaryEnabled,
    });
  },
  setMeetingSummaryEnabled({ isEnabled }) {
    return ipcRenderer.invoke('pipeline-set-meeting-summary-enabled', { isEnabled });
  },
  getSlideTextBackendDefault() { return ipcRenderer.invoke('pipeline-slide-text-backend-default'); },
  endPipelineSession() { return ipcRenderer.invoke('pipeline-session-end'); },
  generateSummary() { return ipcRenderer.invoke('summary-generate'); },
  listMeetingArchive() { return ipcRenderer.invoke('meeting-archive-list'); },
  readMeetingArchive({ id }) { return ipcRenderer.invoke('meeting-archive-read', { id }); },
  openMeetingArchiveFolder({ id = null } = {}) { return ipcRenderer.invoke('meeting-archive-open-folder', { id }); },
  onSummaryProgress(callback) { ipcRenderer.on('summary-progress', (_e, payload) => callback(payload)); },
  appendDebugLog(entry) { ipcRenderer.send('pipeline-debug', entry); },
  reportNarrationDropped(payload) { ipcRenderer.send('pipeline-narration-dropped', payload); },
  // 해설이 실제로 들리기 시작한 순간(개발자 모드 흐름 창의 '재생됨').
  reportNarrationPlayback(info) { ipcRenderer.send('pipeline-narration-playback', info); },
  // 개발자 모드: 로고를 연달아 누르면 파이프라인 흐름 창을 연다.
  openDevFlow: () => ipcRenderer.invoke('dev-flow-open'),
  reportTransitionCancelled(payload) { ipcRenderer.send('pipeline-transition-cancelled', payload); },
  synthesizeNarration({ ts, text, source = null }) { return ipcRenderer.invoke('pipeline-tts', { ts, text, source }); },
});
