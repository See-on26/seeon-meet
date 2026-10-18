// 시연 창 카드. 해설이 들리기 시작할 때(재생 시작 알림) 분류 배지와 문장, 작게 보일 근거를 만든다.
// 배지는 viewer 카드와 같은 아키텍처 기준(재생 분류) 이름이다.
const { resolveAdLabel } = require('./ad-code');

const LEGACY_TRANSITION_SOURCE = 'page-transition';
const DEFAULT_BADGE = '화면 해설';

function normalizeType(source) {
  return source === LEGACY_TRANSITION_SOURCE ? 'page_transition' : source || null;
}

function buildRationaleText(rationale) {
  if (!rationale) return '';
  const partList = [];
  if (rationale.utterance) partList.push(`발화 "${rationale.utterance}"`);
  if (rationale.summary) partList.push(rationale.summary);
  return partList.join(' · ');
}

function buildDemoCard({ playback, caption = null }) {
  const type = normalizeType(caption?.source || playback.source);
  return {
    id: `${playback.ts}|${playback.text}`,
    type,
    badge: resolveAdLabel({ narrationClass: caption?.narrationClass || playback.narrationClass, type }) || DEFAULT_BADGE,
    text: playback.text,
    rationaleText: buildRationaleText(caption?.rationale),
    wallMs: playback.wallMs,
  };
}

module.exports = { buildDemoCard };
