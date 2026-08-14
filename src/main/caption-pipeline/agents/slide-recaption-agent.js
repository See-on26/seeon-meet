const { requestVlmContent } = require('./shared/vlm-gateway');
const { salvageSlotMap } = require('./shared/caption-parser');
const {
  buildSlideRecaptionPrompt,
} = require('../prompts/slide-recaption');

const AGENT_LABEL = '슬라이드 재캡션';

const RECAPTION_MAX_TOKENS = 3000;

const RECAPTION_TIMEOUT_MS = 90000;
const RECAPTION_TEMPERATURE = 0.2;

const RECAPTION_REPETITION_PENALTY = 1.05;

const TRUNCATED_BODY_PATTERN = /"bodyText"\s*:\s*"([^"]+)$/;

function parseSlideRecaptionText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const bodyText = String(parsed.bodyText ?? '').trim();
      if (bodyText) {
        return {
          title: String(parsed.title ?? '').trim(),
          bodyText,
          annotationText: String(parsed.annotationText ?? '').trim(),
        };
      }
    } catch {  }
  }

  const salvaged = salvageSlotMap({ text: cleaned });
  if (salvaged?.bodyText) {
    return {
      title: String(salvaged.title ?? '').trim(),
      bodyText: salvaged.bodyText,
      annotationText: String(salvaged.annotationText ?? '').trim(),
    };
  }

  const truncatedBody = cleaned.match(TRUNCATED_BODY_PATTERN);
  if (truncatedBody) {
    const bodyText = truncatedBody[1].replace(/\\$/, '').trim();
    if (bodyText) {
      return { title: String(salvaged?.title ?? '').trim(), bodyText, annotationText: '' };
    }
  }

  if (!cleaned.includes('{')) return { title: '', bodyText: cleaned, annotationText: '' };
  return null;
}

// 제안서 3.1.2⑨의 "화면 요약 에이전트" — 회의 요약 파이프라인 1단계(슬라이드 화면을 글로 압축).
function createSlideRecaptionAgent({ config }) {
  async function generate({ baseJpegBuffer, annotationJpegBuffer = null, slideMajor }) {
    function requestOnce({ hasAnnotation }) {
      return requestVlmContent({
        config,
        jpegBufferList: hasAnnotation ? [baseJpegBuffer, annotationJpegBuffer] : [baseJpegBuffer],
        prompt: buildSlideRecaptionPrompt({ hasAnnotation }),
        label: `${AGENT_LABEL} ${slideMajor}`,
        temperature: RECAPTION_TEMPERATURE,
        maxTokens: RECAPTION_MAX_TOKENS,
        timeoutMs: RECAPTION_TIMEOUT_MS,
        extraBodyMap: { repetition_penalty: RECAPTION_REPETITION_PENALTY },
      });
    }

    let hasAnnotation = Boolean(annotationJpegBuffer);
    let content;
    try {
      content = await requestOnce({ hasAnnotation });
    } catch (error) {
      if (!hasAnnotation) throw error;
      console.warn(`[summary] 슬라이드 ${slideMajor} 2장 요청 실패, 원본 1장으로 재시도: ${error.message}`);
      hasAnnotation = false;
      content = await requestOnce({ hasAnnotation });
    }

    const parsed = parseSlideRecaptionText(content);
    if (!parsed) throw new Error(`VLM(${AGENT_LABEL}) 응답 파싱 실패 (슬라이드 ${slideMajor})`);
    return { ...parsed, isAnnotationIncluded: hasAnnotation };
  }

  return { generate };
}

module.exports = {
  createSlideRecaptionAgent, buildSlideRecaptionPrompt, parseSlideRecaptionText,
  RECAPTION_MAX_TOKENS,
};
