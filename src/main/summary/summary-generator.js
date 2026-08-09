const fs = require('fs');
const path = require('path');
const { createSlideRecaptionAgent } = require('../caption-pipeline/agents/slide-recaption-agent');
const { createMeetingSummaryAgent } = require('../caption-pipeline/output/meeting-summary-agent');
const { createTtsClient } = require('../caption-pipeline/output/tts-client');
const { buildSlideIntervalList, assignAsrToSlideList } = require('./slide-timeline');
const { resolveSlideAssetList } = require('./slide-asset-resolver');
const { buildSummaryDocument, findMarkupViolationList, buildSummaryFileName } = require('./summary-document');

const RECAPTION_CONCURRENCY = 3;

const RECAPTION_FAILURE_TEXT = '(이 슬라이드는 화면 설명을 만들지 못했습니다)';

const SUMMARY_STAGE_MAP = {
  collect: 'collect',
  recaption: 'recaption',
  summarize: 'summarize',
  speak: 'speak',
  done: 'done',
  fail: 'fail',
};

async function mapWithConcurrencyLimit({ itemList, limit, run }) {
  const resultList = new Array(itemList.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < itemList.length) {
      const index = nextIndex;
      nextIndex += 1;
      resultList[index] = await run({ item: itemList[index], index });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, itemList.length) }, runWorker));
  return resultList;
}

function createSummaryGenerator({ config, summariesDir, onProgress = null }) {
  const recaptionAgent = createSlideRecaptionAgent({ config });
  const summaryAgent = createMeetingSummaryAgent({ config });
  const ttsClient = createTtsClient({ config });

  function reportProgress({ stage, message, doneCount = 0, totalCount = 0 }) {
    console.log(`[summary] ${message}`);
    onProgress?.({ stage, message, doneCount, totalCount });
  }

  async function recaptionSlide({ asset }) {
    try {
      const baseJpegBuffer = fs.readFileSync(asset.baseFilePath);
      const annotationJpegBuffer = asset.lastAnnotationFilePath
        ? fs.readFileSync(asset.lastAnnotationFilePath) : null;
      return await recaptionAgent.generate({
        baseJpegBuffer, annotationJpegBuffer, slideMajor: asset.major,
      });
    } catch (error) {
      console.warn(`[summary] 슬라이드 ${asset.major} 재캡션 실패: ${error.message}`);
      return { title: '', bodyText: RECAPTION_FAILURE_TEXT, annotationText: '' };
    }
  }

  function buildSlideSectionList({ session, assetList, recaptionList }) {
    const slideIntervalList = buildSlideIntervalList({
      slideMarkList: session.slideMarkList, sessionEndTs: session.endedAt,
    });
    const utteranceListByMajorMap = new Map(
      assignAsrToSlideList({ asrEntryList: session.asrEntryList, slideIntervalList })
        .map((slide) => [slide.major, slide.utteranceList]),
    );
    return assetList.map((asset, index) => ({
      major: asset.major,
      ...recaptionList[index],
      utteranceList: utteranceListByMajorMap.get(asset.major) || [],
    }));
  }

  async function generate({ session }) {
    const assetList = resolveSlideAssetList({ slideMarkList: session.slideMarkList });
    reportProgress({
      stage: SUMMARY_STAGE_MAP.collect,
      message: `요약 재료 수집 — 슬라이드 ${assetList.length}장 · 발화 ${session.asrEntryList.length}건`,
    });

    let doneCount = 0;
    const recaptionList = await mapWithConcurrencyLimit({
      itemList: assetList,
      limit: RECAPTION_CONCURRENCY,
      run: async ({ item }) => {
        const recaption = await recaptionSlide({ asset: item });
        doneCount += 1;
        reportProgress({
          stage: SUMMARY_STAGE_MAP.recaption,
          message: `슬라이드 화면 설명 ${doneCount}/${assetList.length}`,
          doneCount, totalCount: assetList.length,
        });
        return recaption;
      },
    });

    reportProgress({ stage: SUMMARY_STAGE_MAP.summarize, message: '회의 요약 생성 중' });
    const slideSectionList = buildSlideSectionList({ session, assetList, recaptionList });
    const { text, isTruncated } = await summaryAgent.summarize({ slideSectionList });

    const documentText = buildSummaryDocument({
      meetingMeta: {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        slideCount: assetList.length,
        utteranceCount: session.asrEntryList.length,
      },
      bodyText: text,
      isTruncated,
    });

    const violationList = findMarkupViolationList({ text: documentText });
    if (violationList.length) {
      console.warn(`[summary] 형식 위반 ${violationList.length}건 (첫 건: ${violationList[0].lineNumber}행 ${violationList[0].reason})`);
    }

    fs.mkdirSync(summariesDir, { recursive: true });
    const textFilePath = path.join(
      summariesDir, buildSummaryFileName({ sessionId: session.sessionId, extension: 'txt' }),
    );
    fs.writeFileSync(textFilePath, documentText, 'utf8');

    const audioFilePath = await synthesizeSummaryAudio({
      sessionId: session.sessionId, documentText,
    });

    reportProgress({
      stage: SUMMARY_STAGE_MAP.done,
      message: audioFilePath
        ? `요약본 저장 완료 — ${path.basename(textFilePath)} · ${path.basename(audioFilePath)}`
        : `요약본 저장 완료 — ${path.basename(textFilePath)} (음성 없음)`,
    });
    return {
      isOk: true,
      textFilePath,
      audioFilePath,
      documentText,
      slideCount: assetList.length,
      violationCount: violationList.length,
      isTruncated,
    };
  }

  async function synthesizeSummaryAudio({ sessionId, documentText }) {
    reportProgress({ stage: SUMMARY_STAGE_MAP.speak, message: '요약본 음성 합성 중' });
    try {
      const mp3Buffer = await ttsClient.synthesizeLong({ text: documentText });
      const audioFilePath = path.join(
        summariesDir, buildSummaryFileName({ sessionId, extension: 'mp3' }),
      );
      fs.writeFileSync(audioFilePath, mp3Buffer);
      return audioFilePath;
    } catch (error) {
      console.warn(`[summary] 요약본 음성 합성 실패(텍스트만 남김): ${error.message}`);
      return null;
    }
  }

  return { generate };
}

module.exports = {
  createSummaryGenerator, mapWithConcurrencyLimit,
  SUMMARY_STAGE_MAP, RECAPTION_CONCURRENCY, RECAPTION_FAILURE_TEXT,
};
