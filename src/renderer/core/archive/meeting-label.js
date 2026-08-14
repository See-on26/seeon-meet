import { defaultUiText } from '../i18n/ui-text.js';

// "지난 회의" 목록 항목 문구. 스크린리더가 이 한 줄로 회의를 고를 수 있게 날짜·시각·제목·길이·요약 여부를 담는다.
// 날짜·시각 어순은 언어마다 달라 한 문장 틀(archive.meetingWhen)에 값을 넣는다.
// 분 자릿수도 언어마다 다르다(한국어 "5분", 영어 "9:05") — archive.minuteDigits 만큼 앞을 0으로 채운다.
function describeMeetingWhen({ date, t }) {
  const hours = date.getHours();
  const minuteDigitCount = Number(t('archive.minuteDigits')) || 1;
  return t('archive.meetingWhen', {
    month: t(`date.month${date.getMonth() + 1}`),
    day: date.getDate(),
    period: t(hours < 12 ? 'archive.am' : 'archive.pm'),
    hour: hours % 12 === 0 ? 12 : hours % 12,
    minute: String(date.getMinutes()).padStart(minuteDigitCount, '0'),
  });
}

export function formatMeetingLabel({ meeting, t = defaultUiText }) {
  const date = new Date(meeting.startedAt);
  const partList = [describeMeetingWhen({ date, t })];
  if (meeting.title) partList.push(meeting.title);
  if (Number.isFinite(meeting.endedAt) && meeting.endedAt > meeting.startedAt) {
    partList.push(t('archive.durationMinutes', { minutes: Math.max(1, Math.round((meeting.endedAt - meeting.startedAt) / 60_000)) }));
  }
  partList.push(t(meeting.hasSummary ? 'archive.hasSummary' : 'archive.noSummaryShort'));
  return partList.join(', ');
}
