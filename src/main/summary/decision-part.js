const { SUMMARY_PART_TITLE_MAP } = require('../caption-pipeline/prompts/meeting-summary');

// 제목 줄을 견줄 때 앞 번호·마크다운 꾸밈·괄호와 뒤 쌍점을 벗기고 영어는 소문자로 맞춘다.
const TITLE_DECORATION_PATTERN = /^(?:\d+[.)]\s*|[*#[\]【】\s])+|[*\]】:：\s]+$/g;

function readTitleList({ language }) {
  return SUMMARY_PART_TITLE_MAP[language] || SUMMARY_PART_TITLE_MAP.ko;
}

function normalizeTitleLine(line) {
  return String(line || '').trim().replace(TITLE_DECORATION_PATTERN, '').toLowerCase();
}

function readNormalizedLineList({ text }) {
  return String(text || '').split('\n').map(normalizeTitleLine);
}

// 긴 회의에서 통합 초안이 셋째 부분(슬라이드별 내용)까지만 쓰고 넷째 부분 없이 끝나는 일이 있다.
// 셋째 제목 줄은 있는데 넷째 제목으로 시작하는 줄이 없을 때만 빠진 것으로 본다("결정된 것과 앞으로 할 일은 없습니다."도
// 넷째 부분이다). 제목 줄을 아예 쓰지 않은 초안은 넷째 부분이 문장으로 들어 있을 수 있어 건드리지 않는다.
function isDecisionPartMissing({ draftText, language = 'ko' }) {
  const [, , slideTitle, decisionTitle] = readTitleList({ language }).map(normalizeTitleLine);
  const lineList = readNormalizedLineList({ text: draftText });
  return lineList.includes(slideTitle) && !lineList.some((line) => line.startsWith(decisionTitle));
}

// 따로 받은 넷째 부분이 쓸 만한가. 길이 한도에서 잘렸거나 다른 부분 제목까지 다시 쓴 답은 버린다.
function readUnusableReason({ text, isTruncated, language }) {
  if (isTruncated) return '길이 한도에서 잘림';
  const otherTitleList = readTitleList({ language }).slice(0, 3).map(normalizeTitleLine);
  const lineList = readNormalizedLineList({ text });
  return otherTitleList.some((title) => lineList.includes(title)) ? '다른 부분까지 다시 씀' : null;
}

// 첫 줄이 넷째 제목(꾸밈 포함)이면 꾸밈 없는 제목으로 바꾸고, 제목으로 시작하는 문장이면 그대로, 제목이 없으면 앞에 붙인다.
function withDecisionTitle({ text, language }) {
  const decisionTitle = readTitleList({ language })[3];
  const [firstLine, ...restLineList] = text.trim().split('\n');
  const firstTitle = normalizeTitleLine(firstLine);
  const normalizedDecisionTitle = normalizeTitleLine(decisionTitle);
  if (firstTitle === normalizedDecisionTitle) return [decisionTitle, ...restLineList].join('\n');
  if (firstTitle.startsWith(normalizedDecisionTitle)) return text.trim();
  return `${decisionTitle}\n${text.trim()}`;
}

// 넷째 부분이 빠진 초안이면 같은 통합 입력으로 그 부분만 만들어 한 줄 띄우고 붙인다.
// 만들다 실패하거나 쓸 수 없는 답이면 초안을 그대로 둔다(넷째 부분 하나 때문에 요약 전체를 실패로 만들지 않는다).
async function completeDecisionPart({ draftText, integrationText, language = 'ko', summaryAgent, logStep = () => {} }) {
  if (!isDecisionPartMissing({ draftText, language })) return { text: draftText, isCompleted: false };
  try {
    const { text, isTruncated = false } = await summaryAgent.summarizeDecisionPart({ integrationText, language });
    const unusableReason = readUnusableReason({ text, isTruncated, language });
    if (unusableReason) {
      console.warn(`[summary] 따로 만든 넷째 부분을 버림(${unusableReason}) — 초안 그대로 쓴다`);
      return { text: draftText, isCompleted: false };
    }
    const decisionText = withDecisionTitle({ text, language });
    logStep(`통합 초안에 넷째 부분이 없어 따로 만들어 붙였다 (${decisionText.length}자)`);
    return { text: `${draftText.trimEnd()}\n\n${decisionText}`, isCompleted: true };
  } catch (error) {
    console.warn(`[summary] 넷째 부분 따로 만들기 실패 — 초안 그대로 쓴다: ${error?.message}`);
    return { text: draftText, isCompleted: false };
  }
}

module.exports = { isDecisionPartMissing, completeDecisionPart };
