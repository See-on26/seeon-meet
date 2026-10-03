function toSlideByMajorMap(snapshot) {
  return new Map((snapshot?.slideList || []).map((slide) => [String(slide.major), slide]));
}

// 회의 중 모아 둔 글자·묘사가 있으면 재캡션을 건너뛴다. 주석 프레임은 저장소에 없어 재캡션으로만 얻는다.
function needsRecaption({ slide, asset }) {
  if (!slide) return true;
  if (asset?.lastAnnotationFilePath) return true;
  return !slide.slideText && !slide.description;
}

function buildSlideSectionListFromContext({ snapshot, assetList, recaptionByMajorMap }) {
  const slideByMajorMap = toSlideByMajorMap(snapshot);
  const utteranceList = snapshot?.utteranceList || [];
  return assetList.map((asset) => {
    const major = String(asset.major);
    const slide = slideByMajorMap.get(major) || null;
    const recaption = recaptionByMajorMap.get(major) || null;
    return {
      major,
      title: slide?.label?.title || slide?.pageTopic || recaption?.title || '',
      bodyText: slide?.slideText || slide?.description || recaption?.bodyText || '',
      annotationText: recaption?.annotationText || '',
      utteranceList: utteranceList.filter((utterance) => String(utterance.slideMajor) === major),
    };
  });
}

module.exports = { needsRecaption, buildSlideSectionListFromContext };
