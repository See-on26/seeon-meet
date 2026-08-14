// 늦은 근거 재시도. 발화 트리거 해설이 NONE·값 없음으로 끝났는데 곧이어 화면이 바뀌면(근거가 발화보다 늦게 나타남),
// 그 트리거의 원래 에이전트를 새 화면으로 한 번 다시 부르게 짝지어 준다. 뒤 발화를 기다리는 것이 아니라 화면을 기다린다.
// 짝짓기는 양방향이다: 변화(또는 다음 슬라이드 기준 화면)가 미해결 트리거를 꺼내고, 미해결 결과가 늦게 오면 보관한 변화를 찾는다.
const RETRY_WINDOW_MS = 10000;
const MAX_NOTE_COUNT = 8;

// 형식 오류(칸을 못 채움)·한자 섞임은 화면에 근거가 없어서가 아니라 생성이 깨진 것이라 다시 부르지 않는다.
const NOT_RETRIED_REJECT_KIND_LIST = ['format', 'han'];

function toSlideKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

function isRetriableUnresolved(note) {
  return Boolean(note) && !NOT_RETRIED_REJECT_KIND_LIST.includes(note.rejectKind);
}

function createPendingEvidence({ windowMs = RETRY_WINDOW_MS, now = Date.now } = {}) {
  let noteList = [];
  let recentChange = null;

  function prune() {
    const nowMs = now();
    // 사건 감지에 몇 초가 걸려 창보다 늦게 도착하는 변화가 있어 창의 두 배까지 두고, 짝지을 때 사건 시각으로 창을 본다.
    noteList = noteList.filter((note) => nowMs - note.notedAt <= windowMs * 2);
    if (recentChange && nowMs - recentChange.rememberedAt > windowMs) recentChange = null;
  }

  // note: { ts, captureTs, slideLabel, rejectKind, ... } — 원래 에이전트를 다시 부르는 데 필요한 인자를 함께 담는다.
  function noteUnresolved(note) {
    if (!isRetriableUnresolved(note)) return false;
    prune();
    noteList = [...noteList, { ...note, notedAt: now() }].slice(-MAX_NOTE_COUNT);
    return true;
  }

  function findNoteIndex(isMatch) {
    prune();
    for (let index = noteList.length - 1; index >= 0; index -= 1) {
      if (isMatch(noteList[index])) return index;
    }
    return -1;
  }

  function takeAt(index) {
    if (index < 0) return null;
    const [note] = noteList.splice(index, 1);
    return note;
  }

  const isChangeMatch = ({ slideLabel, changeTs }) => (note) => toSlideKey(note.slideLabel) === toSlideKey(slideLabel)
    && changeTs > note.captureTs && changeTs - note.notedAt <= windowMs;

  // 트리거 뒤에 다른 슬라이드로 바뀌었고, 그 슬라이드의 기준 화면이 창 안에 나왔을 때만 짝짓는다.
  const isSlideStartMatch = ({ slideLabel, slideStartTs, baselineTs }) => (note) => (
    toSlideKey(note.slideLabel) !== toSlideKey(slideLabel)
    && slideStartTs > note.captureTs && baselineTs - note.notedAt <= windowMs
  );

  return {
    noteUnresolved,
    takeForChange: (query) => takeAt(findNoteIndex(isChangeMatch(query))),
    peekForChange: (query) => noteList[findNoteIndex(isChangeMatch(query))] || null,
    takeForSlideStart: (query) => takeAt(findNoteIndex(isSlideStartMatch(query))),
    peekForSlideStart: (query) => noteList[findNoteIndex(isSlideStartMatch(query))] || null,
    // isRetryEligible: 이 변화로 VLM 을 부르지 않았고 해설 대상에서 빠지지 않은 변화. 그런 변화만 늦게 온 미해결 결과와 짝짓는다
    // (사건 하나에 변화 해설과 늦은 근거 재시도 중 하나만 VLM 을 부른다).
    rememberChange({ slideLabel, changeTs, frame, isRetryEligible, ...extra }) {
      recentChange = {
        ...extra, slideLabel, changeTs, frame, isRetryEligible: Boolean(isRetryEligible), rememberedAt: now(),
      };
    },
    // isConsumed=false 는 꺼내지 않고 보기만 한다(shadow 기록).
    findChangeAfter({ slideLabel, captureTs, isConsumed = true }) {
      prune();
      const change = recentChange;
      if (!change || !change.isRetryEligible) return null;
      if (toSlideKey(change.slideLabel) !== toSlideKey(slideLabel) || !(change.changeTs > captureTs)) return null;
      if (isConsumed) recentChange = null;
      return change;
    },
    reset() {
      noteList = [];
      recentChange = null;
    },
  };
}

module.exports = { createPendingEvidence, isRetriableUnresolved, RETRY_WINDOW_MS };
