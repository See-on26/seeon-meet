const { SUMMARY_PART_TITLE_MAP } = require('../caption-pipeline/prompts/meeting-summary');

const TITLE_TRAILING_COLON_PATTERN = /[:：]\s*$/;

function readTitleList({ language }) {
  return SUMMARY_PART_TITLE_MAP[language] || SUMMARY_PART_TITLE_MAP.ko;
}

function readTitleLineSet({ text }) {
  return new Set(String(text || '').split('\n').map((line) => line.trim().replace(TITLE_TRAILING_COLON_PATTERN, '')));
}

// 긴 회의에서 통합 초안이 셋째 부분(슬라이드별 내용)까지만 쓰고 넷째 부분 없이 끝나는 일이 있다.
// 셋째 제목 줄은 있는데 넷째 제목 줄이 없을 때만 빠진 것으로 본다. 제목 줄을 아예 쓰지 않은 초안은
// 넷째 부분이 문장으로 들어 있을 수 있어 건드리지 않는다.
function isDecisionPartMissing({ draftText, language = 'ko' }) {
  const [, , slideTitle, decisionTitle] = readTitleList({ language });
  const titleLineSet = readTitleLineSet({ text: draftText });
  return titleLineSet.has(slideTitle) && !titleLineSet.has(decisionTitle);
}

// 넷째 부분이 빠진 초안이면 같은 통합 입력으로 그 부분만 만들어 한 줄 띄우고 붙인다.
// 만들다 실패하면 초안을 그대로 둔다(넷째 부분 하나 때문에 요약 전체를 실패로 만들지 않는다).
async function completeDecisionPart({ draftText, integrationText, language = 'ko', summaryAgent, logStep = () => {} }) {
  if (!isDecisionPartMissing({ draftText, language })) return { text: draftText, isCompleted: false };
  try {
    const { text } = await summaryAgent.summarizeDecisionPart({ integrationText, language });
    const decisionTitle = readTitleList({ language })[3];
    const body = text.trim();
    const [firstLine] = body.split('\n');
    const decisionText = firstLine.trim().replace(TITLE_TRAILING_COLON_PATTERN, '') === decisionTitle ? body : `${decisionTitle}\n${body}`;
    logStep(`통합 초안에 넷째 부분이 없어 따로 만들어 붙였다 (${decisionText.length}자)`);
    return { text: `${draftText.trimEnd()}\n\n${decisionText}`, isCompleted: true };
  } catch (error) {
    console.warn(`[summary] 넷째 부분 따로 만들기 실패 — 초안 그대로 쓴다: ${error?.message}`);
    return { text: draftText, isCompleted: false };
  }
}

module.exports = { isDecisionPartMissing, completeDecisionPart };
