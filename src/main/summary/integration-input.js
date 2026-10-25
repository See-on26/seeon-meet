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

// 그 화면을 처음 설명한 전환 해설. 복귀 고지는 주제만 짧게 말하므로 처음 온 때의 해설이 없을 때만 쓴다.
function findScreenDescription({ slide, slideMajor, transitionList, cancelledList }) {
  const liveList = transitionList.filter((transition) => transition.slideMajor === slideMajor
    && !isCancelledTransition({ transition, cancelledList }));
  const transition = liveList.find((entry) => !entry.isRevisit) || liveList[0];
  return transition?.text || slide?.label?.title || '';
}

function isScreenlessSegment(segment) {
  return segment.slideMajor === null || segment.slideMajor === undefined;
}

function buildSegmentTag({ slide, segment }) {
  if (isScreenlessSegment(segment)) return NO_SCREEN_TAG;
  return `${formatHeardSlideTag({ displayNumber: slide?.displayNumber })}${segment.isRevisit ? REVISIT_TAG : ''}`;
}

// 블록은 머리 줄 하나와 본문이다. 줄인 묶음은 묶인 구간들의 시각과 화면을 모두 머리 줄에 단다.
function listSegmentBlock({ segmentSummaryList, snapshot }) {
  const slideByMajorMap = new Map((snapshot.slideList || []).map((slide) => [slide.major, slide]));
  const transitionList = snapshot.transitionList || [];
  const cancelledList = snapshot.cancelledTransitionList || [];
  return [...(segmentSummaryList || [])]
    .filter((segment) => typeof segment.text === 'string' && segment.text.trim())
    .sort((left, right) => left.startTs - right.startTs)
    .map((segment) => {
      const slide = slideByMajorMap.get(segment.slideMajor);
      return {
        startTs: segment.startTs,
        endTs: segment.endTs,
        tagList: [buildSegmentTag({ slide, segment })],
        description: isScreenlessSegment(segment) ? '' : findScreenDescription({
          slide, slideMajor: segment.slideMajor, transitionList, cancelledList,
        }),
        bodyText: segment.text.trim(),
      };
    });
}

function renderBlock({ block, startedAt }) {
  const timeText = `[${formatElapsed({ ts: block.startTs, startedAt })}~${formatElapsed({ ts: block.endTs, startedAt })}]`;
  const headLine = `${timeText} ${block.tagList.join(', ')}${block.description ? ` — ${block.description}` : ''}`;
  return `${headLine}\n${block.bodyText}`;
}

function renderBlockList({ blockList, startedAt }) {
  return blockList.map((block) => renderBlock({ block, startedAt })).join(BLOCK_SEPARATOR);
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
function buildIntegrationInput({ segmentSummaryList, snapshot }) {
  return renderBlockList({ blockList: listSegmentBlock({ segmentSummaryList, snapshot }), startedAt: snapshot.startedAt });
}

// 통합 입력이 maxChars 를 넘으면 이어진 구간을 묶어 reduce(구간 요약 에이전트)로 줄이고 다시 잰다.
// 세 번 줄여도 넘치면 앞에서부터 maxChars 까지만 남기고 isTruncated 를 켠다. reduce 오류는 그대로 던진다.
async function fitIntegrationInput({
  segmentSummaryList, snapshot, language, maxChars = DEFAULT_INTEGRATION_MAX_CHARS, reduce,
}) {
  const { startedAt } = snapshot;
  let blockList = listSegmentBlock({ segmentSummaryList, snapshot });
  let text = renderBlockList({ blockList, startedAt });
  const bundleMaxChars = Math.floor(maxChars / REDUCE_BUNDLE_RATIO);
  for (let round = 0; round < MAX_REDUCE_ROUND_COUNT && text.length > maxChars; round += 1) {
    const reducedList = [];
    for (const bundle of splitBundleList({ blockList, startedAt, bundleMaxChars })) {
      reducedList.push(...await reduceBundle({ bundle, startedAt, language, reduce }));
    }
    blockList = reducedList;
    text = renderBlockList({ blockList, startedAt });
  }
  if (text.length <= maxChars) return { text, isTruncated: false };
  return { text: text.slice(0, maxChars), isTruncated: true };
}

module.exports = { buildIntegrationInput, fitIntegrationInput, DEFAULT_INTEGRATION_MAX_CHARS };
