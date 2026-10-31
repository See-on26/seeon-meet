// 슬라이드(major)마다 화면 변화 글자 차이의 기준이 되는 마지막 OCR 줄. 슬라이드 시작 조용 구간이 끝난 화면으로 채우고,
// 변화 사건마다 그 사건 화면으로 바꾼다(렌더러 감지기가 사건마다 화소 기준을 바꾸는 것과 맞춘다).
function toSlideKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

function createScreenChangeBaseline() {
  const baselineBySlideMap = new Map();

  return {
    set({ slideLabel, lineList, imageWidth, imageHeight, ts }) {
      baselineBySlideMap.set(toSlideKey(slideLabel), { lineList: [...lineList], imageWidth, imageHeight, ts });
    },
    get(slideLabel) {
      return baselineBySlideMap.get(toSlideKey(slideLabel)) || null;
    },
    // OCR 이 실패한 화면은 기준을 지운다. 재방문 슬라이드에 남은 옛 기준과 견주면 바뀐 줄을 잘못 찾는다.
    remove(slideLabel) {
      return baselineBySlideMap.delete(toSlideKey(slideLabel));
    },
    reset() {
      baselineBySlideMap.clear();
    },
  };
}

module.exports = { createScreenChangeBaseline };
