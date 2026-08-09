const { NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP } = require('../contracts/narration-types');
const {
  getSlotList, truncateSlot, normalizeSlotMap, DESCRIPTION_TAIL_NOUN_LIST, hasCompleteTailNoun,
} = require('./shared/narration-format');
const { truncateToWordCount } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');

const AGENT_LABEL = '전환';
const PAGE_TRANSITION_MAX_TOKENS = 220;

const SCREEN_TYPE_LIST = [
  'ppt', 'doc', 'sheet', 'web', 'etc',
  'desktop', 'file_explorer', 'os_ui', 'unknown',
];

const DEFAULT_TRANSITION_MIN_WORD_COUNT = 6;
const DEFAULT_TRANSITION_MAX_WORD_COUNT = 9;

function buildPageTransitionPrompt({
  minWordCount = DEFAULT_TRANSITION_MIN_WORD_COUNT,
  maxWordCount = DEFAULT_TRANSITION_MAX_WORD_COUNT,
} = {}) {
  return [
    '이 이미지는 회의에서 방금 새로 표시되거나 전환된 공유 화면이다.',
    '청자는 시각장애인이라 화면을 볼 수 없다. 발화만으로는 알 수 없고 "화면을 봐야만" 아는 시각 정보만 짧게 고지하라.',
    '',
    '먼저 화면 유형을 분류한다.',
    '  고지 대상: ppt(발표 슬라이드) / doc(문서·한글·PDF) / sheet(엑셀·표 시트) / web(웹페이지) / etc(그 외 앱)',
    '  침묵 대상: desktop(바탕화면) / file_explorer(파일 탐색기) / os_ui(시작메뉴·설정·작업표시줄)',
    '            / unknown(어디에도 확실히 해당하지 않음)',
    '  · file_explorer는 **파일·폴더 목록이 주인공**인 화면이다. 셀 격자와 수식 입력줄이 보이면 sheet다.',
    '  · **확실하지 않으면 추측하지 말고 unknown을 반환하라.** 틀린 고지는 놓친 고지보다 나쁘다.',
    '내레이션 슬롯 — **고정 문구(슬라이드 번호·쉼표)는 시스템이 붙이므로 넣지 마라**:',
    '  · description: 화면 묘사 — **ppt면 6~9어절, 그 외(screenForm을 쓰는 경우)면 5~7어절**.',
    '      - **무엇에 관한 화면인지(주제)를 앞에 둔다.** 그 뒤에 자료의 종류를 밝힌다.',
    '      - **구성 요소를 나열하지 마라.** "제목과 본문", "본문과 그림", "설명과 4개"처럼 화면에',
    '        무엇이 놓여 있는지 읊는 것은 청자에게 쓸모가 없다 — 어느 화면에나 해당하는 말이기 때문이다.',
    '        나쁜 예) "목표와 사랑에 빠지세요 제목과 본문 텍스트"',
    '        좋은 예) "목표에 몰입하라는 주장과 본문"',
    '        나쁜 예) "커뮤니케이션 단계 설명과 4개"',
    '        좋은 예) "커뮤니케이션 4단계를 정리한 표"',
    '      - 자료의 종류(표·그래프·사진·다이어그램·지도 등)는 **가장 중요한 것 하나만** 밝힌다.',
    '      - 로고·배경·클립아트 같은 장식 요소는 제외한다.',
    '      - **반드시 그 자체로 끝난 구(句)로 쓴다.** 접속조사("~와/과")·관형형("~에 대한", "~하는")·',
    '        관형사("두", "여러")로 끝내지 마라. 어절이 모자라면 덜 중요한 것을 버리고 끝맺어라.',
    '        나쁜 예) "RAG의 핵심: 검색에 대한 설명과"   좋은 예) "RAG 검색 과정 다이어그램"',
    '      - **반드시 아래 명사 중 하나로 끝내라.** 이것이 문장을 맺는 유일한 방법이다:',
    `        ${DESCRIPTION_TAIL_NOUN_LIST.join(' / ')}`,
    '        나쁜 예) "선수들의 행동과 정신을 다룬"   좋은 예) "선수들의 행동과 정신을 다룬 문서"',
    '        나쁜 예) "가슴 속에 불을 안고"          좋은 예) "가슴 속의 열정을 말하는 문구"',
    '      - 콜론(:)을 쓰지 마라. 시스템이 "슬라이드 N: "을 이미 붙인다.',
    '  · screenForm: doc/sheet/web/etc일 때만 — 파일·화면 형태 1~2어절. 예) "엑셀", "한글파일", "네이버 웹페이지"',
    '  · 화면에 슬라이드 번호가 실제로 보이면 pageNumber에 그 숫자를, 없으면 null.',
    '',
    '',
    '또한 이 화면이 **사진 단독 제시**인지 판정한다(isPhotoOnly).',
    '  · true: 화면이 사실상 사진 한 장으로 채워져 있다. 사진에 대한 설명글만 곁들여진 경우도 true.',
    '  · false: 표·그래프·본문 텍스트 등 다른 자료가 사진과 함께 있거나, 사진이 없다.',
    '  (이 판정은 2-4 시각 직접 묘사 경로를 여는 신호다 — 사진만 있으면 발표자가 말로 설명하지 않아도',
    '   청자가 반응을 이해할 수 있게 따로 묘사해 준다.)',
    '',
    '이미지에 실제로 보이는 것만 쓴다. 지어내지 않는다.',
    'JSON 한 줄로만 출력한다(다른 텍스트 금지):',
    `{ "screenType": "${SCREEN_TYPE_LIST.join('|')}", "pageNumber": 정수 또는 null, "pageTopic": "화면 주제/제목",`,
    '  "isPhotoOnly": true 또는 false,',
    '  "screenForm": "형태(ppt면 빈 문자열)", "description": "주제 중심 화면 묘사, 끝맺힌 구",',
    '  "describedElementList": ["묘사가 언급한 시각 요소 명사구", ...] }',
  ].join('\n');
}

function normalizePageTransition(parsed) {
  const description = typeof parsed?.description === 'string' && parsed.description.trim()
    ? parsed.description : parsed?.narration;
  if (!parsed || typeof description !== 'string' || !description.trim()) return null;
  const screenType = SCREEN_TYPE_LIST.includes(parsed.screenType) ? parsed.screenType : 'etc';
  const subKind = screenType === 'ppt'
    ? PAGE_TRANSITION_KIND_MAP.slide : PAGE_TRANSITION_KIND_MAP.document;
  const slotList = getSlotList({
    narrationType: NARRATION_TYPE_MAP.pageTransition, subKind,
  });
  const descriptionSlot = slotList.find((slot) => slot.key === 'description');

  const descriptionText = normalizeSlotMap({
    slotList: [descriptionSlot], rawSlotMap: { description },
  }).description;
  const screenFormSlot = slotList.find((slot) => slot.key === 'screenForm');
  const screenForm = screenFormSlot
    ? truncateSlot({ text: parsed.screenForm || '', maxWordCount: screenFormSlot.maxWordCount })
    : '';
  // 허용 명사로 끝나지 않으면 말이 맺히지 않은 것이다. 고지는 버리되 화면유형·사진단독 판정은
  // 살린다 — 그쪽은 화면 레지스트리와 2-4 경로가 쓰는 별개 신호다.
  const isTailComplete = hasCompleteTailNoun({ text: descriptionText });
  return {
    screenType,
    pageNumber: Number.isFinite(parsed.pageNumber) ? Number(parsed.pageNumber) : null,
    pageTopic: typeof parsed.pageTopic === 'string' ? parsed.pageTopic : '',
    isPhotoOnly: parsed.isPhotoOnly === true,
    screenForm,
    description: isTailComplete ? descriptionText : '',
    rejectedDescription: isTailComplete ? '' : descriptionText,
    rejectedRawDescription: isTailComplete ? '' : description.trim(),
    subKind,
    narration: !isTailComplete ? '' : (subKind === PAGE_TRANSITION_KIND_MAP.slide
      ? descriptionText
      : [screenForm, descriptionText].filter(Boolean).join(', ')),
    describedElementList: Array.isArray(parsed.describedElementList)
      ? parsed.describedElementList.filter((element) => typeof element === 'string' && element.trim())
      : [],
  };
}

function parsePageTransitionText(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const normalized = normalizePageTransition(JSON.parse(jsonMatch[0]));
      if (normalized) return normalized;
    } catch {  }
  }

  const narrMatch = cleaned.match(/"(?:description|narration)"\s*:\s*"([^"]+)"/);
  if (narrMatch) return normalizePageTransition({ description: narrMatch[1] });

  if (!cleaned.includes('{')) {
    const firstLine = cleaned.split(/[\n.]/)[0].trim();
    if (firstLine) return normalizePageTransition({ description: firstLine.slice(0, 40) });
  }
  return null;
}

function createPageTransitionAgent({ config }) {
  async function generate({ jpegBuffer, ts, minWordCount, maxWordCount }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, maxTokens: PAGE_TRANSITION_MAX_TOKENS,
      prompt: buildPageTransitionPrompt({ minWordCount, maxWordCount }),
    });
    const narration = parsePageTransitionText(content);
    if (!narration) throw new Error(`VLM(${AGENT_LABEL}) 응답 파싱 실패 (ts=${ts})`);

    return {
      ...narration,
      pageTopic: truncateToWordCount({ text: narration.pageTopic, maxWordCount }),
    };
  }

  return { generate };
}

module.exports = {
  createPageTransitionAgent, buildPageTransitionPrompt, parsePageTransitionText,
  SCREEN_TYPE_LIST,
};
