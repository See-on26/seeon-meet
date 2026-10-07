export const LEADER_STATUS_MAP = {
  none: 'none',
  scheduled: 'scheduled',
  cancelled: 'cancelled',
  unscheduled: 'unscheduled',
};

// 같은 슬라이드의 전환 고지와 사진 단독 묘사는 원 사건 시각이 같고 삽입 위치를 따로 정한다.
// 묘사가 고지보다 먼저 나오지 않도록, 묘사는 고지의 삽입 시각이 정해질 때까지 기다린다.
export class TransitionOrderGate {
  constructor() {
    this.leaderMap = new Map();
  }

  registerLeader({ slideLabel }) {
    let settleLeader = () => {};
    const promise = new Promise((resolve) => { settleLeader = resolve; });
    this.leaderMap.set(String(slideLabel), promise);
    return {
      settle: ({ status, insertVideoTimeMs = null }) => settleLeader({ status, insertVideoTimeMs }),
    };
  }

  waitLeader({ slideLabel }) {
    return this.leaderMap.get(String(slideLabel))
      ?? Promise.resolve({ status: LEADER_STATUS_MAP.none, insertVideoTimeMs: null });
  }

  reset() {
    this.leaderMap.clear();
  }
}

const FOLLOWER_GAP_MS = 1;

// 전환 고지가 끝까지 정해지지 않아도(생성 실패·응답 유실) 화자 안내를 이 시간보다 오래 붙잡지 않는다.
export const PENDING_TRANSITION_MAX_WAIT_MS = 10000;

// 화면 전환을 확정한 순간부터 그 고지의 삽입 시각이 정해질 때까지는 전환이 진행 중이다.
// 화자 안내는 생성이 빨라 같은 때 일어난 전환 고지보다 먼저 도착하므로, 진행 중인 전환이 있으면 그 고지 뒤로 미룬다.
export class PendingTransitionTracker {
  constructor({ maxWaitMs = PENDING_TRANSITION_MAX_WAIT_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle) } = {}) {
    this.maxWaitMs = maxWaitMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pendingMap = new Map();
  }

  open({ slideLabel }) {
    const key = String(slideLabel);
    this.settle({ slideLabel, status: LEADER_STATUS_MAP.unscheduled });
    let resolvePending = () => {};
    const promise = new Promise((resolve) => { resolvePending = resolve; });
    const timerHandle = this.setTimer(
      () => this.settle({ slideLabel, status: LEADER_STATUS_MAP.unscheduled }), this.maxWaitMs);
    this.pendingMap.set(key, { promise, resolvePending, timerHandle });
  }

  settle({ slideLabel, status, insertVideoTimeMs = null }) {
    const key = String(slideLabel);
    const pending = this.pendingMap.get(key);
    if (!pending) return false;
    this.pendingMap.delete(key);
    this.clearTimer(pending.timerHandle);
    pending.resolvePending({ status, insertVideoTimeMs });
    return true;
  }

  get hasPending() {
    return this.pendingMap.size > 0;
  }

  // 지금 진행 중인 전환이 모두 정해질 때까지 기다린다. 진행 중인 전환이 없으면 바로 끝난다.
  waitAll() {
    return Promise.all([...this.pendingMap.values()].map((pending) => pending.promise));
  }

  reset() {
    for (const key of [...this.pendingMap.keys()]) {
      this.settle({ slideLabel: key, status: LEADER_STATUS_MAP.unscheduled });
    }
  }
}

// 기다린 전환 고지들 중 가장 늦은 삽입 시각 바로 뒤에 화자 안내를 둔다. 전환이 취소·미정이면 원래 시각을 쓴다.
export function resolveAfterTransitionInsertMs({ insertVideoTimeMs, leaderList }) {
  const scheduledMsList = leaderList
    .filter((leader) => leader.status === LEADER_STATUS_MAP.scheduled && Number.isFinite(leader.insertVideoTimeMs))
    .map((leader) => leader.insertVideoTimeMs + FOLLOWER_GAP_MS);
  if (!scheduledMsList.length || !Number.isFinite(insertVideoTimeMs)) return insertVideoTimeMs;
  return Math.max(insertVideoTimeMs, ...scheduledMsList);
}

// 고지가 정해진 시각 바로 뒤에 붙인다. 고지가 체류 미달로 취소되면 스쳐 간 화면이므로 묘사도 버린다(null).
export function resolveFollowerInsertMs({ eventVideoTimeMs, leader }) {
  if (leader.status === LEADER_STATUS_MAP.cancelled) return null;
  if (leader.status === LEADER_STATUS_MAP.scheduled && Number.isFinite(leader.insertVideoTimeMs)) {
    return Math.max(eventVideoTimeMs, leader.insertVideoTimeMs + FOLLOWER_GAP_MS);
  }
  return eventVideoTimeMs;
}
