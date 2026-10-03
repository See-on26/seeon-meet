// 실회의 기록(jsonl)을 컨텍스트 저장소에 다시 흘려 넣어 라벨·색인·질문 답을 확인한다.
// 사용: node tools/context-replay.cjs <pipeline.jsonl> <sessionId> ["질문" ...]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
process.loadEnvFile(path.join(root, '.env'));
const { readPipelineConfig } = require('../src/main/caption-pipeline/config');
const { requestVlmContent } = require('../src/main/caption-pipeline/agents/shared/vlm-gateway');
const { createContextStore, LABEL_STATUS_MAP } = require('../src/main/caption-pipeline/context/context-store');
const { createSlideLabeler } = require('../src/main/caption-pipeline/context/slide-labeler');
const { classifyQuestion } = require('../src/main/caption-pipeline/context/question-classifier');
const { createQuestionRouter, selectFollowUpQa } = require('../src/main/caption-pipeline/context/question-router');
const { createQuestionAnswerer } = require('../src/main/caption-pipeline/context/question-answerer');
const { buildTranscriptScript } = require('../src/main/caption-pipeline/context/transcript-script');
const { createSlideTextAgent } = require('../src/main/caption-pipeline/agents/slide-text-agent');

const [jsonlPath, sessionId, ...questionList] = process.argv.slice(2);
if (!jsonlPath || !sessionId) {
  console.error('사용: node tools/context-replay.cjs <pipeline.jsonl> <sessionId> ["질문" ...]');
  process.exit(1);
}

const config = readPipelineConfig(process.env);
const requestText = ({ prompt, label, maxTokens }) => requestVlmContent({ config, prompt, label, maxTokens, temperature: 0 });

(async () => {
  const recordList = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((record) => record.sessionId === sessionId);
  const store = createContextStore();
  store.start({ sessionId, startedAt: Math.min(...recordList.map((record) => record.ts)) });
  // 예전 기록의 전환 고지 성공 기록에는 묘사·표시 번호 칸이 없어, 고지 문장("슬라이드 N: 묘사")에서 채운다.
  for (const record of recordList) {
    const isOldTransition = record.kind === 'page_transition' && !record.description && record.narration;
    if (!isOldTransition) {
      store.applyRecord(record);
      continue;
    }
    const spokenNumber = Number(record.narration.match(/슬라이드 (\d+):/)?.[1]);
    store.applyRecord({
      ...record, description: record.narration,
      displayNumber: Number.isFinite(record.displayNumber) ? record.displayNumber : (spokenNumber || null),
    });
  }
  // 슬라이드 글자 전사는 기록에 남지 않으므로 저장된 슬라이드 이미지로 다시 받는다.
  const slideTextAgent = createSlideTextAgent({ config });
  for (const slide of store.getSlideList()) {
    const jpegBuffer = slide.imagePath ? await fs.promises.readFile(slide.imagePath).catch(() => null) : null;
    const result = jpegBuffer ? await slideTextAgent.transcribe({ jpegBuffer }).catch(() => null) : null;
    store.applySlideText({ slideLabel: String(slide.major), status: result?.hasText ? 'ready' : 'none', text: result?.text || '' });
  }
  const labeler = createSlideLabeler({ requestText });
  for (const major of store.listReadyForLabelMajors()) {
    store.markLabelRequested(major);
    const startedAt = Date.now();
    try {
      store.setLabel({ major, status: LABEL_STATUS_MAP.ready, label: await labeler.label({ slide: store.getSlide(major) }) });
    } catch (error) {
      store.setLabel({ major, status: LABEL_STATUS_MAP.failed });
      console.log(`라벨 실패 ${major}: ${error.message}`);
    }
    console.log(`라벨 ${major} (${Date.now() - startedAt}ms)`);
  }
  console.log('\n[색인]');
  for (const entry of store.buildIndex()) console.log(`  ${entry.major} | ${entry.title} | ${entry.keywordList.join(', ')}`);
  console.log(`\n[스크립트 앞부분]\n${buildTranscriptScript({ snapshot: store.snapshot() }).split('\n').slice(0, 12).join('\n')}`);

  const router = createQuestionRouter({ requestText });
  const answerer = createQuestionAnswerer({
    contextStore: store, requestText,
    requestImage: ({ jpegBuffer, prompt, label, maxTokens }) => requestVlmContent({ config, jpegBuffer, prompt, label, maxTokens }),
    readImage: (filePath) => fs.promises.readFile(filePath).catch(() => null),
  });
  for (const questionText of questionList) {
    const startedAt = Date.now();
    const followUpQa = selectFollowUpQa({ lastQa: store.getLastQa(), now: store.getLastQa()?.ts ?? 0 });
    const ruled = classifyQuestion(questionText);
    const ruledMajor = ruled?.route === 'past_slide' ? store.resolveSlideNumber(ruled.spokenNumber) : null;
    const isRuledUsable = ruled && (ruled.route !== 'past_slide' || ruledMajor !== null);
    const routed = isRuledUsable ? { route: ruled.route, slideMajorList: ruledMajor === null ? [] : [ruledMajor] } : await router.route({
      questionText, currentSlideMajor: store.getCurrentSlideMajor(), index: store.buildIndex(), followUpQa,
      startedAt: store.getSessionInfo().startedAt,
    });
    // 앱은 '지금 화면' 질문을 실시간 화면으로 답한다. 여기서는 현재 슬라이드의 저장 기록·이미지로 대신한다.
    const isCurrentScreen = routed.route === 'current_screen';
    const result = await answerer.answer({
      route: isCurrentScreen ? 'past_slide' : routed.route,
      slideMajorList: isCurrentScreen ? [store.getCurrentSlideMajor()] : routed.slideMajorList,
      questionText, wordBudget: { minWordCount: 3, maxWordCount: 15 },
    });
    store.addQa({ ts: store.getLastQa()?.ts ?? 0, question: questionText, answer: result.text, route: routed.route, slideMajorList: routed.slideMajorList, isFollowUp: Boolean(followUpQa) });
    console.log(`\nQ: ${questionText}\n  갈래=${routed.route} 대상=[${routed.slideMajorList.join(', ')}]`
      + `${result.isImageUsed ? ' 이미지 재조회' : ''} (${Date.now() - startedAt}ms)\n  A: ${result.text}`);
  }
})();
