// 마지막으로 말소리를 들은 시각(performance.now 기준)을 벽시계로 바꾼다.
// 해설 에코 창처럼 소리를 들을 수 없던 구간은 말이 이어졌을 수 있으므로 말소리가 있던 것으로 본다.
export function resolveLastSpeechWallTs({ lastActiveAt, lastBlindAt, nowPerf, nowWall }) {
  const lastHeardAt = Math.max(lastActiveAt || 0, lastBlindAt || 0);
  return lastHeardAt > 0 ? nowWall - (nowPerf - lastHeardAt) : 0;
}
