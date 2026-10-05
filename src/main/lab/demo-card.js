// 시연 창 카드. 해설이 들리기 시작할 때(재생 시작 알림) 분류 배지와 문장, 작게 보일 근거를 만든다.
const DEMO_BADGE_MAP = {
  page_transition: '페이지 전환',
  deixis: '지시 대상',
  interpretation: '수치 의미',
  visual_description: '시각 정보',
  user_command: '질문 답',
  speaker_identity: '화자',
};

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
    badge: DEMO_BADGE_MAP[type] || DEFAULT_BADGE,
    text: playback.text,
    rationaleText: buildRationaleText(caption?.rationale),
    wallMs: playback.wallMs,
  };
}

module.exports = { buildDemoCard, DEMO_BADGE_MAP };
