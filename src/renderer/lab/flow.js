import {
  FLOW_TYPE_OPTION_LIST, OUTCOME_OPTION_LIST, OUTCOME_LABEL_MAP, VERDICT_MARK_MAP,
  formatClock, truncateText, filterFlowList, buildTimelineItemList, isNearBottom,
} from './flow/flow-view.js';

const $ = (id) => document.getElementById(id);
const flowListElement = $('flowList');

const hiddenTypeSet = new Set();
const hiddenOutcomeSet = new Set();
let isAsrVisible = false;
let lastSnapshot = { runId: null, isRecording: false, flowList: [], trackList: [], sessionInfoList: [], asrList: [] };
// 바뀐 카드만 새로 만들어 위쪽 카드 높이가 그대로이게 한다(위로 올려 보는 중에 화면이 튀지 않게).
const renderedNodeMap = new Map();

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderTrackRow(trackList) {
  $('trackRow').replaceChildren(...trackList.map((track) => {
    const trackElement = createElement('div', `track state-${track.state}`);
    const label = createElement('div', 'track-label');
    label.append(createElement('span', 'dot'), createElement('span', '', track.label));
    const detail = createElement('div', 'track-detail', track.lastDetail || '—');
    trackElement.title = track.lastDetail || '';
    trackElement.append(label, detail);
    return trackElement;
  }));
}

function renderSessionList(sessionInfoList) {
  $('sessionSummary').textContent = `세션 기록 ${sessionInfoList.length}건${sessionInfoList.length ? ` · 마지막: ${sessionInfoList.at(-1).reason}` : ''}`;
  $('sessionList').replaceChildren(...sessionInfoList.map((info) => {
    const text = `[${formatClock(info.mediaMs)}] ${info.stage} · ${info.reason}${info.detail ? ` · ${info.detail}` : ''}`;
    const row = createElement('div', 'session-row', text);
    row.title = text;
    return row;
  }));
}

function renderStep(step) {
  const row = createElement('div', 'step');
  const fullText = [step.reason, step.detail].filter(Boolean).join(' · ');
  row.title = `${step.stepKind} · ${step.label}${fullText ? `\n${fullText}` : ''}`;
  const summary = step.summary || step.reason || step.detail || '';
  const shortText = step.reason && step.summary && step.summary !== step.reason ? `${step.reason} · ${summary}` : summary;
  row.append(
    createElement('span', 'step-kind', step.stepKind),
    createElement('span', 'step-label', step.label),
    createElement('span', `step-mark verdict-${step.verdict}`, VERDICT_MARK_MAP[step.verdict] || '•'),
    createElement('span', 'step-detail', truncateText(shortText)),
  );
  return row;
}

function renderFlowCard(flow) {
  const card = createElement('div', `card outcome-${flow.outcome.kind}`);
  const head = createElement('div', 'card-head');
  const outcomeText = [flow.outcome.text ? `"${flow.outcome.text}"` : '', flow.outcome.reason ? `(${flow.outcome.reason})` : '']
    .filter(Boolean).join(' ');
  const outcomeElement = createElement('span', 'outcome-text', outcomeText);
  outcomeElement.title = outcomeText;
  head.append(
    createElement('span', 'clock', `[${formatClock(flow.mediaMs)}]`),
    createElement('span', 'badge', flow.slideLabel ? `${flow.typeLabel} · 슬라이드 ${flow.slideLabel}` : flow.typeLabel),
    createElement('span', `badge outcome-${flow.outcome.kind}`, OUTCOME_LABEL_MAP[flow.outcome.kind] || flow.outcome.kind),
    outcomeElement,
  );
  const stepList = createElement('div', 'step-list');
  stepList.append(...flow.stepList.map(renderStep));
  card.append(head, stepList);
  return card;
}

function renderAsrRow(asr) {
  const text = `[${formatClock(asr.mediaMs)}] ASR ${VERDICT_MARK_MAP[asr.verdict] || '•'} ${asr.text}`;
  const row = createElement('div', 'asr-row', text);
  row.title = `${asr.reason} · ${asr.text}`;
  return row;
}

function renderItemNode(timelineItem) {
  const signature = JSON.stringify(timelineItem.item);
  const cached = renderedNodeMap.get(timelineItem.key);
  if (cached && cached.signature === signature) return cached.node;
  const node = timelineItem.kind === 'flow' ? renderFlowCard(timelineItem.item) : renderAsrRow(timelineItem.item);
  renderedNodeMap.set(timelineItem.key, { signature, node });
  return node;
}

function renderFlowList() {
  const wasNearBottom = isNearBottom(flowListElement);
  const previousScrollTop = flowListElement.scrollTop;
  const visibleFlowList = filterFlowList({ flowList: lastSnapshot.flowList, hiddenTypeSet, hiddenOutcomeSet });
  const itemList = buildTimelineItemList({ flowList: visibleFlowList, asrList: lastSnapshot.asrList, isAsrVisible });
  const keySet = new Set(itemList.map((item) => item.key));
  for (const key of renderedNodeMap.keys()) if (!keySet.has(key)) renderedNodeMap.delete(key);
  if (!itemList.length) {
    flowListElement.replaceChildren(createElement('div', 'empty', lastSnapshot.runId ? '아직 흐름이 없다' : '실행을 시작하면 흐름이 여기에 쌓인다'));
    return;
  }
  flowListElement.replaceChildren(...itemList.map(renderItemNode));
  flowListElement.scrollTop = wasNearBottom ? flowListElement.scrollHeight : previousScrollTop;
}

function renderRunText(snapshot) {
  const countMap = snapshot.flowList.reduce((map, flow) => ({ ...map, [flow.outcome.kind]: (map[flow.outcome.kind] || 0) + 1 }), {});
  const countText = OUTCOME_OPTION_LIST.map(({ key, label }) => `${label} ${countMap[key] || 0}`).join(' · ');
  $('runText').textContent = snapshot.runId
    ? `${snapshot.runId} · ${snapshot.isRecording ? '실행 중' : '끝남'} · 흐름 ${snapshot.flowList.length}개 (${countText})`
    : '실행 없음';
}

function render(snapshot) {
  lastSnapshot = snapshot;
  renderRunText(snapshot);
  renderTrackRow(snapshot.trackList || []);
  renderSessionList(snapshot.sessionInfoList || []);
  renderFlowList();
}

function renderFilterChipList({ containerId, optionList, hiddenSet }) {
  const container = $(containerId);
  for (const option of optionList) {
    const chip = createElement('button', 'chip', option.label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      if (hiddenSet.has(option.key)) hiddenSet.delete(option.key);
      else hiddenSet.add(option.key);
      chip.classList.toggle('off', hiddenSet.has(option.key));
      renderFlowList();
    });
    container.append(chip);
  }
}

renderFilterChipList({ containerId: 'typeFilter', optionList: FLOW_TYPE_OPTION_LIST, hiddenSet: hiddenTypeSet });
renderFilterChipList({ containerId: 'outcomeFilter', optionList: OUTCOME_OPTION_LIST, hiddenSet: hiddenOutcomeSet });
$('asrToggle').addEventListener('change', (event) => {
  isAsrVisible = event.target.checked;
  renderFlowList();
});

window.labFlow.onUpdate(render);
render(lastSnapshot);
