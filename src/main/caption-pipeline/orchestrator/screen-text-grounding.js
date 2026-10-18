// 수치 해설(변화·비교, 값→의미)에 그 요청 프레임을 OCR 로 읽은 글자를 근거로 넣는다.
// OCR 은 판단 LLM 과 함께 시작해 겹쳐 돌리고, 판단 뒤에는 상한(SCREEN_TEXT_WAIT_MS)까지만 기다린다.
// 늦거나 실패하거나 믿기 어려우면 덩어리 없이(지금과 같은 프롬프트로) 생성한다. 수치 해설이 아니면 OCR 결과는 버린다.
const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');
const { NARRATION_BY_TRIGGER_TYPE_MAP } = require('../router/unified-router');
const { OCR_MIN_MEAN_SCORE, OCR_MAX_VERTICAL_BOX_RATIO } = require('../agents/slide-text-agent');

// 판단 LLM 이 끝난 뒤 OCR 을 더 기다리는 상한. 서버 처리는 장당 0.3~0.7초(글자 많은 장 1.2초)라 대부분 판단 중에 끝난다.
const SCREEN_TEXT_WAIT_MS = 1000;
// 값 검사에 믿는 줄 점수. 이보다 낮은 줄은 작은 글씨 오독일 수 있어("체험"→"제험", "2,318"→"2.318") 값 검사 글자에서 뺀다.
// 해설이 그 오독을 따라 쓰면 같은 글자로 검사해도 통과하므로, 그런 값은 VLM 재전사로 확인하게 된다.
const SCREEN_TEXT_CONFIDENT_SCORE = 0.85;

const SCREEN_TEXT_SOURCE_MAP = { fresh: 'fresh', none: 'none' };
const SCREEN_TEXT_SKIP_REASON_MAP = {
  disabled: 'disabled',
  late: 'ocr_late',
  bypass: 'ocr_bypass',
  noText: 'no_text',
  lowScore: 'low_score',
  verticalText: 'vertical_text',
  overCharLimit: 'over_char_limit',
};

// 수치 해설은 단순 수치·변화 트리거에서만 나온다. 그런 후보가 없는 요청에는 OCR 을 보내지 않는다(GPU 서버 CPU 절약).
function shouldStartScreenTextGrounding({ triggerCandidateList = [] } = {}) {
  return (Array.isArray(triggerCandidateList) ? triggerCandidateList : []).some((candidate) => Boolean(candidate?.phrase)
    && NARRATION_BY_TRIGGER_TYPE_MAP[candidate.type]?.type === NARRATION_TYPE_MAP.interpretation);
}

// 근거로 쓸 수 있는지는 슬라이드 전사가 OCR 을 믿는 기준(평균 점수·세로 글씨 비율)과 같다.
function evaluateOcrResult(result) {
  const lineList = (result?.lineList || []).filter((line) => typeof line?.text === 'string' && line.text.trim());
  const meanScore = Number.isFinite(result?.meanScore) ? result.meanScore : null;
  const base = { meanScore, totalLineCount: lineList.length };
  if (!lineList.length) return { ...base, lineList: [], skipReason: SCREEN_TEXT_SKIP_REASON_MAP.noText };
  if (!(meanScore >= OCR_MIN_MEAN_SCORE)) return { ...base, lineList: [], skipReason: SCREEN_TEXT_SKIP_REASON_MAP.lowScore };
  if (result.verticalBoxRatio >= OCR_MAX_VERTICAL_BOX_RATIO) {
    return { ...base, lineList: [], skipReason: SCREEN_TEXT_SKIP_REASON_MAP.verticalText };
  }
  return { ...base, lineList, skipReason: null };
}

const isConfidentLine = (line) => !Number.isFinite(line.score) || line.score >= SCREEN_TEXT_CONFIDENT_SCORE;

function buildSkippedRecord(skipReason) {
  return {
    source: SCREEN_TEXT_SOURCE_MAP.none, totalLineCount: 0, meanScore: null, ocrMs: null, waitedMs: 0, skipReason,
  };
}

function createSkippedTask(skipReason) {
  return {
    waitForPrompt: async () => ({ lineList: [], record: buildSkippedRecord(skipReason) }),
    peekFrameText: () => null,
  };
}

function createScreenTextGrounding({ ocrClient, isEnabled = () => true, waitMs = SCREEN_TEXT_WAIT_MS, now = Date.now }) {
  // 판단 LLM 을 부르기 전에 부른다. 돌려받은 작업은 수치 해설일 때만 기다리고(waitForPrompt), 값 검사는 끝난 결과만 본다(peekFrameText).
  function start({ jpegBuffer }) {
    if (!isEnabled()) return createSkippedTask(SCREEN_TEXT_SKIP_REASON_MAP.disabled);
    if (!ocrClient) return createSkippedTask('ocr_error:OCR 클라이언트 없음');
    const startedAt = now();
    const state = { isSettled: false, evaluation: null, skipReason: null, ocrMs: null };
    const settle = ({ evaluation = null, skipReason }) => {
      Object.assign(state, { isSettled: true, evaluation, skipReason, ocrMs: now() - startedAt });
    };
    let recognizePromise;
    try {
      recognizePromise = Promise.resolve(ocrClient.recognize({ jpegBuffer }));
    } catch (error) {
      recognizePromise = Promise.reject(error);
    }
    const settledPromise = recognizePromise.then(
      (result) => {
        const evaluation = evaluateOcrResult(result);
        settle({ evaluation, skipReason: evaluation.skipReason });
      },
      (error) => settle({
        skipReason: error?.isBypassed ? SCREEN_TEXT_SKIP_REASON_MAP.bypass : `ocr_error:${error?.message || error}`,
      }),
    );

    async function waitForPrompt() {
      const waitStartedAt = now();
      if (!state.isSettled) {
        let timer = null;
        await Promise.race([settledPromise, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
        clearTimeout(timer);
      }
      const waitedMs = now() - waitStartedAt;
      if (!state.isSettled) {
        return { lineList: [], record: { ...buildSkippedRecord(SCREEN_TEXT_SKIP_REASON_MAP.late), waitedMs } };
      }
      const lineList = state.evaluation?.lineList || [];
      return {
        lineList,
        record: {
          source: lineList.length ? SCREEN_TEXT_SOURCE_MAP.fresh : SCREEN_TEXT_SOURCE_MAP.none,
          totalLineCount: state.evaluation?.totalLineCount ?? 0,
          meanScore: state.evaluation?.meanScore ?? null,
          ocrMs: state.ocrMs, waitedMs, skipReason: state.skipReason,
        },
      };
    }

    // 값 검사용 같은 프레임 글자. 아직 안 끝났거나 근거로 못 쓰는 결과면 null(지금처럼 저장 전사로 검사),
    // 쓸 수 있는데 믿을 줄이 하나도 없으면 빈 문자열(VLM 재전사로 확인)이다. 프롬프트에 늦은 결과도 여기서는 쓴다.
    function peekFrameText() {
      if (!state.isSettled || !state.evaluation || state.evaluation.skipReason) return null;
      return state.evaluation.lineList.filter(isConfidentLine).map((line) => line.text.trim()).join('\n');
    }

    return { waitForPrompt, peekFrameText };
  }

  return { start };
}

// 기록(수치 해설 레코드·흐름 창)에 남길 화면 글자 요약. 줄 수·글자 수는 프롬프트에 실제로 들어간 양이다.
function finalizeScreenTextRecord({ record, screenTextBlock = null }) {
  const lineCount = screenTextBlock?.lineCount ?? 0;
  const charCount = screenTextBlock?.charCount ?? 0;
  if (record.source === SCREEN_TEXT_SOURCE_MAP.fresh && !lineCount) {
    return {
      ...record, source: SCREEN_TEXT_SOURCE_MAP.none, lineCount, charCount, skipReason: SCREEN_TEXT_SKIP_REASON_MAP.overCharLimit,
    };
  }
  return { ...record, lineCount, charCount };
}

function formatScreenTextSummary(record) {
  if (!record) return '화면 글자=없음';
  if (record.source === SCREEN_TEXT_SOURCE_MAP.fresh) {
    return `화면 글자=같은 프레임 OCR ${record.lineCount}/${record.totalLineCount}줄 ${record.charCount}자`
      + ` 점수 ${record.meanScore} OCR ${record.ocrMs}ms 대기 ${record.waitedMs}ms`;
  }
  return `화면 글자=없음(${record.skipReason || '-'}${record.waitedMs ? `, 대기 ${record.waitedMs}ms` : ''})`;
}

module.exports = {
  createScreenTextGrounding, shouldStartScreenTextGrounding, evaluateOcrResult, finalizeScreenTextRecord,
  formatScreenTextSummary, SCREEN_TEXT_WAIT_MS, SCREEN_TEXT_CONFIDENT_SCORE, SCREEN_TEXT_SOURCE_MAP, SCREEN_TEXT_SKIP_REASON_MAP,
};
