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

// 요약 문서의 머리 글. 그 회의의 캡션 언어로 쓴다(요약 음성도 이 글을 그대로 읽는다).
const SUMMARY_DOCUMENT_TEXT_MAP = {
  ko: {
    title: '회의 요약',
    length: (durationText) => `회의 길이: ${durationText}`,
    scale: ({ slideCount, utteranceCount }) => `슬라이드 ${slideCount || 0}장 · 발화 ${utteranceCount || 0}건`,
    truncated: TRUNCATED_NOTICE,
    second: (count) => `${count}초`,
    minute: (count) => `${count}분`,
    hour: (count) => `${count}시간`,
  },
  en: {
    title: 'Meeting summary',
    length: (durationText) => `Meeting length: ${durationText}`,
    scale: ({ slideCount, utteranceCount }) => `${slideCount || 0} slides · ${utteranceCount || 0} utterances`,
    truncated: 'This summary was cut off at the length limit, so the end is missing.',
    second: (count) => `${count} ${count === 1 ? 'second' : 'seconds'}`,
    minute: (count) => `${count} ${count === 1 ? 'minute' : 'minutes'}`,
    hour: (count) => `${count} ${count === 1 ? 'hour' : 'hours'}`,
  },
};

const readDocumentText = (language) => SUMMARY_DOCUMENT_TEXT_MAP[language] || SUMMARY_DOCUMENT_TEXT_MAP.ko;

function formatDurationText({ ms, language = 'ko' }) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const text = readDocumentText(language);
  const totalMinute = Math.floor(ms / 60000);
  if (totalMinute < 1) return text.second(Math.floor(ms / 1000));
  const hour = Math.floor(totalMinute / 60);
  const minute = totalMinute % 60;
  if (!hour) return text.minute(minute);
  return minute ? `${text.hour(hour)} ${text.minute(minute)}` : text.hour(hour);
}

function buildSummaryFileName({ sessionId, extension }) {
  const safeSessionId = String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `summary-${safeSessionId}.${extension}`;
}

function buildSummaryDocument({ meetingMeta, bodyText, isTruncated = false, language = 'ko' }) {
  const text = readDocumentText(language);
  const durationText = formatDurationText({ ms: meetingMeta.endedAt - meetingMeta.startedAt, language });
  const lineList = [text.title, ''];
  if (durationText) lineList.push(text.length(durationText));
  lineList.push(text.scale(meetingMeta), '');
  lineList.push(String(bodyText ?? '').trim());
  if (isTruncated) lineList.push('', text.truncated);
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
