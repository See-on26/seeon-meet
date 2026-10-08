const { requestVlmContent } = require('./shared/vlm-gateway');
const { GROUNDING_NONE_TOKEN } = require('./shared/caption-parser');
const { buildSlideTextPrompt } = require('../prompts/slide-text');

const AGENT_LABEL = '슬라이드전사';
const SLIDE_TEXT_MAX_TOKENS = 600;
const CODE_FENCE_PATTERN = /```[a-zA-Z]*\n?|```/g;

// OCR 결과를 믿지 않고 VLM 으로 다시 전사하는 기준. 합성 슬라이드로 정한 시작값이며 실제 자료로 다시 정한다.
const OCR_MIN_MEAN_SCORE = 0.8;
const OCR_MAX_VERTICAL_BOX_RATIO = 0.2;
// OCR 서비스가 응답하지 않으면 이 시간 동안 OCR 을 건너뛰고 바로 VLM 으로 전사한다. 장마다 상한까지 기다리지 않기 위해서다.
const OCR_BYPASS_MS = 60000;

const SLIDE_TEXT_SOURCE_MAP = { ocr: 'ocr', vlm: 'vlm' };
const OCR_FALLBACK_REASON_MAP = { lowScore: 'low_score', verticalText: 'vertical_text', bypass: 'ocr_bypass' };

function createSlideTextAgent({ config, ocrClient = null, now = Date.now }) {
  let ocrBypassUntil = 0;

  async function transcribeWithVlm({ jpegBuffer }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, prompt: buildSlideTextPrompt(),
      temperature: 0, maxTokens: SLIDE_TEXT_MAX_TOKENS,
    });
    const text = String(content || '').replace(CODE_FENCE_PATTERN, '').trim();
    const hasText = Boolean(text) && text.toUpperCase() !== GROUNDING_NONE_TOKEN;
    return { text: hasText ? text : '', hasText, source: SLIDE_TEXT_SOURCE_MAP.vlm, fallbackReason: null };
  }

  async function fallbackToVlm({ jpegBuffer, fallbackReason }) {
    return { ...await transcribeWithVlm({ jpegBuffer }), fallbackReason };
  }

  // 글자가 없는 장(사진만 있는 화면)은 VLM 으로 넘기지 않는다. 넘김은 OCR 이 실패했거나 결과를 믿기 어려울 때만이다.
  async function transcribeWithOcr({ jpegBuffer }) {
    if (!ocrClient) return fallbackToVlm({ jpegBuffer, fallbackReason: 'ocr_error:OCR 클라이언트 없음' });
    if (now() < ocrBypassUntil) return fallbackToVlm({ jpegBuffer, fallbackReason: OCR_FALLBACK_REASON_MAP.bypass });
    let ocrResult;
    try {
      ocrResult = await ocrClient.recognize({ jpegBuffer });
    } catch (error) {
      if (error.isServiceDown) ocrBypassUntil = now() + OCR_BYPASS_MS;
      return fallbackToVlm({ jpegBuffer, fallbackReason: `ocr_error:${error.message}` });
    }
    const lineList = ocrResult.lineList.filter((line) => String(line?.text || '').trim());
    if (!lineList.length) {
      return { text: '', hasText: false, source: SLIDE_TEXT_SOURCE_MAP.ocr, fallbackReason: null, lineList: [] };
    }
    if (ocrResult.meanScore < OCR_MIN_MEAN_SCORE) {
      return fallbackToVlm({ jpegBuffer, fallbackReason: OCR_FALLBACK_REASON_MAP.lowScore });
    }
    if (ocrResult.verticalBoxRatio >= OCR_MAX_VERTICAL_BOX_RATIO) {
      return fallbackToVlm({ jpegBuffer, fallbackReason: OCR_FALLBACK_REASON_MAP.verticalText });
    }
    return {
      text: lineList.map((line) => line.text.trim()).join('\n'),
      hasText: true, source: SLIDE_TEXT_SOURCE_MAP.ocr, fallbackReason: null, lineList,
    };
  }

  async function transcribe({ jpegBuffer }) {
    if (config.slideTextBackend === SLIDE_TEXT_SOURCE_MAP.ocr) return transcribeWithOcr({ jpegBuffer });
    return transcribeWithVlm({ jpegBuffer });
  }

  return { transcribe, transcribeWithVlm };
}

module.exports = {
  createSlideTextAgent, SLIDE_TEXT_SOURCE_MAP, OCR_FALLBACK_REASON_MAP,
  OCR_MIN_MEAN_SCORE, OCR_MAX_VERTICAL_BOX_RATIO, OCR_BYPASS_MS,
};
