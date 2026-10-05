const SLIDE_FRAME_KIND_MAP = { base: 'base', annotation: 'annotation' };

const SLIDE_LEAD_IN_MS = 3000;

function toMajorKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

function buildSlideIntervalList({ slideMarkList, sessionEndTs, leadInMs = SLIDE_LEAD_IN_MS }) {
  const enterList = (slideMarkList || [])
    .filter((mark) => mark && mark.frameKind === SLIDE_FRAME_KIND_MAP.base)
    .map((mark) => ({ ts: mark.ts, major: toMajorKey(mark.slideLabel) }))
    .filter((entry) => entry.major && Number.isFinite(entry.ts))
    .sort((left, right) => left.ts - right.ts);

  const intervalListByMajorMap = new Map();
  let previousMajor = null;
  for (let index = 0; index < enterList.length; index += 1) {
    const { ts, major } = enterList[index];

    const endTs = index + 1 < enterList.length ? enterList[index + 1].ts : sessionEndTs;
    if (!intervalListByMajorMap.has(major)) intervalListByMajorMap.set(major, []);
    const intervalList = intervalListByMajorMap.get(major);
    if (major === previousMajor && intervalList.length) {
      intervalList[intervalList.length - 1].endTs = endTs;
    } else {
      intervalList.push({ startTs: ts - leadInMs, endTs });
    }
    previousMajor = major;
  }

  return [...intervalListByMajorMap.entries()].map(([major, intervalList]) => ({ major, intervalList }));
}

function flattenAsrSegmentList({ asrEntryList }) {
  const flatList = [];
  for (const entry of asrEntryList || []) {
    if (!entry || !Number.isFinite(entry.ts)) continue;
    const segmentList = Array.isArray(entry.segmentList) ? entry.segmentList : [];
    if (!segmentList.length) {
      const text = String(entry.text ?? '').trim();
      if (text) flatList.push({ ts: entry.ts, midTs: entry.ts, text });
      continue;
    }
    for (const segment of segmentList) {
      const text = String(segment?.text ?? '').trim();
      if (!text) continue;
      const startTs = entry.ts + Number(segment.startSec ?? 0) * 1000;
      const endTs = entry.ts + Number(segment.endSec ?? segment.startSec ?? 0) * 1000;
      flatList.push({ ts: startTs, midTs: (startTs + endTs) / 2, text });
    }
  }
  return flatList.sort((left, right) => left.ts - right.ts);
}

function assignAsrToSlideList({ asrEntryList, slideIntervalList }) {
  const flatIntervalList = [];
  for (const slide of slideIntervalList || []) {
    for (const interval of slide.intervalList) {
      flatIntervalList.push({ major: slide.major, ...interval });
    }
  }
  flatIntervalList.sort((left, right) => left.startTs - right.startTs);

  const utteranceListByMajorMap = new Map();
  for (const slide of slideIntervalList || []) utteranceListByMajorMap.set(slide.major, []);

  for (const segment of flattenAsrSegmentList({ asrEntryList })) {
    for (let index = flatIntervalList.length - 1; index >= 0; index -= 1) {
      const interval = flatIntervalList[index];
      if (segment.midTs >= interval.startTs && segment.midTs < interval.endTs) {
        utteranceListByMajorMap.get(interval.major).push({ ts: segment.ts, text: segment.text });
        break;
      }
    }
  }

  return (slideIntervalList || []).map((slide) => ({
    major: slide.major,
    utteranceList: utteranceListByMajorMap.get(slide.major),
  }));
}

module.exports = {
  buildSlideIntervalList, assignAsrToSlideList, flattenAsrSegmentList,
  SLIDE_LEAD_IN_MS, SLIDE_FRAME_KIND_MAP,
};
