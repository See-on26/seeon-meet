const {
  NARRATION_TYPE_MAP, INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP,
} = require('../contracts/narration-types');

const MERGE_WINDOW_MS = 1000;

const NARRATION_ORDER_MAP = {
  [NARRATION_TYPE_MAP.speakerIdentity]: 0,
  [NARRATION_TYPE_MAP.pageTransition]: 1,
  [NARRATION_TYPE_MAP.userCommand]: 2,
  [NARRATION_TYPE_MAP.visualDescription]: 3,
  [NARRATION_TYPE_MAP.interpretation]: 4,
  [NARRATION_TYPE_MAP.deixis]: 5,
};

const SKIP_REASON_MAP = {
  budget: 'budget',
  deadline: 'deadline',
  dwellNotSatisfied: 'dwell_not_satisfied',
  mergedIntoOther: 'merged_into_other',
  supersededByClaimToValue: 'superseded_by_claim_to_value',
};

function readOrder({ candidate }) {
  const order = NARRATION_ORDER_MAP[candidate.type];
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function isAbsorber({ candidate }) {
  return candidate.type === NARRATION_TYPE_MAP.interpretation
    || candidate.type === NARRATION_TYPE_MAP.visualDescription;
}

function isClaimToValue({ candidate }) {
  return candidate.type === NARRATION_TYPE_MAP.interpretation
    && candidate.subKind === INTERPRETATION_KIND_MAP.claimToValue;
}

function isScaleDescription({ candidate }) {
  return candidate.type === NARRATION_TYPE_MAP.visualDescription
    && candidate.subKind === VISUAL_DESCRIPTION_KIND_MAP.scale;
}

function resolveCandidateList({ candidateList, nowTs = Date.now() }) {
  const droppedList = [];

  const drop = ({ candidate, skipReason }) => droppedList.push({ ...candidate, skipReason });

  let survivorList = [];
  for (const candidate of candidateList) {
    if (candidate.wordBudget && candidate.wordBudget.isDroppable) {
      drop({ candidate, skipReason: SKIP_REASON_MAP.budget });
    } else if (Number.isFinite(candidate.deadlineTs) && candidate.deadlineTs < nowTs) {
      drop({ candidate, skipReason: SKIP_REASON_MAP.deadline });
    } else {
      survivorList.push(candidate);
    }
  }

  if (survivorList.some((candidate) => isClaimToValue({ candidate }))) {
    const keptList = [];
    for (const candidate of survivorList) {
      if (isScaleDescription({ candidate })) {
        drop({ candidate, skipReason: SKIP_REASON_MAP.supersededByClaimToValue });
      } else {
        keptList.push(candidate);
      }
    }
    survivorList = keptList;
  }

  const absorberList = survivorList.filter((candidate) => isAbsorber({ candidate }));
  const deixisList = survivorList.filter(
    (candidate) => candidate.type === NARRATION_TYPE_MAP.deixis,
  );
  if (absorberList.length && deixisList.length) {
    const mergedAnchorList = deixisList
      .map((candidate) => candidate.anchor)
      .filter((anchor) => typeof anchor === 'string' && anchor.trim());
    for (const candidate of deixisList) {
      drop({ candidate, skipReason: SKIP_REASON_MAP.mergedIntoOther });
    }
    survivorList = survivorList
      .filter((candidate) => candidate.type !== NARRATION_TYPE_MAP.deixis)
      .map((candidate) => (isAbsorber({ candidate }) ? { ...candidate, mergedAnchorList } : candidate));
  }

  const resolvedList = [...survivorList].sort((left, right) => (
    readOrder({ candidate: left }) - readOrder({ candidate: right }) || left.ts - right.ts
  ));
  return { resolvedList, droppedList };
}

class Arbiter {
  constructor({ onResolve, mergeWindowMs = MERGE_WINDOW_MS,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    this.onResolve = onResolve;
    this.mergeWindowMs = mergeWindowMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.pendingList = [];
    this.timerHandle = null;
  }

  submit(candidate) {
    this.pendingList.push(candidate);
    if (this.timerHandle === null) {
      this.timerHandle = this.setTimer(() => this.flush(), this.mergeWindowMs);
    }
  }

  cancel({ narrationId, skipReason = SKIP_REASON_MAP.dwellNotSatisfied }) {
    const index = this.pendingList.findIndex((candidate) => candidate.narrationId === narrationId);
    if (index < 0) return false;
    const [candidate] = this.pendingList.splice(index, 1);
    this.onResolve?.({ resolvedList: [], droppedList: [{ ...candidate, skipReason }] });
    return true;
  }

  flush() {
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
    if (!this.pendingList.length) return;
    const candidateList = this.pendingList;
    this.pendingList = [];
    this.onResolve?.(resolveCandidateList({ candidateList, nowTs: this.now() }));
  }

  reset() {
    if (this.timerHandle !== null) { this.clearTimer(this.timerHandle); this.timerHandle = null; }
    this.pendingList = [];
  }
}

module.exports = {
  Arbiter, resolveCandidateList, MERGE_WINDOW_MS, NARRATION_ORDER_MAP, SKIP_REASON_MAP,
};
