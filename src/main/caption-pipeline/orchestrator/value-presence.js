const { NARRATION_TYPE_MAP, INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const { CAPTION_LANGUAGE_MAP } = require('../contracts/caption-language');
const { assembleNarration } = require('../agents/shared/narration-format');
const { SLIDE_TEXT_STATUS_MAP } = require('./slide-text-store');
const { resolveContentSwitch } = require('../agents/shared/content-switch');
const {
  NUMBER_CORE_PATTERN, extractNumberCoreList, containsNumberCore, normalizeForSearch, findMissingNumberCoreList,
} = require('../agents/shared/number-core');

const VALUE_PRESENCE_VERDICT_MAP = {
  present: 'present',
  absent: 'absent',
  unchecked: 'unchecked',
};

// 값을 무엇과 대조했나. frame_ocr = 해설 요청과 같은 프레임의 OCR 글자, slide_text = 슬라이드 확정 때 저장한 전사,
// chart_estimate = 화면에 적히지 않은 숫자를 그래프 어림값(막대 높이를 축 눈금으로 환산한 값)으로 인정.
const VALUE_CHECK_SOURCE_MAP = { frameOcr: 'frame_ocr', slideText: 'slide_text', chartEstimate: 'chart_estimate' };

// ASR 이 수를 한글로 적으면("칠십삼 퍼센트", "두 배") 숫자로 정규화된 값과 글자로 대조할 수 없다.
const SINO_NUMERAL_PATTERN = /[일이삼사오육칠팔구십백천만억]+\s*(?:퍼센트|프로|배|명|건|개|원|위|년|세|단계|점|초|분|시간)/;
const NATIVE_NUMERAL_PATTERN = /(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|쉰)\s*(?:배|명|건|개|가지|번|단계|곳|살)/;

function hasSpokenKoreanNumber(text) {
  return SINO_NUMERAL_PATTERN.test(text) || NATIVE_NUMERAL_PATTERN.test(text);
}

// 척도 해설에서 견준 배수·분수("4배", "3분의 1", "2 times")는 화면에 적힌 값이 아니라 모델이 견주어 낸 크기라 대조하지 않는다.
const SCALE_RATIO_PATTERN = /\d+(?:\.\d+)?\s*(?:배|분의\s*\d+(?:\.\d+)?|times\b|x\b|×)/gi;
const DIGIT_PATTERN = /\d/;

// 해설이 화면에 적힌 값을 읽었는지 대조할 값과, 대조에 쓸 세부 종류.
// 수치 해설은 값 칸을 그 세부 종류로 본다(값→의미는 발화도 함께 본다). 척도 값 먼저(켜짐)의 척도 해설은 NONE 을 덜 내게 바꿔
// 화면에 없는 값을 지어낼 위험이 커졌으므로, 읽을 해설(text, 칸 JSON 이 아니어도 같다)의 수(배수·분수 제외)를 화면 글자에만
// 대조한다(주장→값과 같다). text 가 없으면 caption 칸을 본다.
function readValueCheckTarget({ narrationType, subKind = null, slotMap = null, text = '', contentSwitch = null }) {
  if (narrationType === NARRATION_TYPE_MAP.interpretation) {
    return slotMap?.value ? { value: slotMap.value, checkSubKind: subKind || INTERPRETATION_KIND_MAP.valueToMeaning } : null;
  }
  const isScale = narrationType === NARRATION_TYPE_MAP.visualDescription
    && (subKind || VISUAL_DESCRIPTION_KIND_MAP.scale) === VISUAL_DESCRIPTION_KIND_MAP.scale;
  if (!isScale || !resolveContentSwitch(contentSwitch).isScaleValueFirstEnabled) return null;
  const value = String(text || slotMap?.caption || '').replace(SCALE_RATIO_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return DIGIT_PATTERN.test(value) ? { value, checkSubKind: INTERPRETATION_KIND_MAP.claimToValue } : null;
}

// 값 슬롯의 숫자가 화면 글자(값→의미는 트리거 발화와 앞뒤 발화도 포함)에 실제로 있는지 본다.
// 전사가 준비되지 않았거나 아라비아 숫자가 없으면 판단할 수 없으므로 막지 않는다.
function isValuePresent({ value, slideText = '', utterance = '', contextText = '', subKind,
  slideTextStatus }) {
  const coreList = extractNumberCoreList(value);
  if (!coreList.length) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: 'no-arabic-number' };
  }
  if (slideTextStatus !== SLIDE_TEXT_STATUS_MAP.ready) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: `slide-text-${slideTextStatus}` };
  }
  const isScreenOnly = subKind === INTERPRETATION_KIND_MAP.claimToValue;
  const sourceList = isScreenOnly ? [slideText] : [slideText, utterance, contextText];
  const haystack = sourceList.map(normalizeForSearch).join('\n');
  const missingList = coreList.filter((core) => !containsNumberCore({ haystack, core }));
  if (missingList.length && !isScreenOnly && hasSpokenKoreanNumber(`${utterance} ${contextText}`)) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: 'spoken-korean-numeral' };
  }
  if (missingList.length) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.absent, reason: `missing:${missingList.join(',')}`, missingList };
  }
  return { verdict: VALUE_PRESENCE_VERDICT_MAP.present, reason: '' };
}

async function confirmByRetranscription({ value, subKind, utterance, contextText, retranscribe }) {
  let fresh = null;
  try {
    fresh = await retranscribe();
  } catch (error) {
    return {
      verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: `retranscribe-failed:${error.message}`,
      isRetranscribed: true,
    };
  }
  if (!fresh?.hasText) {
    return { verdict: VALUE_PRESENCE_VERDICT_MAP.unchecked, reason: 'retranscribe-empty', isRetranscribed: true };
  }
  const freshVerdict = isValuePresent({
    value, subKind, utterance, contextText, slideText: fresh.text,
    slideTextStatus: SLIDE_TEXT_STATUS_MAP.ready,
  });
  return {
    ...freshVerdict, reason: `retranscribed${freshVerdict.reason ? `:${freshVerdict.reason}` : ''}`,
    isRetranscribed: true,
  };
}

// 화면에 없는 숫자 중 그래프 어림값 하나와 반올림 단위 안(|숫자 − 원래 어림값| ≤ 단위)에 드는 것.
function matchChartEstimateCoreList({ coreList = [], chartValueList = [] }) {
  return coreList.filter((core) => {
    const number = Number(core);
    return Number.isFinite(number) && chartValueList.some((entry) => Math.abs(number - entry.raw) <= entry.granularity);
  });
}

// frameText: 해설이 본 것과 같은 프레임의 OCR 글자(믿을 줄만). 있으면 그것으로 먼저 보고, 값이 없으면 저장 전사를 거치지 않고
// 지금 화면을 VLM 으로 다시 전사해 확인한다(OCR 오독을 다른 엔진으로 거른다). null 이면 지금처럼 저장 전사로 본다.
// 저장된 전사는 슬라이드 확정 순간의 화면이라, 클릭마다 항목이 나타나는 슬라이드나
// 출력 상한에 잘린 긴 표에서는 실제로 화면에 있는 값도 없다고 나온다.
// 없다고 나올 때만 지금 요청에 쓰인 화면을 다시 전사해 한 번 더 확인한다.
// chartValueList: 그래프 어림값(on 일 때만). 화면에 없는 숫자가 모두 어림값과 맞으면 있는 값으로 보고 재전사하지 않는다.
// 어림값이 화면에 적히지 않은 값이라 그대로 두면 막대를 눈금으로 반올림한 값("약 800")만 살아남는다.
async function verifyValuePresence({ value, subKind, utterance = '', contextText = '', slideText = '',
  slideTextStatus, frameText = null, retranscribe, chartValueList = [] }) {
  const isFrameChecked = typeof frameText === 'string';
  const checkedSource = isFrameChecked ? VALUE_CHECK_SOURCE_MAP.frameOcr : VALUE_CHECK_SOURCE_MAP.slideText;
  const firstVerdict = isValuePresent({
    value, subKind, utterance, contextText,
    slideText: isFrameChecked ? frameText : slideText,
    slideTextStatus: isFrameChecked ? SLIDE_TEXT_STATUS_MAP.ready : slideTextStatus,
  });
  if (firstVerdict.verdict !== VALUE_PRESENCE_VERDICT_MAP.absent) {
    return { ...firstVerdict, isRetranscribed: false, checkedSource };
  }
  const chartCoreList = matchChartEstimateCoreList({ coreList: firstVerdict.missingList, chartValueList });
  if (chartCoreList.length && chartCoreList.length === firstVerdict.missingList.length) {
    return {
      verdict: VALUE_PRESENCE_VERDICT_MAP.present, reason: `chart-estimate:${chartCoreList.join(',')}`,
      isRetranscribed: false, checkedSource: VALUE_CHECK_SOURCE_MAP.chartEstimate, chartCoreList,
    };
  }
  return {
    ...await confirmByRetranscription({ value, subKind, utterance, contextText, retranscribe }),
    checkedSource,
  };
}

// 어림값으로 통과한 숫자는 어림 표지를 붙여 읽는다. 앞("약 770", "about 770")이나 뒤("770쯤", "770명 정도")에 이미 있으면 그대로 둔다.
const APPROXIMATE_PREFIX_PATTERN = /(?:(?:^|[^가-힣])(?:약|대략)|\b(?:about|around|approximately|roughly)|~)\s*$/i;
const APPROXIMATE_SUFFIX_PATTERN = /^[^\s\d]{0,3}\s*(?:정도|쯤|가량)/;
const APPROXIMATE_MARK_MAP = { [CAPTION_LANGUAGE_MAP.ko]: '약 ', [CAPTION_LANGUAGE_MAP.en]: 'about ' };

function isApproximateMarked({ text, offset, token }) {
  return APPROXIMATE_PREFIX_PATTERN.test(text.slice(0, offset))
    || APPROXIMATE_SUFFIX_PATTERN.test(text.slice(offset + token.length));
}

function markApproximateNumber({ text, coreList = [], language = CAPTION_LANGUAGE_MAP.ko }) {
  const coreSet = new Set(coreList);
  const mark = APPROXIMATE_MARK_MAP[language] || APPROXIMATE_MARK_MAP[CAPTION_LANGUAGE_MAP.ko];
  const source = String(text || '');
  return source.replace(NUMBER_CORE_PATTERN, (token, offset) => (
    coreSet.has(token.replace(/,/g, '')) && !isApproximateMarked({ text: source, offset, token }) ? `${mark}${token}` : token
  ));
}

function hasUnmarkedApproximateNumber({ text, coreList = [] }) {
  const coreSet = new Set(coreList);
  const source = String(text || '');
  return [...source.matchAll(NUMBER_CORE_PATTERN)].some((match) => coreSet.has(match[0].replace(/,/g, ''))
    && !isApproximateMarked({ text: source, offset: match.index, token: match[0] }));
}

// 어림값으로만 통과한 숫자에 어림 표지를 붙여 해설을 다시 조립한다. 값 칸 상한에 걸려 표지를 붙인 값이 잘리거나
// 표지 없는 어림 숫자가 남으면 null — 어림을 사실처럼 말하게 되므로 그 해설은 버린다.
function approximateChartNarration({ narrationType, subKind, slotMap, coreList, hasSecondClaim = false,
  maxWordCount = null, maxChars = null, language = CAPTION_LANGUAGE_MAP.ko }) {
  const markedSlotMap = { ...slotMap };
  for (const key of ['value', 'value2']) {
    if (markedSlotMap[key]) markedSlotMap[key] = markApproximateNumber({ text: markedSlotMap[key], coreList, language });
  }
  const assembled = assembleNarration({
    narrationType, subKind, rawSlotMap: markedSlotMap, hasSecondClaim, maxWordCount, maxChars, language,
  });
  if (!assembled?.text) return null;
  const isValueKept = ['value', 'value2'].every((key) => !markedSlotMap[key] || !(key in assembled.slotMap)
    || assembled.slotMap[key] === markedSlotMap[key]);
  if (!isValueKept || hasUnmarkedApproximateNumber({ text: assembled.text, coreList })) return null;
  return assembled;
}

module.exports = {
  isValuePresent, verifyValuePresence, findMissingNumberCoreList, readValueCheckTarget, VALUE_PRESENCE_VERDICT_MAP, VALUE_CHECK_SOURCE_MAP,
  markApproximateNumber, hasUnmarkedApproximateNumber, approximateChartNarration,
};
