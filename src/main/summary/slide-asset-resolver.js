const fs = require('fs');
const { SLIDE_FRAME_KIND_MAP } = require('./slide-timeline');

function toMajorKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

function resolveSlideAssetList({ slideMarkList }) {
  const assetByMajorMap = new Map();

  const sortedMarkList = [...(slideMarkList || [])].sort((left, right) => left.ts - right.ts);

  for (const mark of sortedMarkList) {
    const major = toMajorKey(mark?.slideLabel);
    if (!major || !mark.filePath) continue;
    if (!assetByMajorMap.has(major)) {
      assetByMajorMap.set(major, { baseFilePath: null, lastAnnotationFilePath: null, lastAnnotationTs: -Infinity });
    }
    const asset = assetByMajorMap.get(major);
    if (mark.frameKind === SLIDE_FRAME_KIND_MAP.base) {
      if (!asset.baseFilePath) asset.baseFilePath = mark.filePath;
    } else if (mark.frameKind === SLIDE_FRAME_KIND_MAP.annotation && mark.ts > asset.lastAnnotationTs) {
      asset.lastAnnotationFilePath = mark.filePath;
      asset.lastAnnotationTs = mark.ts;
    }
  }

  const assetList = [];
  for (const [major, asset] of assetByMajorMap.entries()) {
    if (!asset.baseFilePath || !fs.existsSync(asset.baseFilePath)) continue;
    const hasAnnotationFile = asset.lastAnnotationFilePath && fs.existsSync(asset.lastAnnotationFilePath);
    assetList.push({
      major,
      baseFilePath: asset.baseFilePath,
      lastAnnotationFilePath: hasAnnotationFile ? asset.lastAnnotationFilePath : null,
    });
  }
  return assetList;
}

module.exports = { resolveSlideAssetList };
