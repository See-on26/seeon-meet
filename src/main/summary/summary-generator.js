const fs = require('fs');
const path = require('path');
const { createSlideRecaptionAgent } = require('../caption-pipeline/agents/slide-recaption-agent');
const { createMeetingSummaryAgent } = require('../caption-pipeline/output/meeting-summary-agent');
const { createSummaryRewriteAgent } = require('../caption-pipeline/output/summary-rewrite-agent');
const { createTtsClient } = require('../caption-pipeline/output/tts-client');
const { flattenAsrSegmentList } = require('./slide-timeline');
const { resolveSlideAssetList } = require('./slide-asset-resolver');
const { buildSummaryDocument, findMarkupViolationList, buildSummaryFileName } = require('./summary-document');
const {
  buildTranscriptScript, listSlideMajorWithoutTransitionLine,
} = require('../caption-pipeline/context/transcript-script');

const RECAPTION_CONCURRENCY = 3;
// 화면 정보 텍스트화 결과를 스크립트 한 줄로 쓸 때의 최대 길이.
const SCREEN_FILL_MAX_CHARS = 80;

const SUMMARY_STAGE_MAP = {
  collect: 'collect',
  recaption: 'recaption',
  summarize: 'summarize',
  script: 'script',
  rewrite: 'rewrite',
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

// 화면 정보 텍스트화 결과를 스크립트 한 줄로 줄인다. 제목이 있으면 제목, 없으면 화면 서술의 첫 문장이다.
function toScreenFillText(recaption) {
  const title = String(recaption?.title ?? '').trim();
  if (title) return title;
  const firstSentence = String(recaption?.bodyText ?? '').trim().split(/(?<=[.!?])\s|\n/)[0] || '';
  return firstSentence.length > SCREEN_FILL_MAX_CHARS
    ? `${firstSentence.slice(0, SCREEN_FILL_MAX_CHARS)}…` : firstSentence;
}

// 맥락 저장소 스냅숏이 없으면(세션 기록만 남은 경우) 발화만으로 스크립트를 만든다. 화자 힌트는 기록에 있으면 쓴다.
function buildSnapshotFromSession({ session }) {
  const utteranceList = [];
  for (const entry of session.asrEntryList || []) {
    for (const segment of flattenAsrSegmentList({ asrEntryList: [entry] })) {
      utteranceList.push({ ts: segment.ts, text: segment.text, speakerHint: entry.speakerHint || null });
    }
  }
  return { startedAt: session.startedAt, slideList: [], transitionList: [], utteranceList };
}

function countScreen({ snapshot }) {
  return new Set((snapshot.transitionList || []).map((transition) => transition.slideMajor)).size;
}

function createSummaryGenerator({ config, summariesDir, onProgress = null }) {
  const recaptionAgent = createSlideRecaptionAgent({ config });
  const summaryAgent = createMeetingSummaryAgent({ config });
  const rewriteAgent = createSummaryRewriteAgent({ config });
  const ttsClient = createTtsClient({ config });

  function reportProgress({ stage, message, doneCount = 0, totalCount = 0 }) {
    console.log(`[summary] ${message}`);
    onProgress?.({ stage, message, doneCount, totalCount });
  }

  // 화면 정보 텍스트화. 실패하면 null 을 돌려주고 스크립트는 그 화면을 "화면 설명 없음"으로 남긴다.
  async function recaptionSlide({ asset }) {
    try {
      const baseJpegBuffer = fs.readFileSync(asset.baseFilePath);
      const annotationJpegBuffer = asset.lastAnnotationFilePath
        ? fs.readFileSync(asset.lastAnnotationFilePath) : null;
      return await recaptionAgent.generate({
        baseJpegBuffer, annotationJpegBuffer, slideMajor: asset.major,
      });
    } catch (error) {
      console.warn(`[summary] 슬라이드 ${asset.major} 화면 정보 텍스트화 실패: ${error.message}`);
      return null;
    }
  }

  // 전환 고지가 한 번도 없었던 화면만 회의 후에 텍스트로 바꿔 스크립트의 화면 줄을 채운다.
  async function buildScreenFillByMajorMap({ snapshot, assetList }) {
    const targetMajorSet = new Set(listSlideMajorWithoutTransitionLine({ snapshot }));
    const targetList = assetList.filter((asset) => targetMajorSet.has(String(asset.major)));
    let doneCount = 0;
    const recaptionList = await mapWithConcurrencyLimit({
      itemList: targetList,
      limit: RECAPTION_CONCURRENCY,
      run: async ({ item }) => {
        const recaption = await recaptionSlide({ asset: item });
        doneCount += 1;
        reportProgress({
          stage: SUMMARY_STAGE_MAP.recaption,
          message: `화면 정보 텍스트화 ${doneCount}/${targetList.length}`,
          doneCount, totalCount: targetList.length,
        });
        return recaption;
      },
    });
    return new Map(targetList.map((asset, index) => [String(asset.major), toScreenFillText(recaptionList[index])]));
  }

  async function generate({ session, contextSnapshot = null }) {
    const snapshot = contextSnapshot || buildSnapshotFromSession({ session });
    const assetList = resolveSlideAssetList({ slideMarkList: session.slideMarkList });
    reportProgress({
      stage: SUMMARY_STAGE_MAP.collect,
      message: `요약 재료 수집 — 화면 ${countScreen({ snapshot })}개 · 발화 ${session.asrEntryList.length}건`,
    });

    const screenFillByMajorMap = await buildScreenFillByMajorMap({ snapshot, assetList });

    // 회의 스크립트 작성: 화자를 구분한 발화 + 화면 전환 AD 한 줄씩. 요약에는 이 스크립트에서 화자 이름만 뺀 것을 준다.
    reportProgress({ stage: SUMMARY_STAGE_MAP.script, message: '회의 스크립트 작성 중' });
    const scriptText = buildTranscriptScript({ snapshot, screenFillByMajorMap });
    const summaryScriptText = buildTranscriptScript({ snapshot, screenFillByMajorMap, isSpeakerHidden: true });

    reportProgress({ stage: SUMMARY_STAGE_MAP.summarize, message: '회의 요약 생성 중' });
    const { text: draftText, isTruncated: draftTruncated } = await summaryAgent.summarize({
      scriptText: summaryScriptText,
    });

    reportProgress({ stage: SUMMARY_STAGE_MAP.rewrite, message: '요약본 듣는 글로 재구성 중' });
    const { text, isTruncated } = await rewriteAgent.rewrite({
      draftText, isTruncated: draftTruncated,
    });

    const documentText = buildSummaryDocument({
      meetingMeta: {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        slideCount: countScreen({ snapshot }),
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
    // 스크립트 파일 쓰기에 실패해도 요약 문서·음성 생성은 계속한다.
    const scriptFilePath = textFilePath.replace(/\.txt$/, '-script.txt');
    try {
      fs.writeFileSync(scriptFilePath, scriptText, 'utf8');
    } catch (error) {
      console.warn(`[summary] 회의 스크립트 쓰기 실패(무시) ${scriptFilePath}: ${error.message}`);
    }

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
      scriptText,
      slideCount: countScreen({ snapshot }),
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
  SUMMARY_STAGE_MAP, RECAPTION_CONCURRENCY, toScreenFillText, buildSnapshotFromSession,
};
