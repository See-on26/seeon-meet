// 파이프라인 흐름 창의 표시 규칙(DOM 없음). 시각 표기·거르기·전사 줄 끼워 넣기·스크롤 붙임을 맡는다.
export const MAX_RENDERED_ITEM_COUNT = 400;
export const SUMMARY_MAX_LENGTH = 90;
const BOTTOM_STICK_PX = 24;

export const FLOW_TYPE_OPTION_LIST = [
  { key: 'page_transition', label: '페이지 전환' },
  { key: 'deixis', label: '지시 대상' },
  { key: 'interpretation', label: '발화 기반(수치·변화)' },
  { key: 'visual_description', label: '발화 기반(척도·시각)' },
  { key: 'silence', label: '무발화' },
  { key: 'user_command', label: '질문 답' },
  { key: 'speaker_identity', label: '화자' },
  { key: 'unknown', label: '기타' },
];

export const OUTCOME_OPTION_LIST = [
  { key: 'played', label: '재생됨' },
  { key: 'dropped', label: '버려짐' },
  { key: 'blocked', label: '막힘' },
  { key: 'pending', label: '진행 중' },
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
