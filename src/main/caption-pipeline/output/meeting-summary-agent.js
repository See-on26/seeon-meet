const { requestConverseText } = require('../agents/shared/bedrock-converse');
const {
  buildSummarySystemPrompt,
} = require('../prompts/meeting-summary');

const AGENT_LABEL = '회의 요약';

const SUMMARY_MAX_TOKENS = 16000;

const SUMMARY_TIMEOUT_MS = 300000;

function buildSlideBlock({ slideSection }) {
  const lineList = [`[슬라이드 ${slideSection.major}]`];
  if (slideSection.title) lineList.push(`제목: ${slideSection.title}`);
  lineList.push(`화면 내용: ${slideSection.bodyText}`);
  if (slideSection.annotationText) {
    lineList.push(`발표 중 화면에 추가된 표시: ${slideSection.annotationText}`);
  }
  const utteranceList = slideSection.utteranceList || [];
  if (utteranceList.length) {
    lineList.push('이 화면을 띄워 놓고 오간 말:');
    for (const utterance of utteranceList) lineList.push(`  ${utterance.text}`);
  } else {
    lineList.push('이 화면을 띄워 놓고 오간 말 없음');
  }
  return lineList.join('\n');
}

function buildSummaryInput({ slideSectionList }) {
  if (!slideSectionList?.length) {
    return '이 회의에서는 공유 화면 전환이 감지되지 않았다. 슬라이드 자료 없이 대화만 오갔다.';
  }
  return [
    '아래는 회의에서 화면에 나온 순서대로 정리한 자료다.',
    '각 슬라이드마다 화면에 무엇이 있었는지와, 그 화면을 띄워 놓고 오간 말이 함께 있다.',
    '',
    ...slideSectionList.map((slideSection) => buildSlideBlock({ slideSection })),
  ].join('\n\n');
}

// 제안서 3.1.2⑨의 "회의 맥락 요약 에이전트" — 회의 요약 파이프라인 2단계(화면·발화 맥락 병합).
function createMeetingSummaryAgent({ config }) {
  async function summarize({ slideSectionList }) {
    const { text, stopReason } = await requestConverseText({
      config,
      modelId: config.summaryModelId,
      systemPrompt: buildSummarySystemPrompt(),
      messageList: [{ role: 'user', content: [{ text: buildSummaryInput({ slideSectionList }) }] }],
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      label: AGENT_LABEL,
    });

    const cleaned = text.replace(/```[a-zA-Z]*\n?/g, '').trim();
    if (!cleaned) throw new Error(`${AGENT_LABEL}: 모델 응답이 비어 있습니다`);
    return { text: cleaned, isTruncated: stopReason === 'max_tokens' };
  }

  return { summarize };
}

module.exports = {
  createMeetingSummaryAgent, buildSummarySystemPrompt, buildSummaryInput,
  SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS,
};
