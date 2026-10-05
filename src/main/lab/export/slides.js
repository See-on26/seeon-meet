const BASE_FRAME_KIND = 'base';

// production 이 out/slides/<세션>/slide-N/base.jpg 로 남긴 슬라이드별 대표 이미지 목록.
// 시작 시각은 슬라이드가 실제로 바뀐 시각(transitionTs)이고, 없으면 저장 시각이다.
function buildSlideList({ slideMarkRecordList, toMediaMs }) {
  const slideMap = new Map();
  for (const record of slideMarkRecordList) {
    if (record.kind !== 'slide_mark' || record.frameKind !== BASE_FRAME_KIND || !record.filePath) continue;
    const label = String(record.slideLabel).split('-')[0];
    if (slideMap.has(label)) continue;
    const wallMs = Number.isFinite(record.transitionTs) ? record.transitionTs : record.ts;
    const startMediaMs = toMediaMs(wallMs);
    slideMap.set(label, {
      label,
      startMediaMs: Number.isFinite(startMediaMs) ? Math.round(startMediaMs) : null,
      file: `slides/slide-${label}.jpg`,
      sourcePath: record.filePath,
    });
  }
  return [...slideMap.values()].sort((slideA, slideB) => (slideA.startMediaMs ?? 0) - (slideB.startMediaMs ?? 0));
}

module.exports = { buildSlideList };
