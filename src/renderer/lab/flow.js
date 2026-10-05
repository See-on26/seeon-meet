import {
  FLOW_TYPE_OPTION_LIST, OUTCOME_OPTION_LIST, OUTCOME_LABEL_MAP, VERDICT_MARK_MAP,
  formatClock, truncateText, filterFlowList, buildTimelineItemList, isNearBottom, createNodeCache, planNodeListUpdate,
} from './flow/flow-view.js';

const $ = (id) => document.getElementById(id);
const flowListElement = $('flowList');

const hiddenTypeSet = new Set();
const hiddenOutcomeSet = new Set();
let isAsrVisible = false;
let lastSnapshot = { runId: null, isRecording: false, flowList: [], trackList: [], sessionInfoList: [], asrList: [] };
let renderedNodeList = [];
let renderedSessionSignature = '';

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

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function renderSessionList(sessionInfoList) {
  // 내용이 같으면 다시 그리지 않는다(1초 갱신에 글 선택이 풀리지 않게).
  const signature = JSON.stringify(sessionInfoList);
  if (signature === renderedSessionSignature) return;
  renderedSessionSignature = signature;
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

function renderCaptionOutcomeList(captionList) {
  const list = createElement('div', 'caption-outcome-list');
  list.append(...captionList.map((caption) => {
    const row = createElement('div', 'caption-outcome');
    const text = `"${caption.text}"${caption.reason ? ` (${caption.reason})` : ''}`;
    row.title = text;
    row.append(
      createElement('span', `badge outcome-${caption.kind}`, OUTCOME_LABEL_MAP[caption.kind] || caption.kind),
      createElement('span', 'caption-outcome-text', text),
    );
    return row;
  }));
  return list;
}

// 카드 시각은 사건 시각(발화·전환이 있던 자리)이고, 결정 시각이 다르면 작게 함께 적는다.
function renderClock(flow) {
  const eventMs = Number.isFinite(flow.eventMediaMs) ? flow.eventMediaMs : flow.mediaMs;
  const clock = createElement('span', 'clock', `[${formatClock(eventMs)}]`);
  clock.title = '사건 시각(원본 영상)';
  if (!Number.isFinite(flow.mediaMs) || formatClock(flow.mediaMs) === formatClock(eventMs)) return [clock];
  const decision = createElement('span', 'decision-clock', `결정 ${formatClock(flow.mediaMs)}`);
  decision.title = '파이프라인이 이 결정을 내린 시각(원본 영상)';
  return [clock, decision];
}

function renderFlowCard(flow) {
  const card = createElement('div', `card outcome-${flow.outcome.kind}`);
  const head = createElement('div', 'card-head');
  const outcomeText = [flow.outcome.text ? `"${flow.outcome.text}"` : '', flow.outcome.reason ? `(${flow.outcome.reason})` : '']
    .filter(Boolean).join(' ');
  const outcomeElement = createElement('span', 'outcome-text', outcomeText);
  outcomeElement.title = outcomeText;
  head.append(
    ...renderClock(flow),
    createElement('span', 'badge', flow.slideLabel ? `${flow.typeLabel} · 슬라이드 ${flow.slideLabel}` : flow.typeLabel),
    createElement('span', `badge outcome-${flow.outcome.kind}`, OUTCOME_LABEL_MAP[flow.outcome.kind] || flow.outcome.kind),
    outcomeElement,
  );
  const stepList = createElement('div', 'step-list');
  stepList.append(...flow.stepList.map(renderStep));
  const captionList = flow.outcome.captionList || [];
  card.append(head, ...(captionList.length > 1 ? [renderCaptionOutcomeList(captionList)] : []), stepList);
  return card;
}

function renderAsrRow(asr) {
  const text = `[${formatClock(asr.mediaMs)}] ASR ${VERDICT_MARK_MAP[asr.verdict] || '•'} ${asr.text}`;
  const row = createElement('div', 'asr-row', text);
  row.title = `${asr.reason} · ${asr.text}`;
  return row;
}

// 바뀐 카드만 새로 만들고, 노드 목록이 그대로면 DOM 을 건드리지 않는다(1초 갱신은 신호등만 바꾼다).
const nodeCache = createNodeCache({
  createNode: (timelineItem) => (timelineItem.kind === 'flow' ? renderFlowCard(timelineItem.item) : renderAsrRow(timelineItem.item)),
});
const emptyNodeMap = new Map();

function resolveEmptyNode(text) {
  if (!emptyNodeMap.has(text)) emptyNodeMap.set(text, createElement('div', 'empty', text));
  return emptyNodeMap.get(text);
}

function renderFlowList() {
  const visibleFlowList = filterFlowList({ flowList: lastSnapshot.flowList, hiddenTypeSet, hiddenOutcomeSet });
  const itemList = buildTimelineItemList({ flowList: visibleFlowList, asrList: lastSnapshot.asrList, isAsrVisible });
  nodeCache.prune(new Set(itemList.map((item) => item.key)));
  const nodeList = itemList.length
    ? itemList.map(nodeCache.resolve)
    : [resolveEmptyNode(lastSnapshot.runId ? '아직 흐름이 없다' : '실행을 시작하면 흐름이 여기에 쌓인다')];
  const plan = planNodeListUpdate(renderedNodeList, nodeList);
  if (plan.kind === 'none') return;
  const wasNearBottom = isNearBottom(flowListElement);
  const previousScrollTop = flowListElement.scrollTop;
  if (plan.kind === 'append') flowListElement.append(...plan.appendList);
  else if (plan.kind === 'replace') for (const { index, node } of plan.replaceList) renderedNodeList[index].replaceWith(node);
  else flowListElement.replaceChildren(...nodeList);
  renderedNodeList = nodeList;
  flowListElement.scrollTop = wasNearBottom ? flowListElement.scrollHeight : previousScrollTop;
}

function renderRunText(snapshot) {
  const countMap = snapshot.flowList.reduce((map, flow) => ({ ...map, [flow.outcome.kind]: (map[flow.outcome.kind] || 0) + 1 }), {});
  const countText = OUTCOME_OPTION_LIST.map(({ key, label }) => `${label} ${countMap[key] || 0}`).join(' · ');
  setText($('runText'), snapshot.runId
    ? `${snapshot.runId} · ${snapshot.isRecording ? '실행 중' : '끝남'} · 흐름 ${snapshot.flowList.length}개 (${countText})`
    : '실행 없음');
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
