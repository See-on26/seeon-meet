import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMergedTimelineText } = require('../../../src/main/lab/export/s-condition.js');
const { formatMediaClock } = require('../../../src/main/lab/export/clock-format.js');

// 평가 조건(회의록 3.2.1)과 문항 필터(3.2.3).
export const CONDITION_LIST = ['A', 'S', 'H', 'C'];
export const FILTER_LIST = ['N', 'V', 'C'];
export const MATERIAL_KIND_MAP = {
  transcript: 'A', sCondition: 'S', humanAd: 'H', screen: 'C', questionOnly: 'N', screenOnly: 'V',
};
export const DEFAULT_MAX_SLIDE_COUNT = 20;

export const MATERIAL_SKIP_REASON_MAP = {
  noRunDir: 'no_run_dir',
  noHumanAd: 'no_human_ad',
  noSlide: 'no_slide',
};

const IMAGE_FORMAT_MAP = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png' };

// 결과 폴더(L2)에서 조건별 자료를 읽는다.
export function readRunMaterial({ runDir, readText = (filePath) => fs.readFileSync(filePath, 'utf8') }) {
  const read = (name) => readText(path.join(runDir, name));
  let slideList = [];
  try {
    slideList = JSON.parse(read('slides.json')).slideList.map((slide) => ({ ...slide, filePath: path.join(runDir, slide.file) }));
  } catch {
    slideList = [];
  }
  return {
    runDir,
    transcriptText: read('transcript.txt').trim(),
    utteranceList: JSON.parse(read('transcript.json')).utteranceList,
    sConditionText: read('s-condition.txt').trim(),
    slideList,
  };
}

// 슬라이드가 많으면 고르게 골라 최대 장수에 맞춘다. 처음과 끝은 남긴다.
export function selectSlideList({ slideList, maxSlideCount = DEFAULT_MAX_SLIDE_COUNT }) {
  if (slideList.length <= maxSlideCount) return slideList;
  if (maxSlideCount <= 1) return slideList.slice(0, maxSlideCount);
  const step = (slideList.length - 1) / (maxSlideCount - 1);
  return Array.from({ length: maxSlideCount }, (_unused, index) => slideList[Math.round(index * step)]);
}

// H 조건: 사람 작성 AD 를 S 조건과 같은 방식(같은 표기)으로 전사에 끼운다. AD 출처만 다르게 하려는 것이다.
export function buildHumanAdText({ utteranceList, humanAdList }) {
  return buildMergedTimelineText({
    utteranceList,
    adList: humanAdList.map(({ startMs, text }) => ({ playedMediaMs: startMs, eventMediaMs: startMs, text, heardMediaRange: null })),
  });
}

function buildSlideBlockList({ slideList, readImage }) {
  return slideList.flatMap((slide) => [
    { text: `[${formatMediaClock(slide.startMediaMs)}부터 보인 화면 — 슬라이드 ${slide.label}]` },
    {
      image: {
        format: IMAGE_FORMAT_MAP[path.extname(slide.filePath).toLowerCase()] || 'jpeg',
        source: { bytes: readImage(slide.filePath).toString('base64') },
      },
    },
  ]);
}

// Bedrock Converse content 블록. 자료가 없어 그 조건을 돌릴 수 없으면 skipReason 을 준다.
export function buildMaterialBlockList({
  kind, material, humanAdList = [], maxSlideCount = DEFAULT_MAX_SLIDE_COUNT, readImage = (filePath) => fs.readFileSync(filePath),
}) {
  if (kind === MATERIAL_KIND_MAP.questionOnly) return { blockList: [], skipReason: null };
  if (!material) return { blockList: null, skipReason: MATERIAL_SKIP_REASON_MAP.noRunDir };
  const transcriptBlock = { text: `[발표 전사]\n${material.transcriptText}` };
  if (kind === MATERIAL_KIND_MAP.transcript) return { blockList: [transcriptBlock], skipReason: null };
  if (kind === MATERIAL_KIND_MAP.sCondition) {
    return { blockList: [{ text: `[발표 전사와 화면 해설]\n${material.sConditionText}` }], skipReason: null };
  }
  if (kind === MATERIAL_KIND_MAP.humanAd) {
    if (!humanAdList.length) return { blockList: null, skipReason: MATERIAL_SKIP_REASON_MAP.noHumanAd };
    const text = buildHumanAdText({ utteranceList: material.utteranceList, humanAdList });
    return { blockList: [{ text: `[발표 전사와 화면 해설]\n${text}` }], skipReason: null };
  }
  const slideList = selectSlideList({ slideList: material.slideList, maxSlideCount });
  if (!slideList.length) return { blockList: null, skipReason: MATERIAL_SKIP_REASON_MAP.noSlide };
  const slideBlockList = buildSlideBlockList({ slideList, readImage });
  if (kind === MATERIAL_KIND_MAP.screenOnly) return { blockList: slideBlockList, skipReason: null };
  return { blockList: [...slideBlockList, transcriptBlock], skipReason: null };
}
