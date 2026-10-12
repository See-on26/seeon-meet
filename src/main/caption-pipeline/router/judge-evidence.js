const { TRIGGER_TYPE_MAP } = require('../trigger/speech-trigger');

// 판단 LLM 이 단순 수치·변화 후보를 X(공백 아님)로 볼 때 옮겨 적은 근거 구절을 코드로 확인한다.
// 9B 판단기는 비교 대상의 이름만 있거나 트리거 문장 자체를 근거로 들며 X 를 주는 일이 많아(재현율 50%대),
// 근거가 실제 발화에 있고 그 유형에 맞는 내용(변화는 수량, 수치는 무엇의 수치인지)을 담을 때만 X 를 믿는다.
const EVIDENCE_TYPE_LIST = [TRIGGER_TYPE_MAP.number, TRIGGER_TYPE_MAP.change];

const EVIDENCE_FAIL_REASON_MAP = {
  empty: 'empty',
  notInContext: 'not_in_context',
  phraseOnly: 'phrase_only',
  noQuantity: 'no_quantity',
  noSubject: 'no_subject',
};

// 한글 수사는 단위가 붙을 때만 수량으로 본다. "그것만"의 만, "추천"의 천, "이만큼", "한 번 보시죠"를 수량으로 읽지 않기 위해서다.
const NATIVE_COUNT_PATTERN = /(?:^|[^가-힣])(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|쉰)\s*(?:명|개|건|곳|대|배|점|시간|달|해|주|살|가지|분|초|병|장|권|마리|그루|톤)/;
const SINO_DIGIT = '[일이삼사오육칠팔구]';
const SINO_UNIT = '(?:명|개|건|원|퍼센트|프로|배|점|톤|미터|킬로|달러|대|곳|가구|세대|시간|분|초|년|개월)';
const SINO_COUNT_PATTERN = new RegExp(
  `(?:${SINO_DIGIT}?(?:십|백|천))+${SINO_DIGIT}?\\s*(?:만|억)?\\s*${SINO_UNIT}`
  + `|${SINO_DIGIT}+\\s*(?:만|억)\\s*${SINO_UNIT}`
  + `|(?:${SINO_DIGIT}|십)\\s*(?:퍼센트|프로)`,
);
const RATIO_WORD_PATTERN = /절반|반으로|반토막|(?:두|세|네)\s*배/;
const ENGLISH_QUANTITY_PATTERN = /\b(?:half|double|doubled|twice|triple|tripled|quarter|percent|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b/i;
const DIGIT_PATTERN = /[0-9０-９]/;
const ELLIPSIS_PATTERN = /\.{2,}|…/;
const SUBJECT_WORD_PATTERN = /[가-힣]{2,}|[A-Za-z]{3,}/;

function normalizeText(text) {
  return String(text || '')
    .replace(/["'“”‘’「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?。]+$/, '');
}

function hasQuantityExpression(text) {
  const value = String(text || '');
  return DIGIT_PATTERN.test(value) || NATIVE_COUNT_PATTERN.test(value) || SINO_COUNT_PATTERN.test(value)
    || RATIO_WORD_PATTERN.test(value) || ENGLISH_QUANTITY_PATTERN.test(value);
}

function stripPhrase({ text, phrase }) {
  const normalizedPhrase = normalizeText(phrase);
  return normalizedPhrase ? text.split(normalizedPhrase).join(' ') : text;
}

function needsEvidence({ type }) {
  return EVIDENCE_TYPE_LIST.includes(type);
}

// context: { before, utterance, after }. 근거는 앞뒤 발화나 트리거 문장 어디서 옮겨도 되지만 후보 구 자체는 근거가 아니다.
function verifyValueEvidence({ type, phrase, evidence, context }) {
  const normalizedEvidence = normalizeText(evidence);
  if (!normalizedEvidence) return { isVerified: false, failReason: EVIDENCE_FAIL_REASON_MAP.empty };
  const contextText = normalizeText([context?.before, context?.utterance, context?.after].filter(Boolean).join(' '));
  const compact = (text) => text.replace(/\s+/g, '');
  // 판단기는 앞 문장과 뒤 문장의 값을 말줄임표로 이어 붙여 옮기곤 한다. 조각마다 문맥에 그대로 있어야 한다.
  const fragmentList = normalizedEvidence.split(ELLIPSIS_PATTERN).map(normalizeText).filter(Boolean);
  const compactContext = compact(contextText);
  if (!fragmentList.length || !fragmentList.every((fragment) => compactContext.includes(compact(fragment)))) {
    return { isVerified: false, failReason: EVIDENCE_FAIL_REASON_MAP.notInContext };
  }
  const outsidePhrase = normalizeText(stripPhrase({ text: normalizedEvidence, phrase }));
  if (!outsidePhrase) return { isVerified: false, failReason: EVIDENCE_FAIL_REASON_MAP.phraseOnly };
  if (type === TRIGGER_TYPE_MAP.change && !hasQuantityExpression(outsidePhrase)) {
    return { isVerified: false, failReason: EVIDENCE_FAIL_REASON_MAP.noQuantity };
  }
  if (type === TRIGGER_TYPE_MAP.number && !SUBJECT_WORD_PATTERN.test(outsidePhrase)) {
    return { isVerified: false, failReason: EVIDENCE_FAIL_REASON_MAP.noSubject };
  }
  return { isVerified: true, failReason: null };
}

module.exports = {
  verifyValueEvidence, hasQuantityExpression, needsEvidence, EVIDENCE_TYPE_LIST, EVIDENCE_FAIL_REASON_MAP,
};
