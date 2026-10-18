const { NARRATION_TYPE_MAP, DEIXIS_FORM_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, SPEECH_GAP_DECIDED_RULE,
} = require('../agents/shared/caption-parser');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');

const DEFAULT_DEIXIS_MIN_WORD_COUNT = 4;
const DEFAULT_DEIXIS_MAX_WORD_COUNT = 8;

const DEIXIS_FORM_RULE_MAP = {
  [DEIXIS_FORM_MAP.simple]: [
    '형식: (지시대상 묘사/내용 — 자료 종류 포함, 2~5어절) + (상황 묘사 — 발화 모사, 2어절).',
    '  · 지시대상 슬롯 하나에 "무엇의 무슨 자료인지"를 함께 담는다. 자료 종류를 따로 쪼개지 마라.',
    '  예) "여기를 보시면" → target="2년간 매출 추이 표를", situation="보는 중"',
    '  예) "오른쪽 것을 주목해 주십쇼" → target="설문 결과 표를", situation="주목 중"',
  ],
  [DEIXIS_FORM_MAP.complete]: [
    '형식: (발화 모사 2~3어절) + (지시대상 1~2어절) + (설명 3~5어절).',
    '  · 세 요소를 각각 내되, **최종 문장(sentence)은 순서를 바꿔 자연스럽게** 만든다.',
    '    셋의 내용은 문장 안에 모두 들어가야 한다. 주어-서술어 순서는 유연히 바꿔도 된다.',
    '  예) "그 중에 가장 으뜸인 게 이거거든요"',
    '      → mimicry="가장 으뜸인", target="E방식", explanation="다섯 방식 중 하나",',
    '        sentence="다섯 방식 중 E방식이 가장 으뜸임"',
    '  예) "이거랑 이게 여기 같이 있는 거거든요"',
    '      → mimicry="같이 있는", target="워드 파일", explanation="텍스트와 텍스트 같은 이미지가",',
    '        sentence="텍스트와 텍스트 같은 이미지가 워드 파일에 같이 있음"',
  ],
};

function buildGroundingPrompt({ utterance, recentTranscript, maxChars,
  hasPointingRegion = false, pointingOrderHint = '', describedElementList = [],
  minWordCount = DEFAULT_DEIXIS_MIN_WORD_COUNT, maxWordCount = DEFAULT_DEIXIS_MAX_WORD_COUNT,
  subKind = null, mergedAnchorList = [], language = DEFAULT_CAPTION_LANGUAGE }) {
  const trimmedUtterance = (utterance || '').trim();
  const formRuleList = DEIXIS_FORM_RULE_MAP[subKind]
    || [...DEIXIS_FORM_RULE_MAP.simple, ...DEIXIS_FORM_RULE_MAP.complete];
  return [
    hasPointingRegion
      ? '이 이미지는 회의 공유화면에서 발표자가 방금 필기하거나 포인터로 가리킨 영역을 확대한 것이다.'
      : '이 이미지는 회의에서 공유 중인 화면이다.',
    `발표자가 방금 이렇게 말하며 화면의 무언가를 가리켰다: "${trimmedUtterance}"`,
    recentTranscript
      ? `발표자의 인접 발화(트리거 직전 1분 이내 + 직후 발화)는 다음과 같다: ${recentTranscript}`
      : '',
    describedElementList.length
      ? `이미 안내된 시각 요소·내레이션이다(재설명 금지): ${describedElementList.join(' / ')}`
      : '',
    pointingOrderHint
      ? `발표자가 화면을 다음 순서로 표시(필기/포인터)했다: ${pointingOrderHint}. 이 선후관계를 반영해 설명하라.`
      : '',
    mergedAnchorList.length
      ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 문장 안에 함께 밝혀라.`
      : '',
    '청자는 화면을 볼 수 없다. 발표자가 가리킨 대상 중, 말로는 아직 설명되지 않은 시각 정보를 보충하는 캡션을 만들어라.',
    SPEECH_GAP_DECIDED_RULE,
    '가리킨 대상의 이름(지명·항목명·제품명 등)은 화면에서 읽어 반드시 밝힌다 — 지시어로만 들은 청자는 그것이 어느 것인지 모른다.',
    '',
    '아래 둘 중 하나일 때만 캡션을 만들지 않는다:',
    '  (가) 가리킨 대상을 화면에서 특정할 수 없다 — 가리킨 곳에 읽을 글자·그림이 없다.',
    '  (나) "이미 안내된" 목록에 같은 대상과 같은 내용이 있다 — 표현이 달라도 같은 대상·같은 내용이면 겹친 것이다.',
    '      "다양한 문서가 비정형"과 "각종 비정형 데이터 표"는 같은 내용이다.',
    '      목록이 슬라이드 주제만 말했다면 그 안의 대상은 아직 안내되지 않은 것이다.',
    '',
    ...formRuleList,
    '',
    '규칙:',
    '(1) **화면에서 읽은 낱말만 쓴다.** 발화에서 들린 이름이라도 화면에 없으면 쓰지 마라.',
    '    발표자의 말은 잘못 들린 것일 수 있다 — 화면 글자와 다르면 화면 쪽을 믿어라.',
    '    단, 발화 모사(발표자가 말한 성질·상태 표현)는 화면에 없어도 된다. 화면에서 읽어야 하는 것은 대상의 이름·내용이다.',
    '(2) 발표자 발화의 문장 구성과 어휘를 모사하되, **지시어는 모사하지 않는다.**',
    '    "이거·이런 식으로·여기·저기·이쪽"은 캡션에 옮기지 마라 — 청자는 그것을 볼 수 없다.',
    '    발화가 "이런 식으로 엑셀을 쓰신다"면 대상은 "표 형태로 쓴 엑셀 파일"이다.',
    '    발화가 대상 둘을 견주면("여기는 A인데 여기는 B") 그 대비를 살려라 —',
    '    한쪽으로 뭉뚱그리면 뜻이 무너진다.',
    '(3) 종결은 "~임", "~음", "~함"처럼 간결한 명사형으로 한다. 존댓말·설명체를 쓰지 않는다.',
    '(4) 지시 대상은 **화면을 봐야만 알 수 있는 내용**으로 적는다.',
    '    화면에 적힌 글자·수치·항목명을 실제로 읽어서 넣어라. 범주 이름으로 때우지 마라.',
    '      나쁨: "각종 비정형 데이터 표"   ← 발표자가 이미 말한 이름이다',
    '      좋음: "엑셀·스캔 문서·모바일 화면이 뒤섞인 자료"',
    '      나쁨: "관리 항목"               좋음: "서버·DB 종류, 방화벽, DRM 등 11개 항목"',
    '    스스로 물어라 — 눈을 감은 사람이 이 말을 듣고 화면을 그려 볼 수 있는가?',
    '    **화면에 적힌 문구를 그대로 가져다 쓴다.** 뜻을 풀어 새 낱말을 만들지 마라.',
    '      나쁨: "개인정보 유무 확인 가능한 지식"  ← "지식"은 화면에도 발화에도 없다',
    '      좋음: "민감정보 포함 여부 항목"        ← 화면에 그대로 적혀 있다',
    '    수식을 길게 잇지 마라("~할 수 있는 ~하는 ~"). 화면 문구 + 자료 종류면 충분하다.',
    '(5) 상황 슬롯은 **발표자가 실제로 쓴 동사**를 모사한다.',
    '    "보시면" → "보는 중" / "주목해 주세요" → "주목 중" / "비교해 보면" → "비교 중"',
    '    **"가리키며 설명함"은 쓰지 마라.** 가리켰다는 사실은 청자에게 아무 정보도 아니다.',
    '    모사할 동사가 마땅치 않으면 "확인 중"처럼 짧게 둔다.',
    '(6) 가리킨 대상에 항목명과 수치가 같이 있으면 둘 다 넣는다.',
    `(7) 위 두 경우에 해당하면 "${GROUNDING_NONE_TOKEN}"이다. 그 밖에는 반드시 캡션을 만든다.`,
    `(참고: 총 ${minWordCount}~${maxWordCount}어절, 최대 ${maxChars}자 분량이다.)`,
    '',
    buildSlotOutputInstruction({
      narrationType: NARRATION_TYPE_MAP.deixis,
      subKind: subKind || DEIXIS_FORM_MAP.simple,
      language,
    }),
    ...buildOutputLanguageRuleList({
      language,
      detailLineList: ['영어 캡션은 "~임/~함" 명사형 대신 자연스러운 영어 구로 쓴다.'
        + ' 단순형(simple)은 시스템이 situation 을 target 앞에 붙여 읽는다(예: "Looking at the two-year sales trend table").'],
    }),
  ].filter(Boolean).join('\n');
}

module.exports = { buildGroundingPrompt, DEIXIS_FORM_RULE_MAP, DEFAULT_DEIXIS_MIN_WORD_COUNT, DEFAULT_DEIXIS_MAX_WORD_COUNT };
