import { QUEUE_DROP_LABEL_MAP } from '../core/audio-renderer/narration-queue.js';

// 파이프라인 흐름 창의 표시 규칙(DOM 없음). 시각 표기·거르기·전사 줄 끼워 넣기·스크롤 붙임을 맡는다.
export const MAX_RENDERED_ITEM_COUNT = 400;
export const SUMMARY_MAX_LENGTH = 90;
const BOTTOM_STICK_PX = 24;

// main dev-flow/flow-builder.js 의 FLOW_TYPE_LABEL_MAP 과 같은 이름이다(test/dev-flow.test.mjs).
export const FLOW_TYPE_OPTION_LIST = [
  { key: 'page_transition', label: '페이지 전환' },
  { key: 'deixis', label: '지시 대상' },
  { key: 'interpretation', label: '발화 기반(수치·변화)' },
  { key: 'visual_description', label: '발화 기반(척도)' },
  { key: 'silence', label: '무발화 기반' },
  { key: 'user_command', label: '질문 답' },
  { key: 'speaker_identity', label: '화자 식별' },
  { key: 'unknown', label: '기타' },
];

// 버려진 이유 코드를 흐름 창에서 읽을 문장으로 바꾼다(기록 파일의 코드값은 그대로 둔다).
// 재생 대기 줄 사유는 렌더러 대기 줄의 문구를 그대로 쓰고, 그 밖의 코드는 흐름 계산이 붙인 것이다.
const OUTCOME_REASON_LABEL_MAP = {
  ...QUEUE_DROP_LABEL_MAP,
  feature_off: '기능 꺼짐 — 내보내지 않음',
  'rate-limited': '비슷한 해설이 방금 나가 간격 억제',
  not_played: '끝날 때까지 재생되지 않음',
  no_audio: 'TTS 합성 실패 — 소리 없음',
};
const DUPLICATE_REASON_PREFIX = 'duplicate:';

export function describeOutcomeReason(reason) {
  if (!reason) return '';
  if (OUTCOME_REASON_LABEL_MAP[reason]) return OUTCOME_REASON_LABEL_MAP[reason];
  if (reason.startsWith(DUPLICATE_REASON_PREFIX)) return `앞 해설과 같은 내용이라 막힘(${reason.slice(DUPLICATE_REASON_PREFIX.length)})`;
  return reason;
}

export const OUTCOME_OPTION_LIST = [
  { key: 'played', label: '재생됨' },
  { key: 'dropped', label: '버려짐' },
  { key: 'blocked', label: '막힘' },
  { key: 'pending', label: '진행 중' },
  { key: 'unknown', label: '결과 없음' },
];

export const OUTCOME_LABEL_MAP = Object.fromEntries(OUTCOME_OPTION_LIST.map(({ key, label }) => [key, label]));

export const VERDICT_MARK_MAP = { pass: '✓', skip: '↷', fail: '✕', info: '•' };

const pad2 = (value) => String(value).padStart(2, '0');

export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`;
}

export function truncateText(text, maxLength = SUMMARY_MAX_LENGTH) {
  const value = String(text ?? '');
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function filterFlowList({ flowList, hiddenTypeSet, hiddenOutcomeSet }) {
  return flowList.filter((flow) => !hiddenTypeSet.has(flow.typeKey) && !hiddenOutcomeSet.has(flow.outcome?.kind));
}

// 흐름 카드와(켜 두면) 전사 줄을 시각순으로 섞는다. 너무 길면 최근 것만 남긴다.
export function buildTimelineItemList({ flowList, asrList = [], isAsrVisible = false }) {
  const itemList = flowList.map((flow) => ({ kind: 'flow', key: `flow:${flow.id}`, ts: flow.ts, item: flow }));
  if (isAsrVisible) {
    asrList.forEach((asr, index) => itemList.push({ kind: 'asr', key: `asr:${asr.ts}:${index}`, ts: asr.ts, item: asr }));
  }
  itemList.sort((itemA, itemB) => itemA.ts - itemB.ts || (itemA.kind === 'asr' ? -1 : 1));
  return itemList.slice(-MAX_RENDERED_ITEM_COUNT);
}

// 사용자가 위로 올려 보고 있으면 새 카드가 붙어도 스크롤을 옮기지 않는다.
export function isNearBottom({ scrollTop, clientHeight, scrollHeight }) {
  return scrollTop + clientHeight >= scrollHeight - BOTTOM_STICK_PX;
}

// 항목(key)마다 그린 노드를 기억해 내용(signature)이 같으면 같은 노드를 돌려준다.
// 1초마다 오는 같은 갱신값은 같은 노드 목록이 되므로 목록을 다시 넣지 않는다(글 선택·말풍선이 끊기지 않게).
export function createNodeCache({ createNode }) {
  const nodeMap = new Map();
  return {
    resolve(timelineItem) {
      const signature = JSON.stringify(timelineItem.item);
      const cached = nodeMap.get(timelineItem.key);
      if (cached && cached.signature === signature) return cached.node;
      const node = createNode(timelineItem);
      nodeMap.set(timelineItem.key, { signature, node });
      return node;
    },
    prune(keySet) {
      for (const key of nodeMap.keys()) if (!keySet.has(key)) nodeMap.delete(key);
    },
    size: () => nodeMap.size,
  };
}

export function isSameNodeList(currentList, nextList) {
  return currentList.length === nextList.length && currentList.every((node, index) => node === nextList[index]);
}

// 지금 목록을 다음 목록으로 바꾸는 가장 작은 방법. 뒤에 붙기만 했으면 덧붙이고, 같은 자리의 카드만 바뀌었으면 그것만 갈아 끼운다.
// 갈아 끼울 노드가 이미 다른 자리에 있으면(앞이 빠져 밀림) 통째로 다시 넣는다.
export function planNodeListUpdate(currentList, nextList) {
  if (isSameNodeList(currentList, nextList)) return { kind: 'none' };
  const isPrefixKept = currentList.every((node, index) => node === nextList[index]);
  if (nextList.length > currentList.length && isPrefixKept) return { kind: 'append', appendList: nextList.slice(currentList.length) };
  if (nextList.length === currentList.length) {
    const currentSet = new Set(currentList);
    const replaceList = nextList
      .map((node, index) => ({ index, node }))
      .filter(({ index, node }) => node !== currentList[index]);
    if (replaceList.every(({ node }) => !currentSet.has(node))) return { kind: 'replace', replaceList };
  }
  return { kind: 'reset' };
}
