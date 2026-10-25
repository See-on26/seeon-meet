const { requestVlmCompletion, VLM_PRIORITY_MAP } = require('../agents/shared/vlm-gateway');
const { buildSegmentSummaryPrompt, SEGMENT_NONE_TOKEN } = require('../prompts/segment-summary');

const AGENT_LABEL = '구간 요약';
const SEGMENT_SUMMARY_MAX_TOKENS = 400;
const SEGMENT_SUMMARY_TIMEOUT_MS = 60000;
// 같은 재료면 같은 요약이 나오게 한다. 구간 요약은 다시 만들 때도 결과가 흔들리지 않아야 한다.
const SEGMENT_SUMMARY_TEMPERATURE = 0;
const FINISH_REASON_LENGTH = 'length';
// 영어 문장 "None of …" 는 요약이므로 대문자 토큰만 빈 구간으로 본다.
const NONE_ANSWER_PATTERN = new RegExp(`^${SEGMENT_NONE_TOKEN}(?![A-Za-z])`);

// 응답이 깨져 글이 아니거나 비었거나 NONE 이면 빈 구간이다. 빈 구간은 정상이라 던지지 않는다.
function parseSegmentSummaryText(content) {
  if (typeof content !== 'string') return '';
  const cleaned = content.replace(/```[a-zA-Z]*\n?/g, '').trim();
  const unquoted = cleaned.replace(/^["'“‘`]+|["'”’`]+$/g, '').trim();
  if (!unquoted || NONE_ANSWER_PATTERN.test(unquoted)) return '';
  return cleaned;
}

// 슬라이드 구간 하나의 재료를 GPU 서버(8801)에 짧게 요약하게 한다. 실시간 해설이 없을 때만 보내는 배경 순위다.
// HTTP 오류·시간 초과는 그대로 던져 부르는 쪽이 그 구간을 실패로 남긴다.
function createSegmentSummaryAgent({ config, requestCompletion = requestVlmCompletion }) {
  // language 는 그 회의의 캡션 언어다. 영어면 구간 요약을 영어로 쓴다.
  async function summarize({ materialText, language = 'ko' }) {
    const { content, finishReason } = await requestCompletion({
      config,
      prompt: buildSegmentSummaryPrompt({ materialText, language }),
      label: AGENT_LABEL,
      temperature: SEGMENT_SUMMARY_TEMPERATURE,
      maxTokens: SEGMENT_SUMMARY_MAX_TOKENS,
      timeoutMs: SEGMENT_SUMMARY_TIMEOUT_MS,
      priority: VLM_PRIORITY_MAP.background,
    });
    if (finishReason === FINISH_REASON_LENGTH) {
      console.warn(`[summary] ${AGENT_LABEL}이 ${SEGMENT_SUMMARY_MAX_TOKENS}토큰에서 잘렸다`);
    }
    return { text: parseSegmentSummaryText(content) };
  }

  return { summarize };
}

module.exports = { createSegmentSummaryAgent, parseSegmentSummaryText };
