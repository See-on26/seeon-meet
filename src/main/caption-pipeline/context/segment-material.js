const { formatElapsed } = require('./clock-format');
const { formatHeardSlideTag } = require('./slide-tag');
const { NARRATION_CLASS_MAP } = require('../contracts/narration-types');

// 표·문서 화면은 글자가 수천 자라 이만큼까지만 담는다. 넘치면 그 구간에 오간 말이 재료에서 묻힌다.
const SLIDE_TEXT_MAX_CHARS = 1500;
// 질문 답은 "질문·답" 칸에 따로 담고, 화자 안내는 누가 말하는지만 알리므로 해설 칸에서 뺀다.
const EXCLUDED_NARRATION_CLASS_LIST = [NARRATION_CLASS_MAP.userCommand, NARRATION_CLASS_MAP.speakerIdentity];
const EMPTY_SECTION_LINE = '(없음)';
const REVISIT_NOTE = ' (앞에서 본 화면으로 다시 돌아온 구간)';

// 구간은 [startTs, endTs) 다. 끝 시각의 발화는 다음 구간의 첫 발화다.
function isInSegment({ ts, segment }) {
  return Number.isFinite(ts) && ts >= segment.startTs && ts < segment.endTs;
}

function listInSegment({ itemList, segment }) {
  return (itemList || []).filter((item) => isInSegment({ ts: item.ts, segment }));
}

// 화면 묘사도 라벨도 없는 화면(전환 해설이 한 번도 없던 화면)만 회의 뒤 화면 정보 텍스트화 한 줄로 채운다.
function isScreenFillNeeded({ slide }) {
  return !slide.description && !slide.label?.title && !slide.label?.summary;
}

function listSlideInfoLine({ slide, screenFillByMajorMap }) {
  const title = slide.label?.title || '';
  const summary = slide.label?.summary || '';
  const fill = isScreenFillNeeded({ slide }) ? screenFillByMajorMap?.get(String(slide.major)) || '' : '';
  return [
    slide.pageTopic ? `화면 주제: ${slide.pageTopic}` : '',
    slide.description ? `화면 묘사: ${slide.description}` : '',
    fill ? `화면 설명: ${fill}` : '',
    slide.slideText ? `화면 글자: ${slide.slideText.slice(0, SLIDE_TEXT_MAX_CHARS)}` : '',
    title ? `라벨 제목: ${title}` : '',
    summary ? `라벨 요약: ${summary}` : '',
  ].filter(Boolean);
}

function isNoScreenSegment(segment) {
  return segment.slideMajor === null || segment.slideMajor === undefined;
}

function findSegmentSlide({ snapshot, segment }) {
  if (isNoScreenSegment(segment)) return null;
  return (snapshot.slideList || []).find((entry) => entry.major === segment.slideMajor) || null;
}

function buildScreenLineList({ snapshot, segment, screenFillByMajorMap }) {
  if (isNoScreenSegment(segment)) return ['화면: 공유 화면 없음'];
  const slide = findSegmentSlide({ snapshot, segment });
  const headLine = `화면: ${formatHeardSlideTag({ displayNumber: slide?.displayNumber })}${segment.isRevisit ? REVISIT_NOTE : ''}`;
  const infoLineList = slide ? listSlideInfoLine({ slide, screenFillByMajorMap }) : [];
  return [headLine, ...(infoLineList.length ? infoLineList : [`화면 정보: ${EMPTY_SECTION_LINE}`])];
}

function listSegmentRecord({ snapshot, segment }) {
  return {
    utteranceList: listInSegment({ itemList: snapshot.utteranceList, segment }),
    narrationList: listInSegment({ itemList: snapshot.narrationList, segment })
      .filter((narration) => !EXCLUDED_NARRATION_CLASS_LIST.includes(narration.narrationClass)),
    qaList: listInSegment({ itemList: snapshot.qaList, segment }),
  };
}

function buildSection({ title, lineList }) {
  return ['', `${title}:`, ...(lineList.length ? lineList : [EMPTY_SECTION_LINE])];
}

function formatQaLineList({ qa }) {
  return [`질문: ${qa.question}`, ...(qa.answer ? [`답: ${qa.answer}`] : [])];
}

// 구간 요약 에이전트에 줄 구간 하나의 재료. 요약은 누가 말했는지 쓰지 않으므로 발화는 화자 없이 말만 담는다.
// screenFillByMajorMap 은 회의 뒤 화면 정보 텍스트화 결과(슬라이드 번호 문자열 → 한 줄)다. 회의 중에는 없다.
function buildSegmentMaterial({ snapshot, segment, screenFillByMajorMap = null }) {
  const { startedAt } = snapshot;
  const { utteranceList, narrationList, qaList } = listSegmentRecord({ snapshot, segment });
  return [
    `구간: [${formatElapsed({ ts: segment.startTs, startedAt })}~${formatElapsed({ ts: segment.endTs, startedAt })}]`,
    ...buildScreenLineList({ snapshot, segment, screenFillByMajorMap }),
    ...buildSection({ title: '오간 말', lineList: utteranceList.map((utterance) => utterance.text) }),
    ...buildSection({
      title: '들려준 해설 (화면을 볼 수 없는 참석자에게 읽어 준 화면 설명)',
      lineList: narrationList.map((narration) => narration.text),
    }),
    ...buildSection({
      title: '질문·답 (화면을 볼 수 없는 참석자가 묻고 들은 답)',
      lineList: qaList.flatMap((qa) => formatQaLineList({ qa })),
    }),
  ].join('\n');
}

// 구간 재료에 담을 것이 있는가. 오간 말·해설·질문답이 없고 화면 정보(주제·묘사·글자·라벨·채움 줄)도 없으면
// 요약할 것이 없으므로 GPU 에 묻지 않고 빈 구간으로 둔다. 회의 중 스케줄러와 회의 뒤 생성기가 같이 쓴다.
function hasSegmentContent({ snapshot, segment, screenFillByMajorMap = null }) {
  const { utteranceList, narrationList, qaList } = listSegmentRecord({ snapshot, segment });
  if (utteranceList.length || narrationList.length || qaList.length) return true;
  const slide = findSegmentSlide({ snapshot, segment });
  return Boolean(slide) && listSlideInfoLine({ slide, screenFillByMajorMap }).length > 0;
}

module.exports = { buildSegmentMaterial, hasSegmentContent, isScreenFillNeeded };
