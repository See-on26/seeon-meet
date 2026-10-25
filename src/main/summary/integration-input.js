const { formatElapsed } = require('../caption-pipeline/context/clock-format');
const { formatHeardSlideTag } = require('../caption-pipeline/context/slide-tag');
const { isCancelledTransition } = require('../caption-pipeline/context/cancelled-transition');

// 통합 요약 입력의 글자 수 상한. 8801 의 문맥 32,768 토큰에 지시문과 최대 출력 6,000 토큰이 함께 들어가야 한다.
const DEFAULT_INTEGRATION_MAX_CHARS = 24000;
// 넘치면 이어진 구간을 이 비율 이하의 묶음으로 나눠 줄인다.
const REDUCE_BUNDLE_RATIO = 4;
const MAX_REDUCE_ROUND_COUNT = 3;
const NO_SCREEN_TAG = '화면 없음';
const REVISIT_TAG = ' (다시 봄)';
const BLOCK_SEPARATOR = '\n\n';
// 슬라이드 구간이 하나도 없는 회의. 머리 줄이 모두 "화면 없음"이라 모델이 화면 자료를 찾지 않게 먼저 알린다.
const NO_SCREEN_SHARE_NOTICE = '이 회의에서는 공유 화면 전환이 감지되지 않았다. 화면 자료 없이 대화만 오갔다.';

// 그 화면을 처음 설명한 전환 해설. 복귀 고지는 주제만 짧게 말하므로 처음 온 때의 해설이 없을 때만 쓴다.
function findScreenDescription({ slide, slideMajor, transitionList, cancelledList }) {
  const liveList = transitionList.filter((transition) => transition.slideMajor === slideMajor
    && !isCancelledTransition({ transition, cancelledList }));
  const transition = liveList.find((entry) => !entry.isRevisit) || liveList[0];
  return transition?.text || slide?.label?.title || '';
}

function readSlideMajor(segment) {
  return segment.slideMajor ?? null;
}

function readSummaryText(segment) {
  return typeof segment.text === 'string' ? segment.text.trim() : '';
}

function buildSegmentTag({ slide, segment }) {
  if (readSlideMajor(segment) === null) return NO_SCREEN_TAG;
  return `${formatHeardSlideTag({ displayNumber: slide?.displayNumber })}${segment.isRevisit ? REVISIT_TAG : ''}`;
}

// 한 방문을 시간으로 끊은 조각은 같은 화면·같은 다시 봄 여부이고 앞 조각이 끝난 시각에 시작한다.
function isContinuedPiece({ previous, segment }) {
  return readSlideMajor(previous) === readSlideMajor(segment)
    && Boolean(previous.isRevisit) === Boolean(segment.isRevisit)
    && segment.startTs === previous.endTs;
}

// 지시문은 머리 줄 하나를 화면 하나로 읽으므로, 같은 방문의 이어진 조각은 한 묶음으로 모은다.
// 빈 요약 조각도 시각을 잇는 데는 쓴다.
function groupContinuedPieceList(segmentSummaryList) {
  const groupList = [];
  for (const segment of [...segmentSummaryList].sort((left, right) => left.startTs - right.startTs)) {
    const currentGroup = groupList.at(-1);
    if (currentGroup && isContinuedPiece({ previous: currentGroup.at(-1), segment })) currentGroup.push(segment);
    else groupList.push([segment]);
  }
  return groupList;
}

// 블록은 머리 줄 하나와 본문이다. 줄인 묶음은 묶인 구간들의 시각과 화면을 모두 머리 줄에 단다.
function listSegmentBlock({ segmentSummaryList, snapshot }) {
  const slideByMajorMap = new Map((snapshot.slideList || []).map((slide) => [slide.major, slide]));
  const transitionList = snapshot.transitionList || [];
  const cancelledList = snapshot.cancelledTransitionList || [];
  return groupContinuedPieceList(segmentSummaryList)
    .map((pieceList) => {
      const bodyText = pieceList.map(readSummaryText).filter(Boolean).join('\n');
      if (!bodyText) return null;
      const [firstPiece] = pieceList;
      const slideMajor = readSlideMajor(firstPiece);
      const slide = slideByMajorMap.get(slideMajor);
      return {
        startTs: firstPiece.startTs,
        endTs: pieceList.at(-1).endTs,
        tagList: [buildSegmentTag({ slide, segment: firstPiece })],
        description: slideMajor === null ? '' : findScreenDescription({
          slide, slideMajor, transitionList, cancelledList,
        }),
        bodyText,
      };
    })
    .filter(Boolean);
}

function renderBlock({ block, startedAt }) {
  const timeText = `[${formatElapsed({ ts: block.startTs, startedAt })}~${formatElapsed({ ts: block.endTs, startedAt })}]`;
  const headLine = `${timeText} ${block.tagList.join(', ')}${block.description ? ` — ${block.description}` : ''}`;
  return `${headLine}\n${block.bodyText}`;
}

function renderBlockList({ blockList, startedAt }) {
  return blockList.map((block) => renderBlock({ block, startedAt })).join(BLOCK_SEPARATOR);
}

// 블록이 없으면 빈 글이다. 안내 줄만 있는 입력으로 통합을 부르지 않게 한다.
function renderIntegrationText({ blockList, startedAt, isScreenShared }) {
  if (!blockList.length) return '';
  const blockText = renderBlockList({ blockList, startedAt });
  return isScreenShared ? blockText : `${NO_SCREEN_SHARE_NOTICE}${BLOCK_SEPARATOR}${blockText}`;
}

// 빈 요약 구간까지 본다. 슬라이드 구간이 있었다면 그 요약이 비었어도 화면 공유가 있던 회의다.
function hasScreenSegment(segmentSummaryList) {
  return segmentSummaryList.some((segment) => readSlideMajor(segment) !== null);
}

// 이어진 블록을 글자 수 한도 안의 묶음으로 나눈다. 한 블록이 한도를 넘으면 그 블록 혼자 한 묶음이다.
function splitBundleList({ blockList, startedAt, bundleMaxChars }) {
  const bundleList = [];
  let currentList = [];
  for (const block of blockList) {
    const candidateList = [...currentList, block];
    if (currentList.length && renderBlockList({ blockList: candidateList, startedAt }).length > bundleMaxChars) {
      bundleList.push(currentList);
      currentList = [block];
    } else {
      currentList = candidateList;
    }
  }
  if (currentList.length) bundleList.push(currentList);
  return bundleList;
}

// 줄인 글이 비면 묶음을 그대로 둔다. 구간 요약을 잃는 것보다 다음 번 줄이기나 자르기에 맡기는 편이 낫다.
async function reduceBundle({ bundle, startedAt, language, reduce }) {
  const { text } = await reduce({ text: renderBlockList({ blockList: bundle, startedAt }), language });
  const reducedText = typeof text === 'string' ? text.trim() : '';
  if (!reducedText) return bundle;
  return [{
    startTs: bundle[0].startTs,
    endTs: bundle.at(-1).endTs,
    tagList: [...new Set(bundle.flatMap((block) => block.tagList))],
    description: '',
    bodyText: reducedText,
  }];
}

// 회의 뒤 통합 요약의 재료. 구간마다 머리 줄(시각·슬라이드·그 화면 설명)과 구간 요약이고, 빈 구간 요약은 뺀다.
// 머리 줄 표기는 구간 재료처럼 캡션 언어와 상관없이 한국어다(지시문이 한국어로 이 형식을 설명한다).
function buildIntegrationInput({ segmentSummaryList = [], snapshot }) {
  return renderIntegrationText({
    blockList: listSegmentBlock({ segmentSummaryList, snapshot }),
    startedAt: snapshot.startedAt,
    isScreenShared: hasScreenSegment(segmentSummaryList),
  });
}

// 통합 입력이 maxChars 를 넘으면 이어진 구간을 묶어 reduce(구간 요약 에이전트)로 줄이고 다시 잰다.
// 세 번 줄여도 넘치면 앞에서부터 maxChars 까지만 남기고 isTruncated 를 켠다. reduce 오류는 그대로 던진다.
async function fitIntegrationInput({
  segmentSummaryList = [], snapshot, language, maxChars = DEFAULT_INTEGRATION_MAX_CHARS, reduce,
}) {
  const { startedAt } = snapshot;
  const isScreenShared = hasScreenSegment(segmentSummaryList);
  let blockList = listSegmentBlock({ segmentSummaryList, snapshot });
  let text = renderIntegrationText({ blockList, startedAt, isScreenShared });
  const bundleMaxChars = Math.floor(maxChars / REDUCE_BUNDLE_RATIO);
  for (let round = 0; round < MAX_REDUCE_ROUND_COUNT && text.length > maxChars; round += 1) {
    const reducedList = [];
    for (const bundle of splitBundleList({ blockList, startedAt, bundleMaxChars })) {
      reducedList.push(...await reduceBundle({ bundle, startedAt, language, reduce }));
    }
    blockList = reducedList;
    text = renderIntegrationText({ blockList, startedAt, isScreenShared });
  }
  if (text.length <= maxChars) return { text, isTruncated: false };
  return { text: text.slice(0, maxChars), isTruncated: true };
}

module.exports = { buildIntegrationInput, fitIntegrationInput, DEFAULT_INTEGRATION_MAX_CHARS };
