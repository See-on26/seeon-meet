// 줄 목록에서 최근 줄부터 글자 수 상한(줄바꿈 포함) 안에 드는 만큼만 남긴다. 순서는 그대로 둔다.
function keepNewestWithinChars({ lineList, maxChars }) {
  const keptList = [];
  let totalChars = 0;
  for (let index = lineList.length - 1; index >= 0; index -= 1) {
    const lineChars = lineList[index].length + (keptList.length ? 1 : 0);
    if (totalChars + lineChars > maxChars) break;
    keptList.unshift(lineList[index]);
    totalChars += lineChars;
  }
  return keptList;
}

module.exports = { keepNewestWithinChars };
