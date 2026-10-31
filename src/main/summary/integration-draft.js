const { completeDecisionPart } = require('./decision-part');

// 긴 회의에서 통합 초안이 이따금 슬라이드 여럿을 뭉뚱그려 보통 초안보다 크게 짧아지고 구간을 많이 빠뜨린다.
// 짧은 회의는 입력이 작아 초안이 입력만 하거나 더 길어서 보지 않는다.
const COMPRESSED_DRAFT_RATIO = 0.25;
const COMPRESSION_CHECK_MIN_INPUT_CHARS = 6000;

function isDraftCompressed({ draftText, integrationText }) {
  const inputLength = String(integrationText || '').length;
  if (inputLength < COMPRESSION_CHECK_MIN_INPUT_CHARS) return false;
  return String(draftText || '').length < inputLength * COMPRESSED_DRAFT_RATIO;
}

// 통합 요약 초안을 만든다. 짧아졌으면 한 번 더 만들어 긴 쪽을 쓰고(다시 만든 쪽이 길이 한도에서 잘렸으면 — 되풀이로
// 한도를 채운 꼴 — 처음 것), 넷째 부분이 빠졌으면 그 부분만 따로 만들어 붙인다.
// 처음 요청의 실패는 그대로 던진다(요약 실패). 다시 만들기의 실패는 처음 초안으로 넘어간다.
async function buildIntegrationDraft({ integrationText, language = 'ko', summaryAgent, logStep = () => {} }) {
  let draft = await summaryAgent.summarize({ integrationText, language });
  let isRetried = false;
  if (isDraftCompressed({ draftText: draft.text, integrationText })) {
    isRetried = true;
    logStep(`통합 초안이 입력에 비해 짧아(${draft.text.length}자 / 입력 ${integrationText.length}자) 한 번 더 만든다`);
    try {
      const retried = await summaryAgent.summarize({ integrationText, language });
      if (retried.text.length > draft.text.length && (!retried.isTruncated || draft.isTruncated)) draft = retried;
      logStep(`다시 만든 초안 ${retried.text.length}자 — ${draft === retried ? '이것을 쓴다' : '처음 것을 쓴다'}`);
    } catch (error) {
      console.warn(`[summary] 통합 초안 다시 만들기 실패 — 처음 초안을 쓴다: ${error?.message}`);
    }
  }
  const completed = await completeDecisionPart({
    draftText: draft.text, integrationText, language, summaryAgent, logStep,
  });
  return { text: completed.text, isTruncated: draft.isTruncated, isRetried, isDecisionCompleted: completed.isCompleted };
}

module.exports = {
  buildIntegrationDraft, isDraftCompressed, COMPRESSED_DRAFT_RATIO, COMPRESSION_CHECK_MIN_INPUT_CHARS,
};
