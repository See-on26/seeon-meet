const { formatElapsed } = require('./clock-format');

const EMPTY_SCRIPT_TEXT = '(기록된 발화가 없습니다)';

function resolveSlideTitle(slide) {
  return slide?.label?.title || slide?.pageTopic || '';
}

// 회의 대화 전문. 화자는 Meet 화면 표시로 추정한 힌트가 있을 때만 적는다.
function buildTranscriptScript({ snapshot }) {
  const utteranceList = [...(snapshot.utteranceList || [])].sort((left, right) => left.ts - right.ts);
  if (!utteranceList.length) return EMPTY_SCRIPT_TEXT;
  const slideByMajorMap = new Map((snapshot.slideList || []).map((slide) => [slide.major, slide]));
  const lineList = [];
  let lastSlideMajor = null;
  for (const utterance of utteranceList) {
    if (utterance.slideMajor !== null && utterance.slideMajor !== lastSlideMajor) {
      const slide = slideByMajorMap.get(utterance.slideMajor);
      const title = resolveSlideTitle(slide);
      lineList.push(`── 슬라이드 ${slide?.displayNumber ?? utterance.slideMajor}${title ? `: ${title}` : ''} ──`);
      lastSlideMajor = utterance.slideMajor;
    }
    const speaker = utterance.speakerHint ? `${utterance.speakerHint}: ` : '';
    lineList.push(`[${formatElapsed({ ts: utterance.ts, startedAt: snapshot.startedAt })}] ${speaker}${utterance.text}`);
  }
  return lineList.join('\n');
}

function buildScriptFileName({ sessionId }) {
  return `${String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '')}-script.txt`;
}

module.exports = { buildTranscriptScript, buildScriptFileName };
