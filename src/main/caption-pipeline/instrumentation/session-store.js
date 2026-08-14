const { RECORD_KIND_MAP } = require('./record-store');

const ACCUMULATED_KIND_LIST = [
  RECORD_KIND_MAP.asr,
  RECORD_KIND_MAP.slideMark,
  RECORD_KIND_MAP.pageTransition,
  RECORD_KIND_MAP.narration,
];

function createSessionStore() {
  let currentSession = null;

  function startSession({ mode = '', startedAt = Date.now() } = {}) {
    const recordListByKindMap = new Map();
    for (const kind of ACCUMULATED_KIND_LIST) recordListByKindMap.set(kind, []);
    currentSession = { sessionId: `session-${startedAt}`, mode, startedAt, recordListByKindMap };
    return { sessionId: currentSession.sessionId };
  }

  function addRecord({ record }) {
    const sessionId = currentSession ? currentSession.sessionId : null;
    const stamped = { ...record, sessionId };
    if (currentSession && currentSession.recordListByKindMap.has(record.kind)) {
      currentSession.recordListByKindMap.get(record.kind).push(stamped);
    }
    return stamped;
  }

  function endSession({ endedAt = Date.now() } = {}) {
    if (!currentSession) return null;
    const { sessionId, mode, startedAt, recordListByKindMap } = currentSession;
    currentSession = null;
    return {
      sessionId,
      mode,
      startedAt,
      endedAt,
      asrEntryList: [...recordListByKindMap.get(RECORD_KIND_MAP.asr)],
      slideMarkList: [...recordListByKindMap.get(RECORD_KIND_MAP.slideMark)],
      pageTransitionList: [...recordListByKindMap.get(RECORD_KIND_MAP.pageTransition)],
      narrationList: [...recordListByKindMap.get(RECORD_KIND_MAP.narration)],
    };
  }

  function getCurrentSessionId() {
    return currentSession ? currentSession.sessionId : null;
  }

  return { startSession, addRecord, endSession, getCurrentSessionId };
}

module.exports = { createSessionStore, ACCUMULATED_KIND_LIST };
