const { resolvePlayedWallMs } = require('../time-map');

// 파이프라인 debug 기록을 "무엇이 트리거됐고 → 어떤 판정을 거쳐 → 어떤 에이전트가 불려 → 무엇이 나갔는지" 흐름으로 묶는다.
// 실행 중 흐름 창과 결과 폴더 flow.json 이 같은 함수를 쓴다. 입력을 바꾸지 않고 매번 처음부터 다시 만든다.

const LEGACY_TRANSITION_TYPE = 'page-transition';

const FLOW_TYPE_MAP = {
  pageTransition: 'page_transition',
  deixis: 'deixis',
  interpretation: 'interpretation',
  visualDescription: 'visual_description',
  silence: 'silence',
  userCommand: 'user_command',
  speakerIdentity: 'speaker_identity',
  unknown: 'unknown',
};

const FLOW_TYPE_LABEL_MAP = {
  [FLOW_TYPE_MAP.pageTransition]: '페이지 전환',
  [FLOW_TYPE_MAP.deixis]: '지시 대상',
  [FLOW_TYPE_MAP.interpretation]: '발화 기반(수치·변화)',
  [FLOW_TYPE_MAP.visualDescription]: '발화 기반(척도·시각)',
  [FLOW_TYPE_MAP.silence]: '무발화',
  [FLOW_TYPE_MAP.userCommand]: '질문 답',
  [FLOW_TYPE_MAP.speakerIdentity]: '화자',
  [FLOW_TYPE_MAP.unknown]: '기타',
};

// 팀 구조도(V8)의 에이전트 이름.
const AGENT_LABEL_MAP = {
  [FLOW_TYPE_MAP.pageTransition]: '페이지 전환 설명 에이전트',
  [FLOW_TYPE_MAP.deixis]: '지시 대상 설명 에이전트',
  [FLOW_TYPE_MAP.interpretation]: '발화 기반 설명 에이전트',
  [FLOW_TYPE_MAP.visualDescription]: '발화 기반 설명 에이전트',
  [FLOW_TYPE_MAP.silence]: '무발화 기반 설명 에이전트',
  [FLOW_TYPE_MAP.userCommand]: '심화 질의응답 에이전트',
  [FLOW_TYPE_MAP.speakerIdentity]: '화자 식별 에이전트',
  [FLOW_TYPE_MAP.unknown]: 'VLM',
};

const ROUTER_JUDGE_LABEL = '경량 LLM 판단(통합 라우터)';
const SILENCE_JUDGE_LABEL = '경량 LLM 판단(무발화)';

const STEP_KIND_MAP = {
  input: '입력',
  trigger: '트리거',
  judge: '판정',
  agent: '에이전트',
  post: '후처리',
  output: '출력',
};
const STEP_KIND_ORDER_LIST = Object.values(STEP_KIND_MAP);

const OUTCOME_KIND_MAP = { played: 'played', dropped: 'dropped', blocked: 'blocked', pending: 'pending' };

// 끝난 실행에서 해설은 만들었는데 들리지 않은 이유(ad-timeline droppedList 와 같은 코드).
const UNPLAYED_REASON_MAP = { noAudio: 'no_audio', notPlayed: 'not_played', featureOff: 'feature_off', rateLimited: 'rate-limited' };

const UTTERANCE_TYPE_LIST = [FLOW_TYPE_MAP.deixis, FLOW_TYPE_MAP.interpretation, FLOW_TYPE_MAP.visualDescription];
// 결정 하나에 딸린 세션 수준 기록. 흐름 카드가 아니라 머리 영역에 보인다.
const SESSION_STAGE_LIST = ['session', 'context', 'vlm_fallback'];
// 렌더러 기록(지시 탐지·예산)은 렌더러 시각을 쓰므로 같은 결정의 main 기록과 몇 ms 어긋난다.
const UTTERANCE_MERGE_WINDOW_MS = 50;
// 슬라이드 감지 뒤 고지 생성까지(체류 3초 + 화면 판정) 이 안에서 같은 슬라이드 흐름을 찾는다.
const SLIDE_EPISODE_WINDOW_MS = 60000;

const SLIDE_DETECT_PATTERN = /슬라이드 확정$/;
const SLIDE_DWELL_PATTERN = /^체류 (확정|미달) \(/;
const SLIDE_CANCEL_PATTERN = /^(체류 미달 — 재생 전 취소|전환 고지 취소)/;
const SLIDE_TOPIC_PATTERN = /^주제 판정/;

const ENTRY_ROLE_MAP = {
  asr: 'asr',
  session: 'session',
  core: 'core',
  utterance: 'utterance',
  slideDetect: 'slide_detect',
  slideDwell: 'slide_dwell',
  textFloat: 'text_float',
};

const STAGE_LABEL_MAP = {
  screen_dependency: '화면 의존 판정',
  budget: '어절 예산',
  router: ROUTER_JUDGE_LABEL,
  judge: '판정기',
  screen: '화면 유형 판정',
  value_check: '값 존재 검사',
  dedupe: '중복·간격 억제',
  gap: '틈 선택',
  toggle: '기능 토글',
  queue: '재생 대기 줄',
  tts: 'TTS 합성',
  question: '질문 갈래',
};

function normalizeNarrationType(narrationType) {
  return narrationType === LEGACY_TRANSITION_TYPE ? FLOW_TYPE_MAP.pageTransition : narrationType || null;
}

const roundOrNull = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const isSkipVerdict = (verdict) => verdict === 'skip' || verdict === 'fail';

function readLeadingQuoted(detail) {
  const match = /^"(.*?)"(?= \(| ·| —| ≈|$)/.exec(detail || '');
  return match ? match[1] : null;
}

function readArrowQuoted(detail) {
  const match = /→ "(.*?)"(?= \(|$)/.exec(detail || '');
  return match ? match[1] : null;
}

function readTrailingQuoted(detail) {
  const match = /"([^"]*)"$/.exec(detail || '');
  return match ? match[1] : null;
}

function readField(detail, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(detail || '');
  return match ? match[1] : null;
}

function readElapsedMs(detail) {
  const match = /\((\d+)ms/.exec(detail || '');
  return match ? Number(match[1]) : null;
}

function readSlideLabel(entry) {
  if (SLIDE_TOPIC_PATTERN.test(entry.reason || '')) return /임베딩라벨=(\S+)/.exec(entry.detail || '')?.[1] ?? null;
  if (entry.stage === 'screen') return /슬라이드=(\S+)/.exec(entry.detail || '')?.[1] ?? null;
  return /^슬라이드 (\S+)/.exec(entry.detail || '')?.[1] ?? null;
}

// 단계마다 해설 문장이 실린 자리가 다르다.
function readEntryText(entry) {
  const { stage, verdict, detail } = entry;
  if (stage === 'vlm' && verdict === 'pass') return readArrowQuoted(detail) ?? readLeadingQuoted(detail);
  if (stage === 'value_check') return readArrowQuoted(detail);
  if ((stage === 'silence' || stage === 'speaker') && verdict === 'pass') return readLeadingQuoted(detail);
  if (stage === 'tts' && verdict === 'pass') return readTrailingQuoted(detail);
  if (stage === 'toggle' && verdict === 'skip') return readTrailingQuoted(detail);
  if (stage === 'dedupe' || stage === 'gap' || stage === 'queue') return readLeadingQuoted(detail);
  if (stage === 'slide' && SLIDE_CANCEL_PATTERN.test(entry.reason || '')) return readTrailingQuoted(detail);
  return null;
}

function classifyEntry(entry) {
  const { stage, verdict, narrationType, reason } = entry;
  if (stage === 'asr') return ENTRY_ROLE_MAP.asr;
  if (SESSION_STAGE_LIST.includes(stage)) return ENTRY_ROLE_MAP.session;
  if (stage === 'toggle' && verdict === 'info') return ENTRY_ROLE_MAP.session;
  if ((stage === 'value_check' || stage === 'question') && !narrationType) return ENTRY_ROLE_MAP.session;
  if (stage === 'slide') {
    if (!narrationType) return ENTRY_ROLE_MAP.session;
    if (SLIDE_TOPIC_PATTERN.test(reason || '')) return ENTRY_ROLE_MAP.core;
    if (SLIDE_DETECT_PATTERN.test(reason || '')) return ENTRY_ROLE_MAP.slideDetect;
    if (SLIDE_DWELL_PATTERN.test(reason || '')) return ENTRY_ROLE_MAP.slideDwell;
    if (SLIDE_CANCEL_PATTERN.test(reason || '')) return ENTRY_ROLE_MAP.textFloat;
    return ENTRY_ROLE_MAP.session;
  }
  if (stage === 'screen_dependency') return ENTRY_ROLE_MAP.utterance;
  if (stage === 'budget') {
    if (narrationType === FLOW_TYPE_MAP.pageTransition) return ENTRY_ROLE_MAP.slideDwell;
    if (narrationType === FLOW_TYPE_MAP.speakerIdentity) return ENTRY_ROLE_MAP.core;
    return ENTRY_ROLE_MAP.utterance;
  }
  if (stage === 'gap' || stage === 'queue') return ENTRY_ROLE_MAP.textFloat;
  return ENTRY_ROLE_MAP.core;
}

function normalizeEntryList(debugList) {
  return (debugList || [])
    .filter((entry) => entry && Number.isFinite(entry.ts))
    .map((entry, index) => ({
      ...entry, stage: entry.stage || 'judge', narrationType: normalizeNarrationType(entry.narrationType), index,
    }));
}

const createGroup = ({ keyTs, isKeyed }) => ({ keyTs, isKeyed, entryList: [], slideLabel: null });
const hasStage = (group, stageList) => group.entryList.some((entry) => stageList.includes(entry.stage));
const isPageGroup = (group) => group.entryList.some((entry) => entry.stage === 'screen'
  || (entry.stage === 'slide' && SLIDE_TOPIC_PATTERN.test(entry.reason || ''))
  || entry.narrationType === FLOW_TYPE_MAP.pageTransition);
const isUtteranceRouteGroup = (group) => group.entryList.some((entry) => entry.stage === 'router' || entry.stage === 'judge'
  || (entry.stage === 'vlm' && UTTERANCE_TYPE_LIST.includes(entry.narrationType)));

function resolvePageSlideLabel({ group, captionEventList }) {
  for (const entry of group.entryList) {
    const label = entry.stage === 'slide' || entry.stage === 'screen' ? readSlideLabel(entry) : null;
    if (label) return label;
  }
  const caption = captionEventList.find((event) => event.ts === group.keyTs && event.slideLabel != null);
  return caption ? String(caption.slideLabel) : null;
}

// main 기록은 결정마다 같은 ts 를 쓰므로 ts 로 먼저 묶는다.
function groupCoreEntryList(coreList) {
  const groupMap = new Map();
  for (const entry of coreList) {
    if (!groupMap.has(entry.ts)) groupMap.set(entry.ts, createGroup({ keyTs: entry.ts, isKeyed: true }));
    groupMap.get(entry.ts).entryList.push(entry);
  }
  return [...groupMap.values()];
}

// 지시 탐지·예산은 몇 ms 안의 라우터 묶음에 붙이고, 아직 라우터 결과가 없으면 저희끼리 묶는다.
function attachUtteranceEntryList({ utteranceList, groupList, sessionList }) {
  const routeGroupList = groupList.filter(isUtteranceRouteGroup);
  const floatingList = [];
  for (const entry of [...utteranceList].sort((entryA, entryB) => entryA.ts - entryB.ts)) {
    const nearest = routeGroupList
      .filter((group) => Math.abs(group.keyTs - entry.ts) <= UTTERANCE_MERGE_WINDOW_MS)
      .sort((groupA, groupB) => Math.abs(groupA.keyTs - entry.ts) - Math.abs(groupB.keyTs - entry.ts))[0];
    if (nearest) {
      nearest.entryList.push(entry);
      continue;
    }
    const cluster = floatingList.at(-1);
    if (cluster && entry.ts - cluster.lastTs <= UTTERANCE_MERGE_WINDOW_MS) {
      cluster.group.entryList.push(entry);
      cluster.lastTs = entry.ts;
    } else {
      const group = createGroup({ keyTs: entry.ts, isKeyed: false });
      group.entryList.push(entry);
      floatingList.push({ group, lastTs: entry.ts });
    }
  }
  for (const { group } of floatingList) {
    // 앞 맥락 절삭 알림만 남은 묶음은 결정이 아니다.
    if (group.entryList.every((entry) => entry.verdict === 'info')) sessionList.push(...group.entryList);
    else groupList.push(group);
  }
}

// 슬라이드 감지(입력)·체류 판정(트리거)은 렌더러 시각을 쓴다. 같은 슬라이드 번호의 고지 흐름에 붙이고,
// 고지 흐름이 없으면(체류 미달·예산 드롭·아직 생성 중) 감지 시각으로 흐름을 따로 만든다.
function attachSlideEntryList({ detectList, dwellList, groupList, captionEventList, sessionList }) {
  const pageGroupList = groupList.filter(isPageGroup).sort((groupA, groupB) => groupA.keyTs - groupB.keyTs);
  for (const group of pageGroupList) group.slideLabel = resolvePageSlideLabel({ group, captionEventList });
  const sortedDetectList = [...detectList].sort((entryA, entryB) => entryA.ts - entryB.ts);
  const episodeMap = new Map();
  const usedGroupSet = new Set();
  for (const detect of sortedDetectList) {
    const label = readSlideLabel(detect);
    const nextDetect = sortedDetectList.find((other) => other.ts > detect.ts && readSlideLabel(other) === label);
    const group = pageGroupList.find((candidate) => !usedGroupSet.has(candidate)
      && candidate.slideLabel === label && candidate.keyTs >= detect.ts
      && candidate.keyTs - detect.ts <= SLIDE_EPISODE_WINDOW_MS && (!nextDetect || candidate.keyTs < nextDetect.ts));
    let episodeGroup = group;
    if (group) {
      usedGroupSet.add(group);
    } else {
      episodeGroup = createGroup({ keyTs: detect.ts, isKeyed: false });
      episodeGroup.slideLabel = label;
      groupList.push(episodeGroup);
    }
    episodeGroup.entryList.push(detect);
    episodeMap.set(detect, episodeGroup);
  }
  for (const dwell of dwellList) {
    const label = readSlideLabel(dwell);
    const detect = sortedDetectList.filter((candidate) => candidate.ts <= dwell.ts && readSlideLabel(candidate) === label).at(-1);
    if (detect) episodeMap.get(detect).entryList.push(dwell);
    else sessionList.push(dwell);
  }
}

function findLatestGroupByText({ groupList, text, ts }) {
  return groupList
    .filter((group) => group.text === text && group.keyTs <= ts)
    .sort((groupA, groupB) => groupB.keyTs - groupA.keyTs)[0] || null;
}

function readGroupText({ group, captionEventList }) {
  const caption = group.isKeyed ? captionEventList.find((event) => event.ts === group.keyTs) : null;
  if (caption?.text) return caption.text;
  for (const stage of ['tts', 'vlm', 'silence', 'speaker', 'value_check', 'toggle', 'dedupe']) {
    const entry = group.entryList.find((candidate) => candidate.stage === stage && readEntryText(candidate));
    if (entry) return readEntryText(entry);
  }
  return null;
}

// 틈 없음·재생 대기 줄 같은 렌더러 기록은 시각이 달라 해설 문장으로 흐름을 찾는다.
function attachTextFloatList({ textFloatList, groupList }) {
  const keyedMap = new Map(groupList.filter((group) => group.isKeyed).map((group) => [group.keyTs, group]));
  for (const entry of textFloatList) {
    const keyed = keyedMap.get(entry.ts);
    const text = readEntryText(entry);
    const target = keyed || (text ? findLatestGroupByText({ groupList, text, ts: entry.ts }) : null);
    if (target) {
      target.entryList.push(entry);
      continue;
    }
    const group = createGroup({ keyTs: entry.ts, isKeyed: false });
    group.entryList.push(entry);
    group.text = text;
    groupList.push(group);
  }
}

function resolveTypeKey({ group, caption }) {
  const entryList = group.entryList;
  if (hasStage(group, ['silence'])) return FLOW_TYPE_MAP.silence;
  if (hasStage(group, ['speaker']) || entryList.some((entry) => entry.narrationType === FLOW_TYPE_MAP.speakerIdentity)) {
    return FLOW_TYPE_MAP.speakerIdentity;
  }
  if (hasStage(group, ['question']) || entryList.some((entry) => entry.narrationType === FLOW_TYPE_MAP.userCommand)) {
    return FLOW_TYPE_MAP.userCommand;
  }
  if (isPageGroup(group) || hasStage(group, ['slide'])) return FLOW_TYPE_MAP.pageTransition;
  const isUtteranceTyped = (entry) => UTTERANCE_TYPE_LIST.includes(entry.narrationType);
  const typed = entryList.filter((entry) => entry.stage === 'vlm' && isUtteranceTyped(entry)).at(-1)
    || entryList.filter((entry) => entry.stage === 'router' && entry.verdict === 'pass' && isUtteranceTyped(entry)).at(-1)
    || entryList.filter(isUtteranceTyped).at(-1);
  if (typed) return typed.narrationType;
  if (hasStage(group, ['screen_dependency', 'budget', 'router', 'judge'])) return FLOW_TYPE_MAP.deixis;
  const captionType = normalizeNarrationType(caption?.source);
  return FLOW_TYPE_LABEL_MAP[captionType] ? captionType : FLOW_TYPE_MAP.unknown;
}

const createStep = ({ entry, stepKind, label, summary = null, ...extra }) => ({
  stage: entry.stage, stepKind, label, verdict: entry.verdict || 'info', reason: entry.reason || '', detail: entry.detail || '',
  summary: summary ?? entry.detail ?? '', ...extra, order: entry.index,
});

function buildAgentStep({ entry, typeKey, label = AGENT_LABEL_MAP[typeKey] }) {
  const text = readEntryText(entry);
  const elapsedMs = readElapsedMs(entry.detail);
  const summary = text ? `"${text}"${Number.isFinite(elapsedMs) ? ` · ${elapsedMs}ms` : ''}` : entry.detail;
  return createStep({ entry, stepKind: STEP_KIND_MAP.agent, label, summary, text: text ?? null, elapsedMs });
}

// 무발화 기록 하나는 조건 → 경량 LLM 판단 → 생성 → 내보내기 결과를 함께 싣는다. 사유로 어느 단계인지 가른다.
function buildSilenceStepList({ entry }) {
  const reason = entry.reason || '';
  if (entry.verdict === 'pass') {
    return [
      createStep({ entry, stepKind: STEP_KIND_MAP.judge, label: SILENCE_JUDGE_LABEL, summary: '화면 제시 단서 있음' }),
      buildAgentStep({ entry, typeKey: FLOW_TYPE_MAP.silence }),
    ];
  }
  if (/^화면 제시 단서 없음/.test(reason)) return [createStep({ entry, stepKind: STEP_KIND_MAP.judge, label: SILENCE_JUDGE_LABEL })];
  if (/^(묘사할 것 없음|끝이 흐린 묘사|무발화 처리 실패)/.test(reason)) return [buildAgentStep({ entry, typeKey: FLOW_TYPE_MAP.silence })];
  if (/^내보내기 억제/.test(reason)) return [createStep({ entry, stepKind: STEP_KIND_MAP.post, label: '내보내기 억제' })];
  return [createStep({ entry, stepKind: STEP_KIND_MAP.trigger, label: '무발화 조건' })];
}

function buildSlideStep({ entry }) {
  const reason = entry.reason || '';
  if (SLIDE_DETECT_PATTERN.test(reason)) return createStep({ entry, stepKind: STEP_KIND_MAP.input, label: `슬라이드 ${readSlideLabel(entry) ?? '-'} 감지` });
  if (SLIDE_DWELL_PATTERN.test(reason)) return createStep({ entry, stepKind: STEP_KIND_MAP.trigger, label: '체류 판정' });
  if (SLIDE_TOPIC_PATTERN.test(reason)) return createStep({ entry, stepKind: STEP_KIND_MAP.judge, label: '주제 판정' });
  return createStep({ entry, stepKind: STEP_KIND_MAP.post, label: '전환 고지 취소' });
}

function buildStepListForEntry({ entry, typeKey }) {
  switch (entry.stage) {
    case 'silence': return buildSilenceStepList({ entry });
    case 'slide': return [buildSlideStep({ entry })];
    case 'vlm': case 'speaker': return [buildAgentStep({ entry, typeKey })];
    case 'screen_dependency':
      return [createStep({ entry, stepKind: STEP_KIND_MAP.trigger, label: STAGE_LABEL_MAP.screen_dependency, summary: readField(entry.detail, '근거') ? `근거="${readField(entry.detail, '근거')}"` : null })];
    case 'budget': {
      const stepKind = entry.verdict === 'info' ? STEP_KIND_MAP.input : STEP_KIND_MAP.trigger;
      const trigger = readField(entry.detail, '트리거');
      return [createStep({ entry, stepKind, label: STAGE_LABEL_MAP.budget, summary: trigger ? `트리거="${trigger}"` : null })];
    }
    case 'router': {
      const candidate = /후보=\[[^\]]*\]/.exec(entry.detail || '')?.[0];
      const route = /경로=\S+/.exec(entry.detail || '')?.[0];
      return [createStep({ entry, stepKind: STEP_KIND_MAP.judge, label: ROUTER_JUDGE_LABEL, summary: [candidate, route].filter(Boolean).join(' · ') || null })];
    }
    case 'judge': case 'screen': return [createStep({ entry, stepKind: STEP_KIND_MAP.judge, label: STAGE_LABEL_MAP[entry.stage] })];
    case 'question':
      return [entry.verdict === 'fail'
        ? buildAgentStep({ entry, typeKey: FLOW_TYPE_MAP.userCommand })
        : createStep({ entry, stepKind: STEP_KIND_MAP.judge, label: STAGE_LABEL_MAP.question })];
    case 'tts': return [createStep({ entry, stepKind: STEP_KIND_MAP.output, label: STAGE_LABEL_MAP.tts })];
    default: return [createStep({ entry, stepKind: STEP_KIND_MAP.post, label: STAGE_LABEL_MAP[entry.stage] || entry.stage })];
  }
}

// 결정의 입력(발화·무음·질문). 페이지 전환은 슬라이드 감지 기록이 곧 입력이다.
function buildInputStep({ group, typeKey }) {
  const entryList = group.entryList;
  const firstIndex = Math.min(...entryList.map((entry) => entry.index));
  const make = (label, detail) => ({
    stage: 'input', stepKind: STEP_KIND_MAP.input, label, verdict: 'info', reason: '', detail, summary: detail, order: firstIndex - 0.5,
  });
  if (typeKey === FLOW_TYPE_MAP.silence) {
    const entry = entryList.find((candidate) => candidate.stage === 'silence');
    const utterance = readField(entry?.detail, '직전 발화');
    const silenceSec = /무음[= ](\d+)초/.exec(entry?.detail || '')?.[1];
    return make('무음', [silenceSec ? `무음 ${silenceSec}초` : '', utterance ? `직전 발화 "${utterance}"` : ''].filter(Boolean).join(' · '));
  }
  if (typeKey === FLOW_TYPE_MAP.userCommand) {
    const entry = entryList.find((candidate) => candidate.stage === 'question');
    const question = readLeadingQuoted(entry?.detail);
    return question ? make('질문', question) : null;
  }
  for (const stage of ['budget', 'router', 'vlm', 'screen_dependency']) {
    const utterance = entryList.filter((entry) => entry.stage === stage).map((entry) => readField(entry.detail, '발화')).find(Boolean);
    if (utterance) return make('발화', utterance);
  }
  return null;
}

function mapStepDropReason(step) {
  if (step.stage === 'toggle') return UNPLAYED_REASON_MAP.featureOff;
  if (step.stage === 'dedupe') {
    if (step.reason === '간격 억제') return UNPLAYED_REASON_MAP.rateLimited;
    const duplicate = /^중복\((.*)\)$/.exec(step.reason);
    if (duplicate) return `duplicate:${duplicate[1]}`;
  }
  return step.reason || step.detail;
}

// 버려짐: 문장을 만든 뒤 후처리·체류 판정에서 막힘. 틈 선택 실패는 트리거 지점에 넣는 것이라 버린 것이 아니다.
const isDropStep = (step) => isSkipVerdict(step.verdict) && step.stage !== 'gap'
  && (step.stepKind === STEP_KIND_MAP.post || step.stepKind === STEP_KIND_MAP.trigger);

function resolveOutcome({ group, stepList, captionList, playbackList, droppedList, toMediaMs, isFinal }) {
  const text = captionList[0]?.text || group.text || null;
  const isOwnCaption = (item) => group.isKeyed && item.ts === group.keyTs;
  const playback = playbackList.find((item) => isOwnCaption(item) && (!text || item.text === text))
    || playbackList.find(isOwnCaption);
  if (playback) {
    const playedWallMs = resolvePlayedWallMs(playback);
    const playedMediaMs = Number.isFinite(playedWallMs) ? roundOrNull(toMediaMs(playedWallMs)) : null;
    return { outcome: { kind: OUTCOME_KIND_MAP.played, reason: null, text: playback.text || text, playedMediaMs }, playback };
  }
  const drop = droppedList.find((item) => isOwnCaption(item) && (!text || item.text === text));
  if (drop) return { outcome: { kind: OUTCOME_KIND_MAP.dropped, reason: drop.reason || null, text: drop.text || text, playedMediaMs: null } };
  if (text) {
    const dropStep = stepList.find(isDropStep);
    if (dropStep) return { outcome: { kind: OUTCOME_KIND_MAP.dropped, reason: mapStepDropReason(dropStep), text, playedMediaMs: null } };
    if (isFinal) {
      const reason = captionList[0]?.hasAudio === false ? UNPLAYED_REASON_MAP.noAudio : UNPLAYED_REASON_MAP.notPlayed;
      return { outcome: { kind: OUTCOME_KIND_MAP.dropped, reason, text, playedMediaMs: null } };
    }
    return { outcome: { kind: OUTCOME_KIND_MAP.pending, reason: null, text, playedMediaMs: null } };
  }
  const lastDecisive = stepList.filter((step) => step.verdict !== 'info').at(-1);
  if (lastDecisive && isSkipVerdict(lastDecisive.verdict)) {
    return { outcome: { kind: OUTCOME_KIND_MAP.blocked, reason: lastDecisive.reason || lastDecisive.detail, text: null, playedMediaMs: null } };
  }
  return { outcome: { kind: OUTCOME_KIND_MAP.pending, reason: null, text: null, playedMediaMs: null } };
}

const formatSec = (ms) => `${(ms / 1000).toFixed(1)}초`;

function buildOutputStep({ outcome, playback }) {
  const base = { stepKind: STEP_KIND_MAP.output, reason: '', order: Infinity };
  if (outcome.kind === OUTCOME_KIND_MAP.played) {
    const detail = Number.isFinite(playback?.durationMs) ? `길이 ${formatSec(playback.durationMs)}` : '';
    return { ...base, stage: 'playback', label: '재생됨', verdict: 'pass', detail, summary: detail };
  }
  if (outcome.kind === OUTCOME_KIND_MAP.dropped) {
    return { ...base, stage: 'drop', label: '버려짐', verdict: 'skip', reason: outcome.reason || '', detail: outcome.reason || '', summary: outcome.reason || '' };
  }
  return null;
}

const sortStepList = (stepList) => [...stepList].sort((stepA, stepB) => (
  STEP_KIND_ORDER_LIST.indexOf(stepA.stepKind) - STEP_KIND_ORDER_LIST.indexOf(stepB.stepKind)) || (stepA.order - stepB.order));

function buildFlow({ group, captionEventList, playbackList, droppedList, toMediaMs, isFinal }) {
  const captionList = group.isKeyed ? captionEventList.filter((event) => event.ts === group.keyTs) : [];
  const typeKey = resolveTypeKey({ group, caption: captionList[0] });
  const inputStep = buildInputStep({ group, typeKey });
  const entryStepList = group.entryList.flatMap((entry) => buildStepListForEntry({ entry, typeKey }));
  const stepList = sortStepList([...(inputStep ? [inputStep] : []), ...entryStepList]);
  const { outcome, playback } = resolveOutcome({ group, stepList, captionList, playbackList, droppedList, toMediaMs, isFinal });
  const outputStep = buildOutputStep({ outcome, playback });
  const ts = Math.min(group.keyTs, ...group.entryList.map((entry) => entry.ts));
  return {
    ts,
    mediaMs: roundOrNull(toMediaMs(ts)),
    typeKey,
    typeLabel: FLOW_TYPE_LABEL_MAP[typeKey],
    slideLabel: group.slideLabel ?? captionList[0]?.slideLabel ?? null,
    stepList: [...stepList, ...(outputStep ? [outputStep] : [])].map(({ order, ...step }) => step),
    outcome,
  };
}

function toSessionInfo({ entry, toMediaMs }) {
  return {
    ts: entry.ts, mediaMs: roundOrNull(toMediaMs(entry.ts)), stage: entry.stage, verdict: entry.verdict || 'info',
    reason: entry.reason || '', detail: entry.detail || '',
  };
}

function toAsrRow({ entry, toMediaMs }) {
  return {
    ts: entry.ts, mediaMs: roundOrNull(toMediaMs(entry.ts)), verdict: entry.verdict || 'info', reason: entry.reason || '',
    text: readLeadingQuoted(entry.detail) ?? entry.detail ?? '',
  };
}

function assignFlowIdList(flowList) {
  const countMap = new Map();
  return flowList.map((flow) => {
    const baseId = `${flow.typeKey}-${flow.ts}`;
    const count = (countMap.get(baseId) || 0) + 1;
    countMap.set(baseId, count);
    return { id: count === 1 ? baseId : `${baseId}-${count}`, ...flow };
  });
}

function buildFlowView({
  debugList = [], captionEventList = [], playbackList = [], droppedList = [], toMediaMs = () => null, isFinal = false,
}) {
  const entryList = normalizeEntryList(debugList);
  const roleListMap = Object.fromEntries(Object.values(ENTRY_ROLE_MAP).map((role) => [role, []]));
  for (const entry of entryList) roleListMap[classifyEntry(entry)].push(entry);
  const sessionList = roleListMap[ENTRY_ROLE_MAP.session];

  const groupList = groupCoreEntryList(roleListMap[ENTRY_ROLE_MAP.core]);
  attachUtteranceEntryList({ utteranceList: roleListMap[ENTRY_ROLE_MAP.utterance], groupList, sessionList });
  attachSlideEntryList({
    detectList: roleListMap[ENTRY_ROLE_MAP.slideDetect], dwellList: roleListMap[ENTRY_ROLE_MAP.slideDwell],
    groupList, captionEventList, sessionList,
  });
  // debug 없이 온 해설도 들린 것이면 흐름으로 보인다.
  const keyedTsSet = new Set(groupList.filter((group) => group.isKeyed).map((group) => group.keyTs));
  for (const caption of captionEventList) {
    if (!Number.isFinite(caption.ts) || keyedTsSet.has(caption.ts)) continue;
    keyedTsSet.add(caption.ts);
    groupList.push(createGroup({ keyTs: caption.ts, isKeyed: true }));
  }
  for (const group of groupList) group.text = readGroupText({ group, captionEventList });
  attachTextFloatList({ textFloatList: roleListMap[ENTRY_ROLE_MAP.textFloat], groupList });

  const flowList = groupList
    .map((group) => buildFlow({ group, captionEventList, playbackList, droppedList, toMediaMs, isFinal }))
    .sort((flowA, flowB) => flowA.ts - flowB.ts);
  const byTs = (itemA, itemB) => itemA.ts - itemB.ts;
  return {
    flowList: assignFlowIdList(flowList),
    sessionInfoList: [...sessionList].sort((entryA, entryB) => byTs(entryA, entryB) || entryA.index - entryB.index)
      .map((entry) => toSessionInfo({ entry, toMediaMs })),
    asrList: roleListMap[ENTRY_ROLE_MAP.asr].map((entry) => toAsrRow({ entry, toMediaMs })).sort(byTs),
  };
}

const buildFlowList = (input) => buildFlowView(input).flowList;

const TRACK_STATE_MAP = { idle: 'idle', active: 'active', pass: 'pass', skip: 'skip', fail: 'fail' };
const TRACK_RECENT_MS = 3000;
const TRACK_LIST = [
  { key: 'asr', label: 'ASR', stageList: ['asr'] },
  { key: 'page_transition', label: '페이지 전환', stageList: ['slide', 'screen'] },
  { key: 'judge', label: '지시·발화 판단', stageList: ['screen_dependency', 'budget', 'router', 'judge'] },
  { key: 'silence', label: '무발화', stageList: ['silence'] },
  { key: 'vlm', label: 'VLM 생성', stageList: ['vlm', 'vlm_fallback', 'speaker', 'question'] },
  { key: 'output', label: 'TTS·재생', stageList: ['tts', 'queue', 'gap', 'dedupe', 'toggle'] },
];
const OUTPUT_TRACK_KEY = 'output';

const verdictToState = (verdict) => (TRACK_STATE_MAP[verdict] && verdict !== TRACK_STATE_MAP.idle ? verdict : TRACK_STATE_MAP.active);

// main 기록의 ts 는 결정 시각이라 받은 시각(receivedWallMs)으로 최근 여부를 본다.
function summarizeTrackList({ debugList = [], playbackList = [], nowWallMs }) {
  const latestMap = new Map();
  const remember = (key, item) => {
    const previous = latestMap.get(key);
    if (!previous || item.wallMs >= previous.wallMs) latestMap.set(key, item);
  };
  for (const entry of debugList) {
    if (!entry) continue;
    const track = TRACK_LIST.find((candidate) => candidate.stageList.includes(entry.stage || 'judge'));
    const wallMs = Number.isFinite(entry.receivedWallMs) ? entry.receivedWallMs : entry.ts;
    // 지금(nowWallMs) 시점의 신호등이라 그 뒤에 받은 기록은 보지 않는다.
    if (!track || !Number.isFinite(wallMs) || wallMs > nowWallMs) continue;
    remember(track.key, {
      wallMs, state: verdictToState(entry.verdict), detail: entry.detail ? `${entry.reason || ''} · ${entry.detail}` : entry.reason || '',
    });
  }
  for (const playback of playbackList) {
    if (!Number.isFinite(playback?.wallMs) || playback.wallMs > nowWallMs) continue;
    const endWallMs = playback.wallMs + (Number(playback.durationMs) || 0);
    remember(OUTPUT_TRACK_KEY, {
      wallMs: endWallMs, startWallMs: playback.wallMs, isPlayback: true, detail: `재생 "${playback.text || ''}"`,
    });
  }
  return TRACK_LIST.map(({ key, label }) => {
    const latest = latestMap.get(key);
    if (!latest) return { key, label, state: TRACK_STATE_MAP.idle, lastDetail: '', lastWallMs: null };
    const isRecent = nowWallMs - latest.wallMs <= TRACK_RECENT_MS;
    let state = isRecent ? latest.state : TRACK_STATE_MAP.idle;
    if (latest.isPlayback) {
      if (nowWallMs >= latest.startWallMs && nowWallMs < latest.wallMs) state = TRACK_STATE_MAP.active;
      else state = isRecent ? TRACK_STATE_MAP.pass : TRACK_STATE_MAP.idle;
    }
    return { key, label, state, lastDetail: latest.detail, lastWallMs: latest.isPlayback ? latest.startWallMs : latest.wallMs };
  });
}

module.exports = {
  buildFlowList, buildFlowView, summarizeTrackList, normalizeNarrationType,
  FLOW_TYPE_MAP, FLOW_TYPE_LABEL_MAP, AGENT_LABEL_MAP, STEP_KIND_MAP, OUTCOME_KIND_MAP, TRACK_STATE_MAP, TRACK_LIST,
};
