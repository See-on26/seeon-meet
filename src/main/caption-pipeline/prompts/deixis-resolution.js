const { NARRATION_TYPE_MAP, DEIXIS_FORM_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, NO_HAN_RULE, ENGLISH_NO_HAN_RULE, SPEECH_GAP_DECIDED_RULE,
} = require('../agents/shared/caption-parser');
const { CAPTION_LANGUAGE_MAP, DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');

const DEFAULT_DEIXIS_MIN_WORD_COUNT = 2;
const DEFAULT_DEIXIS_MAX_WORD_COUNT = 10;

// 지시 해설은 가리킨 대상의 내용만 읽는다(효과영상 레이블 13자리, 2026-10-17: 정답이 모두 "보는 중" 없이 대상 내용만이다).
// 대상이 둘 이상이면(라우터가 지시 공백 둘 이상으로 판단) 각각을 밝히게 한 줄만 더한다.
const DEIXIS_FORM_RULE_MAP = {
  [DEIXIS_FORM_MAP.simple]: [],
  [DEIXIS_FORM_MAP.complete]: [
    '발표자가 이 발화에서 대상을 둘 이상 가리켰다. 가리킨 순서대로 각각이 무엇인지 쉼표로 이어 적는다.',
  ],
};

// 레이블 정답의 절반이 화면 글자가 아니라 그림·아이콘·도형·필기 묘사였다(남녀 아이콘, 산점도 모양, 직선 필기, 상품 포장).
// 가리킨 것의 종류마다 무엇을 말할지 정해 준다. 이 줄과 규칙 (2)를 뺀 짧은 판은 범주 요약이 늘었다(10/17 v2~v4).
// 연락처 짝·여러 그림·로고 상품·선 하나 줄은 v1.2 검증(10/18, P1-4)에서 더했다. 예시는 평가 영상과 겹치지 않게 둔다.
const POINTED_KIND_RULE_LIST = [
  '가리킨 것에 따라 이렇게 적는다:',
  '- 글자·숫자·목록: 화면에 적힌 이름과 값을 그대로 옮긴다. 항목이 여럿이면 모두 적는다(많으면 앞의 4개).'
    + ' 연락처는 이름과 번호의 짝을 caption에도 모두 남기고, 용도 설명으로 대체하지 않는다.',
  '- 사진·그림·물건: 무엇인지 이름으로 말한다. 꾸민 로고만 있는 상품 사진은 상품명 대신 종류·모양을 말한다.'
    + ' 상품명은 같은 화면의 보통 글씨에서도 확인될 때만 쓴다. 간판의 보통 글씨는 그대로 옮긴다.',
  '- 아이콘·색·기호: 뜻하는 것을 말로 옮긴다(학생 아이콘 → 학생, 범례의 파란 선 → 범례에 적힌 그 항목 이름).',
  '- 그래프·도형·분포: 가리킨 구간이나 모양을 말한다(2015년 급락 구간, 가운데가 솟은 종 모양 곡선).',
  '- 여러 그림을 함께 가리키면 seen에 각 그림의 모양을 따로 적고, caption에도 그 모양들을 쉼표로 이어 남긴다.'
    + ' 공통 제목이나 개수로 줄이지 않는다.',
  '- 필기(밑줄·동그라미·색칠·화살표·선): 어디에 무엇을 그렸는지 말한다(마감일에 빨간 동그라미, 오른쪽 위로 긋는 선).',
  '- 현재 발화가 선 하나를 가리키면 화면에서 대응하는 선을 골라 실제 방향을 적는다. 앞뒤 발화에 나온 다른 선까지 나열하지 않는다.'
    + ' 둘을 견주는 발화라면 두 선을 함께 적는다.',
  // 3번 판: 2번 판(10/15 이해도 DB 실패 분석)의 화면 요소별 읽기 — 영어 화면의 팝업·출력·격자 위치·번호에서 NONE·범주 요약이 많았다.
  '- 팝업·툴팁·대화상자·실행 출력·오류 메시지: 새로 뜬 제목과 값·문구를 그대로 옮긴다.',
  '- 표: 가리킨 행·열 이름과 그 칸의 값을 짝지어 적는다. 그래프는 범례 이름과 값(적힌 값이 없으면 눈금으로 어림해 "약"), 가리킨 구간의 시점.',
  '- 격자·지도·배치도 속 위치: 행·열, 위·아래·왼쪽·오른쪽, 지명으로 말한다. 번호·ID·이름표가 붙은 대상은 번호·이름을 반드시 적는다.',
  '- 화면 글자가 영어면 영어 원문 그대로 옮긴다.',
  '- 소리로는 구별되지 않는 차이(띄어쓰기·철자·기호): 그 낱말을 다시 쓰지 말고 번호와 "붙여 씀·띄어 씀"으로 말한다.'
    + ' 같은 차이를 가진 항목은 번호를 묶어 말한다.',
  '- 발표자가 둘 이상을 견주면("여기는 A인데 여기는 B") 짝을 지어 각각 적는다.',
];

const EXAMPLE_LIST = [
  '예시 (발화 / 화면 → 출력):',
  '  "이 세 곳에 신청하시면 됩니다" / 목록 "주민센터·구청 민원실·정부24"'
    + ' → {"seen":"신청처 목록 주민센터, 구청 민원실, 정부24","caption":"주민센터, 구청 민원실, 정부24"}',
  '  "보시면 32, 18이에요" / 막대 옆에 버스 아이콘 32, 지하철 아이콘 18'
    + ' → {"seen":"버스 아이콘 막대 32, 지하철 아이콘 막대 18","caption":"버스 32, 지하철 18"}',
  '  "이건 꼭 지키세요" / 문서의 "제출 마감 3월 5일"에 빨간 동그라미'
    + ' → {"seen":"제출 마감 3월 5일에 빨간 동그라미","caption":"제출 마감 3월 5일에 빨간 동그라미"}',
  '  "둘 중 뭐가 맞을까요?" / "1. 할수 있다  2. 할 수 있다"'
    + ' → {"seen":"1. 할수 있다 2. 할 수 있다","caption":"1번 붙여 씀, 2번 띄어 씀"}',
];

function buildKoreanOutputInstruction({ minWordCount, maxWordCount }) {
  return [
    '출력 — JSON 한 줄만. JSON 앞뒤에 다른 글을 쓰지 않는다.',
    '  "seen": caption에 쓸 글자·모양만 짧게. 배경·판단 과정 제외.',
    `  "caption": 대상의 이름·값·모양 — ${minWordCount}~${maxWordCount}어절.`
      + ' seen에서 확인한 항목별 내용을 범주로 다시 요약하지 않는다.',
    NO_HAN_RULE,
    `낼 수 없으면 JSON 대신 "${GROUNDING_NONE_TOKEN}: 이유" 한 줄을 낸다.`,
  ].join('\n');
}

// 영어 캡션은 같은 출력 형식을 영어로 주고 영어 출력 규칙을 붙인다. 단어 수는 에이전트가 영어로 바꾼 예산이다.
function buildEnglishOutputInstruction({ minWordCount, maxWordCount }) {
  return [
    'Output — one line of JSON only. Do not write anything before or after the JSON.',
    '  "seen": only the text and shapes you will use in caption, briefly. No background or reasoning.',
    `  "caption": the item's names, values or shapes — ${minWordCount}–${maxWordCount} words.`
      + ' Do not re-summarize the item-by-item content of seen into a category.',
    ENGLISH_NO_HAN_RULE,
    `If you cannot, output a single line "${GROUNDING_NONE_TOKEN}: reason" instead of JSON.`,
    ...buildOutputLanguageRuleList({
      language: CAPTION_LANGUAGE_MAP.en,
      detailLineList: ['caption 은 대상의 이름·값·모양을 담은 자연스러운 영어 명사구로 쓴다. 시스템은 caption 만 읽는다.',
        '영어에서도 지시어(This·That·Here)로 시작하지 말고, "Looking at"·"Pointing at" 같은 동작 말을 붙이지 않는다.'
          + ' 가리킨 표시(circle·dot·marker)는 필기일 때만 말한다.'],
    }),
  ].join('\n');
}

// "이미 안내된" 해설 목록(describedElementList)은 모델에 보이지 않는다. 목록을 주면 앞선 해설의 연도·이름을
// 이번 화면에 옮겨 적었고(08b 연도 복사 8/11 → 목록을 빼면 0/35), 같은 내용이어도 NONE 이 되지 않았다(10/18 v1.2 검증 ③).
// 겹친 해설은 재생 전 중복 거르기(narration-history)가 맡는다.
function buildGroundingPrompt({ utterance, recentTranscript,
  hasPointingRegion = false, pointingOrderHint = '',
  minWordCount = DEFAULT_DEIXIS_MIN_WORD_COUNT, maxWordCount = DEFAULT_DEIXIS_MAX_WORD_COUNT,
  subKind = null, mergedAnchorList = [], language = DEFAULT_CAPTION_LANGUAGE }) {
  const trimmedUtterance = (utterance || '').trim();
  const resolvedSubKind = subKind || DEIXIS_FORM_MAP.simple;
  return [
    hasPointingRegion
      ? '이 이미지는 발표 화면에서 발표자가 방금 포인터나 필기로 가리킨 부분을 확대한 것이다.'
      : '이 이미지는 발표 화면(슬라이드·문서·사진·영상 장면)이다.',
    `발표자가 화면의 무언가를 가리키며 이렇게 말했다: "${trimmedUtterance}"`,
    recentTranscript ? `앞뒤 발화: ${recentTranscript}` : null,
    pointingOrderHint ? `표시 순서: ${pointingOrderHint}. 현재 발화의 대상 선택에 참고한다.` : null,
    mergedAnchorList.length ? `발표자가 가리킨 말: ${mergedAnchorList.join(', ')}. 각각이 무엇인지 모두 밝힌다.` : null,
    ...DEIXIS_FORM_RULE_MAP[resolvedSubKind],
    '',
    '할 일: 화면을 볼 수 없는 청자에게, 발표자가 "이거·여기·이렇게"로 가리킨 것이 무엇인지 짧은 구 하나로 알려 준다.',
    SPEECH_GAP_DECIDED_RULE,
    '발화가 이미 말한 낱말을 되풀이하지 말고, 화면을 봐야만 알 수 있는 것을 적는다.',
    '가리킨 곳이 또렷하지 않으면 발화와 가장 관련된 화면 요소(방금 뜬 창·출력·강조된 칸·발화가 말한 항목)를 골라 읽는다.',
    '',
    ...POINTED_KIND_RULE_LIST,
    '',
    '규칙:',
    '(1) 화면에 없는 이름·숫자는 지어내지 않는다. 발화와 화면 글자가 다르면 화면을 따른다.',
    '(2) 이름·숫자를 읽지 못하면 그 부분만 빼고 확인되는 종류·모양으로 설명한다. 익숙한 이름으로 보정하지 않는다.'
      + ' 읽히는 이름·값이나 보이는 모양 대신 범주 이름만 쓰지 않는다.',
    '(3) 지시어(이거·여기·이렇게·저기)를 쓰지 않는다. "가리킴·보는 중·설명함" 같은 행동 말도 붙이지 않는다 — 대상만 적는다.',
    '(4) 명사로 끝나는 짧은 구로 쓴다. 존댓말·문장으로 끝내지 않는다.',
    '',
    `가리킨 대상을 설명할 글자·그림·필기 등 시각 근거가 없을 때만 ${GROUNDING_NONE_TOKEN}이다.`,
    '그 밖에는 확인되는 내용으로 설명한다.',
    '',
    ...EXAMPLE_LIST,
    '',
    language === CAPTION_LANGUAGE_MAP.en
      ? buildEnglishOutputInstruction({ minWordCount, maxWordCount })
      : buildKoreanOutputInstruction({ minWordCount, maxWordCount }),
  ].filter((line) => line !== null).join('\n');
}

module.exports = { buildGroundingPrompt, DEIXIS_FORM_RULE_MAP, DEFAULT_DEIXIS_MIN_WORD_COUNT, DEFAULT_DEIXIS_MAX_WORD_COUNT };
