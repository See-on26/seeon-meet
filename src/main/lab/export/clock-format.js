const pad2 = (value) => String(value).padStart(2, '0');

// 전사·S 조건 텍스트의 [mm:ss]. 한 시간을 넘으면 분이 60 이상으로 이어진다.
function formatMediaClock(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`;
}

function formatSrtTime(ms) {
  const totalMs = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${String(totalMs % 1000).padStart(3, '0')}`;
}

module.exports = { formatMediaClock, formatSrtTime };
