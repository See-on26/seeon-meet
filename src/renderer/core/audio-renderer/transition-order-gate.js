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

// 고지가 정해진 시각 바로 뒤에 붙인다. 고지가 체류 미달로 취소되면 스쳐 간 화면이므로 묘사도 버린다(null).
export function resolveFollowerInsertMs({ eventVideoTimeMs, leader }) {
  if (leader.status === LEADER_STATUS_MAP.cancelled) return null;
  if (leader.status === LEADER_STATUS_MAP.scheduled && Number.isFinite(leader.insertVideoTimeMs)) {
    return Math.max(eventVideoTimeMs, leader.insertVideoTimeMs + FOLLOWER_GAP_MS);
  }
  return eventVideoTimeMs;
}
