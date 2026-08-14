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
  sendPipelineFrame({ ts, buffer, slideLabel, wordBudget = null, isRevisit = false }) {
    return ipcRenderer.invoke('pipeline-frame',
      { ts, buffer: new Uint8Array(buffer), slideLabel, wordBudget, isRevisit });
  },
  sendPipelineSpeaker({
    ts, source, buffer = null, speakerName = '', position = '', participantId = '', wordBudget = null,
  }) {
    return ipcRenderer.invoke('pipeline-speaker', {
      ts, source, buffer: buffer ? new Uint8Array(buffer) : null,
      speakerName, position, participantId, wordBudget,
    });
  },
  embedFrame({ buffer }) {
    return ipcRenderer.invoke('embed-frame', { buffer: new Uint8Array(buffer) });
  },
  saveSlideFrame({ slideLabel, kind, buffer, sessionId = null }) {
    return ipcRenderer.invoke('save-slide-frame', { slideLabel, kind, buffer: new Uint8Array(buffer), sessionId });
  },
  markSlideFrame(entry) { ipcRenderer.send('pipeline-slide-mark', entry); },
  sendPipelineDeixis({ ts, buffer, utterance, recentTranscript, beforeTranscript = '', afterTranscript = '', hasPointingRegion = false, pointingOrderHint = '', slideLabel = null, wordBudgetMap = null }) {
    return ipcRenderer.invoke('pipeline-deixis',
      { ts, buffer: new Uint8Array(buffer), utterance, recentTranscript, beforeTranscript, afterTranscript, hasPointingRegion, pointingOrderHint, slideLabel, wordBudgetMap });
  },
  sendPipelineCommand({ ts, buffer, command = null, questionText = null, recentTranscript = '', wordBudget = null }) {
    return ipcRenderer.invoke('pipeline-command',
      { ts, buffer: new Uint8Array(buffer), command, questionText, recentTranscript, wordBudget });
  },
  inferInsertionGap(args) { return ipcRenderer.invoke('pipeline-gap', args); },
  onUserCommand(callback) { ipcRenderer.on('user-command', (_e, payload) => callback(payload)); },
  onSummaryToggle(callback) { ipcRenderer.on('summary-toggle', () => callback()); },
  onPipelineEvent(callback) { ipcRenderer.on('pipeline-event', (_e, payload) => callback(payload)); },
  onRoiUpdate(callback) { ipcRenderer.on('roi-update', (_e, payload) => callback(payload)); },
  appendBoundaryLog(entry) { ipcRenderer.send('pipeline-boundary', entry); },
  startPipelineSession({ mode }) { return ipcRenderer.invoke('pipeline-session-start', { mode }); },
  endPipelineSession() { return ipcRenderer.invoke('pipeline-session-end'); },
  generateSummary() { return ipcRenderer.invoke('summary-generate'); },
  onSummaryProgress(callback) { ipcRenderer.on('summary-progress', (_e, payload) => callback(payload)); },
  appendDebugLog(entry) { ipcRenderer.send('pipeline-debug', entry); },
});
