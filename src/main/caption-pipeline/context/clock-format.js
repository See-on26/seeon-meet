function pad2(value) {
  return String(value).padStart(2, '0');
}

// 회의 시작부터 지난 시각. 질문 색인과 대화 스크립트가 같은 형식을 쓴다.
function formatElapsed({ ts, startedAt }) {
  if (!Number.isFinite(ts) || !Number.isFinite(startedAt)) return '--:--';
  const totalSec = Math.max(0, Math.floor((ts - startedAt) / 1000));
  const hour = Math.floor(totalSec / 3600);
  const minute = Math.floor((totalSec % 3600) / 60);
  const second = totalSec % 60;
  return hour > 0 ? `${hour}:${pad2(minute)}:${pad2(second)}` : `${pad2(minute)}:${pad2(second)}`;
}

module.exports = { formatElapsed };
