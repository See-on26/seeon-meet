const BOX_DRAWING_PATTERN = /[─-◿]/;

const COLUMN_PADDING_PATTERN = /\S {3,}\S/;

const MARKUP_RULE_LIST = [
  { reason: '표 구분자(|)', test: (line) => line.includes('|') },
  { reason: '괘선·블록 문자', test: (line) => BOX_DRAWING_PATTERN.test(line) },
  { reason: '마크다운 제목(#)', test: (line) => /^\s*#/.test(line) },
  { reason: '강조 기호(*)', test: (line) => line.includes('*') },
  { reason: '코드 기호(`)', test: (line) => line.includes('`') },
  { reason: '공백 정렬', test: (line) => COLUMN_PADDING_PATTERN.test(line) },
];

const TRUNCATED_NOTICE = '이 요약은 길이 제한에 걸려 뒷부분이 잘렸습니다.';

function formatDurationText({ ms }) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalMinute = Math.floor(ms / 60000);
  if (totalMinute < 1) return `${Math.floor(ms / 1000)}초`;
  const hour = Math.floor(totalMinute / 60);
  const minute = totalMinute % 60;
  if (!hour) return `${minute}분`;
  return minute ? `${hour}시간 ${minute}분` : `${hour}시간`;
}

function buildSummaryFileName({ sessionId, extension }) {
  const safeSessionId = String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `summary-${safeSessionId}.${extension}`;
}

function formatScaleText({ slideCount, utteranceCount }) {
  return `슬라이드 ${slideCount || 0}장 · 발화 ${utteranceCount || 0}건`;
}

function buildSummaryDocument({ meetingMeta, bodyText, isTruncated = false }) {
  const durationText = formatDurationText({ ms: meetingMeta.endedAt - meetingMeta.startedAt });
  const lineList = ['회의 요약', ''];
  if (durationText) lineList.push(`회의 길이: ${durationText}`);
  lineList.push(formatScaleText(meetingMeta), '');
  lineList.push(String(bodyText ?? '').trim());
  if (isTruncated) lineList.push('', TRUNCATED_NOTICE);
  return `${lineList.join('\n')}\n`;
}

function findMarkupViolationList({ text }) {
  const violationList = [];
  const lineList = String(text ?? '').split('\n');
  for (let index = 0; index < lineList.length; index += 1) {
    const line = lineList[index];
    const rule = MARKUP_RULE_LIST.find((candidate) => candidate.test(line));
    if (rule) violationList.push({ lineNumber: index + 1, line, reason: rule.reason });
  }
  return violationList;
}

module.exports = {
  buildSummaryDocument, findMarkupViolationList, buildSummaryFileName,
  formatDurationText, TRUNCATED_NOTICE,
};
