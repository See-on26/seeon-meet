// "지난 회의" 목록 항목 문구. 스크린리더가 이 한 줄로 회의를 고를 수 있게 날짜·시각·제목·길이·요약 여부를 담는다.
function formatClock({ date }) {
  const hours = date.getHours();
  const period = hours < 12 ? '오전' : '오후';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${period} ${hour12}시 ${date.getMinutes()}분`;
}

export function formatMeetingLabel({ meeting }) {
  const date = new Date(meeting.startedAt);
  const partList = [`${date.getMonth() + 1}월 ${date.getDate()}일 ${formatClock({ date })} 회의`];
  if (meeting.title) partList.push(meeting.title);
  if (Number.isFinite(meeting.endedAt) && meeting.endedAt > meeting.startedAt) {
    partList.push(`${Math.max(1, Math.round((meeting.endedAt - meeting.startedAt) / 60_000))}분`);
  }
  partList.push(meeting.hasSummary ? '요약 있음' : '요약 없음');
  return partList.join(', ');
}
