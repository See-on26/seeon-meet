const {
  NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP, DEIXIS_FORM_MAP,
  INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP, SPEAKER_IDENTITY_KIND_MAP,
} = require('../../contracts/narration-types');
const { NARRATION_ORIGIN_MAP } = require('../../contracts/narration-class');
const { CAPTION_LANGUAGE_MAP } = require('../../contracts/caption-language');

const DIGIT_HAS_FINAL_MAP = {
  0: true, 1: true, 2: false, 3: true, 4: false,
  5: false, 6: true, 7: true, 8: true, 9: false,
};

const SYMBOL_HAS_FINAL_MAP = { '%': false, $: false, '°': false };

const TRAILING_PUNCTUATION_PATTERN = /[\s.,!?…"'’”\])}」』]+$/;

const HANGUL_FIRST_CODE = 0xac00;
const HANGUL_LAST_CODE = 0xd7a3;
const HANGUL_FINAL_COUNT = 28;

function hasFinalConsonant({ text }) {
  const trimmed = String(text || '').replace(TRAILING_PUNCTUATION_PATTERN, '');
  if (!trimmed) return false;
  const lastCharacter = trimmed[trimmed.length - 1];
  if (lastCharacter in SYMBOL_HAS_FINAL_MAP) return SYMBOL_HAS_FINAL_MAP[lastCharacter];
  if (lastCharacter >= '0' && lastCharacter <= '9') return DIGIT_HAS_FINAL_MAP[Number(lastCharacter)];
  const code = lastCharacter.charCodeAt(0);
  if (code < HANGUL_FIRST_CODE || code > HANGUL_LAST_CODE) return false;
  return (code - HANGUL_FIRST_CODE) % HANGUL_FINAL_COUNT !== 0;
}

function attachJosa({ text, withFinal, withoutFinal }) {
  return `${text}${hasFinalConsonant({ text }) ? withFinal : withoutFinal}`;
}

function countWord({ text }) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

const SLOT_OVERAGE_TOLERANCE_WORD_COUNT = 2;

function truncateSlot({ text, maxWordCount }) {
  const wordList = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (wordList.length <= maxWordCount) return wordList.join(' ');
  return wordList.slice(0, maxWordCount).join(' ');
}

const INCOMPLETE_TAIL_PATTERN = new RegExp(`(?:${[
  '와', '과', '및', '랑', '이랑', '하고', '의', '을', '를', '에', '에서', '으로', '로',
  '에게', '한테', '부터', '까지', '보다', '처럼', '만큼', '이나', '나', '또는', '그리고', '또한',
  '대한', '관한', '위한', '통한', '같은', '있는', '없는', '하는', '되는', '드는', '라는', '이라는',
  '인', '한', '된', '할', '될',
  '긴', '짧은', '큰', '작은', '넓은', '좁은', '높은', '낮은', '굵은', '가는', '두꺼운', '얇은',
  '밝은', '어두운', '붉은', '푸른', '검은', '흰', '노란', '파란', '빨간', '여러', '다양한', '각',
  '그', '이', '저', '어떤', '무슨',
].join('|')})$`);
const INCOMPLETE_SUFFIX_PATTERN = /(?:는|던)$/;
// "금일 오후 6시까지"의 "6시까지"는 기한 자체라 덜 끝난 말이 아니다. 숫자에 붙은 까지·부터는 남긴다.
const NUMBERED_RANGE_TAIL_PATTERN = /\d\D{0,3}(?:까지|부터)$/;

const SAFE_INCOMPLETE_TAIL_PATTERN = new RegExp(`(?:${[
  '및', '하고', '또는', '그리고', '또한', '에서', '에게', '한테', '부터', '까지', '보다', '처럼', '만큼',
  '대한', '관한', '위한', '통한', '같은', '있는', '없는', '하는', '되는', '드는', '라는', '이라는',
  '어떤', '무슨', '다양한', '여러',
].join('|')})$`);

const TRAILING_MARK_PATTERN = /[\s,、·+\-–—:;/(]+$/;

const DESCRIPTION_TAIL_NOUN_LIST = [
  '문서', '표', '그래프', '차트', '사진', '이미지', '그림', '다이어그램', '지도', '목록', '리스트',
  '본문', '텍스트', '슬라이드', '화면', '페이지', '코드', '수식', '영상', '제목', '문구', '인용',
  '방법', '내용', '설명', '소개', '안내', '정리', '구조', '과정', '단계', '결과', '비교', '요약',
  '개요', '예시', '항목', '조건', '기준', '원칙', '전략', '계획', '현황', '메시지', '주장', '질문',
  '흐름도', '순서도', '도식', '도표', '캡처', '스크린샷', '삽화', '로고', '아이콘', '그래픽',
  '사례', '절차', '유형', '종류', '특징', '장점', '단점', '개념', '정의', '배경', '관계', '기능',
  '역할', '구성',
  '자료', '데이터', '모음', '묶음', '장', '건', '점', '컷', '양식', '서식', '보고서', '기록',
  '수치', '값', '통계', '지표', '비율', '분포', '추이', '변화', '실적', '성과',
  '박스', '상자', '카드', '배너', '도형', '버튼', '메뉴', '창', '탭', '타임라인', '로드맵', '일정',
  // PPT 가 아닌 화면은 묘사를 화면 형태로 끝맺는다("…네이버 블로그", "…파일 탐색기").
  '블로그', '사이트', '탐색기', '폴더', '시트', '파일', '게시판', '게시글', '메일',
  '조직도', '목차', '표지', '평가', '제도', '정책',
  '구조도', '구성도', '개념도', '모식도', '관계도', '계통도', '체계도', '배치도', '설계도', '도면',
];

// 묘사 끝 낱말에서 떼어 볼 조사. 긴 것부터 맞춰야 '으로'를 '로'로 잘못 떼지 않는다.
const TAIL_PARTICLE_LIST = [
  '으로', '에서', '에게', '이랑', '과', '와', '을', '를', '이', '가', '은', '는', '의', '에', '도', '로', '랑',
];

// 자료 명사로 끝나 보이지만 명사가 아닌 낱말. "가장"은 '장'(사진 세 장)으로 끝나 "…29건으로 가장"처럼 잘린 묘사가 완결로 통과했다.
const NOT_TAIL_NOUN_WORD_SET = new Set(['가장']);

function endsWithTailNoun({ word, tailNounList = DESCRIPTION_TAIL_NOUN_LIST }) {
  return !NOT_TAIL_NOUN_WORD_SET.has(word) && tailNounList.some((noun) => word.endsWith(noun));
}

function stripTailParticle(word) {
  const particle = TAIL_PARTICLE_LIST.find((candidate) => word.length > candidate.length && word.endsWith(candidate));
  return particle ? word.slice(0, -particle.length) : word;
}

// VLM 이 상한을 넘겨 쓰거나 자료 명사로 맺지 못한 묘사를, 상한 안에서 자료 명사로 끝나는 가장 긴 지점까지 자른다.
// 그 지점의 조사는 뗀다("…설명한 본문과" → "…설명한 본문"). 하한보다 짧아지면 null 이다.
function cutAtTailNoun({ text, maxWordCount, minWordCount, tailNounList = DESCRIPTION_TAIL_NOUN_LIST }) {
  const wordList = String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, maxWordCount);
  for (let lastIndex = wordList.length - 1; lastIndex >= minWordCount - 1; lastIndex -= 1) {
    const word = wordList[lastIndex].replace(TRAILING_MARK_PATTERN, '');
    const candidate = endsWithTailNoun({ word, tailNounList }) ? word : stripTailParticle(word);
    if (endsWithTailNoun({ word: candidate, tailNounList })) return [...wordList.slice(0, lastIndex), candidate].join(' ');
  }
  return null;
}

const INCOMPLETE_WORD_SET = new Set([
  '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열',
  '몇', '각', '여러', '모든', '온갖', '어떤', '무슨', '그', '이', '저', '첫', '첫째', '둘째',
]);

function trimToCompletePhrase({ text, isConservative = false }) {
  const tailPattern = isConservative ? SAFE_INCOMPLETE_TAIL_PATTERN : INCOMPLETE_TAIL_PATTERN;
  const wordList = String(text || '').trim().split(/\s+/).filter(Boolean);
  while (wordList.length > 1) {
    const last = wordList[wordList.length - 1].replace(TRAILING_MARK_PATTERN, '');
    const isNumberedRange = isConservative && NUMBERED_RANGE_TAIL_PATTERN.test(last);
    if (!last || INCOMPLETE_WORD_SET.has(last)
      || (!isNumberedRange && tailPattern.test(last)) || INCOMPLETE_SUFFIX_PATTERN.test(last)) {
      wordList.pop(); continue;
    }
    wordList[wordList.length - 1] = last;
    break;
  }
  const tail = wordList[wordList.length - 1];
  if (wordList.length === 1 && tail.length > 1 && tail.endsWith('를')) {
    wordList[0] = tail.slice(0, -1);
  }
  return wordList.join(' ').replace(TRAILING_MARK_PATTERN, '');
}

// 지시 해설은 가리킨 대상의 이름·내용만 읽는다. "보는 중" 같은 상황 칸은 청자에게 정보가 아니라 두지 않는다.
// seen 은 가리킨 곳에 보이는 것을 먼저 옮겨 적게 해 지어내기를 줄이는 근거 칸이다(읽히지 않는다).
// 띄어쓰기 비교처럼 항목이 넷이면 11어절이 넘어서(효과영상 레이블) caption 은 12어절까지 받는다.
const DEIXIS_SLOT_LIST = [
  { key: 'seen', label: '가리킨 곳에 실제로 보이는 것 — 글자는 그대로, 그림·필기는 짧게', minWordCount: 0, maxWordCount: 20, isDiagnostic: true },
  { key: 'caption', label: '청자에게 읽어 줄 해설 — 가리킨 대상의 이름·내용', minWordCount: 2, maxWordCount: 12, isPhrase: true },
];

const NARRATION_SLOT_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: {
    [PAGE_TRANSITION_KIND_MAP.slide]: [
      { key: 'description', label: '슬라이드 전체 묘사 (주제 + 자료 종류)', minWordCount: 6, maxWordCount: 9, isPhrase: true, tailNounList: DESCRIPTION_TAIL_NOUN_LIST },
    ],
    [PAGE_TRANSITION_KIND_MAP.document]: [
      { key: 'screenForm', label: '파일/화면 형태 (예: 엑셀, 한글파일, 네이버 웹페이지)', minWordCount: 1, maxWordCount: 2 },
      { key: 'description', label: '묘사 (주제 + 화면 형태)', minWordCount: 5, maxWordCount: 7, isPhrase: true, tailNounList: DESCRIPTION_TAIL_NOUN_LIST },
    ],
  },
  [NARRATION_TYPE_MAP.deixis]: {
    [DEIXIS_FORM_MAP.simple]: DEIXIS_SLOT_LIST,
    [DEIXIS_FORM_MAP.complete]: DEIXIS_SLOT_LIST,
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: [
      { key: 'value', label: '발화에 나온 단순 수치 (예: 73%)', minWordCount: 1, maxWordCount: 2, mustContainValue: true },
      { key: 'frame', label: '값의 해석틀 — 화면에서 찾은 대상·기준 (예: 작년 대비 A사 기업가치 성장률)', minWordCount: 3, maxWordCount: 5, isPhrase: true },
    ],
    // 발화 표현을 칸에 넣으면 "…빨라졌습니다를 의미"처럼 발화가 그대로 붙는다. 대상과 근거 값만 화면에서 읽는다.
    // 대상 칸 4어절에서는 "…혈당 상승도"의 측정량 낱말이, 값 칸 6어절에서는 네 항목 목록의 뒤쪽이 잘렸다(발화 기반 23자리, 10/18).
    // 전체 예산은 조립 뒤에 맞춘다(fitClaimPairToBudget).
    [INTERPRETATION_KIND_MAP.claimToValue]: [
      { key: 'target', label: '변화·비교의 대상 — 화면에 적힌 항목 이름. 발표자가 여러 항목을 묶어 부른 말이면 그 묶음 이름 (예: 첫 응답 시간, 4분기 매출, 인력)', minWordCount: 1, maxWordCount: 5, isPhrase: true },
      { key: 'value', label: '화면에서 찾은 근거 값 — 반드시 수치. 변화면 바뀌기 전 값에서 바뀐 뒤 값(바뀐 뒤 값만 있으면 그 값), 비교면 두 대상과 각 값, 묶음 이름이면 항목 2개까지 각 이름과 값 (예: 9.2시간에서 3.1시간, 도심 33.8도 교외 29.1도, 개발자 120명과 디자이너 30명)', minWordCount: 1, maxWordCount: 8, mustContainValue: true },
    ],
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: [
      // 무발화 묘사는 값·변화를 담아 "…그래프"로 끝맺는다. 5어절에서 자르면 자료 종류 꼬리가 빠져 묘사가 버려진다.
      { key: 'description', label: '이미지에 대한 묘사 (반응을 일으키는 요소 포함)', minWordCount: 3, maxWordCount: 8, isPhrase: true },
    ],
    // "○○보다 N배 큰 ○○" 네 칸으로는 "○○만 한", "○○를 다 덮는", "○○의 절반쯤", 측정값을 말할 수 없고
    // 칸을 잇다 "보다보다·배배"가 생겼다(발화 기반 척도 6자리, 10/18). 크기 묘사를 자유 구 하나로 받는다.
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: [
      { key: 'caption', label: '청자에게 읽어 줄 크기 묘사 — 발표자가 말한 대상을 화면 속 기준과 견준 크기, 그래프·표의 양이면 그 값 (예: 5층 건물의 두 배쯤 되는 크레인, 약 3만 명으로 가장 많은 3월 방문객)', minWordCount: 3, maxWordCount: 10, isPhrase: true },
    ],
  },
  [NARRATION_TYPE_MAP.speakerIdentity]: {
    [SPEAKER_IDENTITY_KIND_MAP.named]: [
      { key: 'speakerName', label: '참가자 이름표에 적힌 이름 (호칭·직함 제외)', minWordCount: 1, maxWordCount: 2 },
    ],
    [SPEAKER_IDENTITY_KIND_MAP.positional]: [
      { key: 'position', label: '타일 위치 (예: 왼쪽 위, 가운데, 오른쪽 아래)', minWordCount: 1, maxWordCount: 2 },
    ],
  },
};

// 무발화 묘사는 발표자가 보라고 한 자료를 전한다. 구조도는 제목만으로는 무엇을 보는지 알 수 없어
// 구성 요소와 연결 관계까지 말해야 하므로 사진 반응 묘사(8어절)보다 길게 받는다.
const SILENCE_DESCRIPTION_SLOT_LIST = [
  {
    key: 'description',
    label: '보라고 한 자료의 묘사 — 그래프·표는 값·변화, 구조도·흐름도는 주요 구성 요소와 연결 관계 (자료 종류로 끝맺음)',
    minWordCount: 3,
    maxWordCount: 12,
    isPhrase: true,
    // 값·연결을 담은 묘사는 13~14어절로 나오는 일이 잦다. 12어절에서 자르면 자료 명사 꼬리가 빠져 통째로 버려지므로,
    // 전환 묘사처럼 허용치(2어절) 안에서 자료 명사로 끝나면 그대로 받고, 넘으면 12어절 안의 마지막 자료 명사에서 자른다.
    tailNounList: DESCRIPTION_TAIL_NOUN_LIST,
  },
];

// 한 발화에 변화를 두 번 말했으면(hasSecondClaim) 둘째 대상·값 칸을 더한다. 같은 대상이면 비워 두고 첫 쌍만 읽는다.
const CLAIM_PAIR_VALUE_MAX_WORD_COUNT = 10;
const CLAIM_SECOND_PAIR_SLOT_LIST = [
  { key: 'target2', label: '발표자가 또 말한 변화의 대상 — 첫 대상과 다를 때만. 같거나 없으면 빈 문자열', minWordCount: 0, maxWordCount: 4, isPhrase: true },
  { key: 'value2', label: '그 대상의 근거 값 — 반드시 수치. 같거나 없으면 빈 문자열', minWordCount: 0, maxWordCount: 5 },
];

const ENGLISH_DEIXIS_LABEL_MAP = {
  seen: 'what is actually visible where the speaker pointed — text as written, drawings/marks briefly',
  caption: 'the narration read to the listener — the name, values or shape of the referenced item',
};

// 영어 캡션의 칸 설명. 칸 이름·어절(단어) 수는 한국어 칸과 같고, 설명만 영어 구에 맞게 바꾼다.
const ENGLISH_SLOT_LABEL_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: {
    [PAGE_TRANSITION_KIND_MAP.slide]: {
      description: 'whole-slide description (topic + material type), ending with the material type (e.g. "quarterly sales comparison bar chart")',
    },
    [PAGE_TRANSITION_KIND_MAP.document]: {
      screenForm: 'file/screen form (e.g. Excel sheet, HWP file, Naver web page)',
      description: 'description (topic + screen form), ending with the screen form',
    },
  },
  [NARRATION_TYPE_MAP.deixis]: {
    [DEIXIS_FORM_MAP.simple]: ENGLISH_DEIXIS_LABEL_MAP,
    [DEIXIS_FORM_MAP.complete]: ENGLISH_DEIXIS_LABEL_MAP,
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: {
      value: 'the plain figure the speaker said (e.g. 73%)',
      frame: 'what the figure measures — the item/basis found on screen (e.g. "Company A\'s year-over-year valuation growth rate")',
    },
    [INTERPRETATION_KIND_MAP.claimToValue]: {
      target: 'the item that changed or was compared — the item name written on screen; if the speaker grouped several items,'
        + ' that group name (e.g. first response time, Q4 sales, staff)',
      value: 'the supporting figure from the screen — must be a number. For a change, the value before to the value after'
        + ' (only the value after if that is all there is); for a comparison, both items with their values; for a group,'
        + ' up to 2 items with names and values (e.g. "9.2 hours to 3.1 hours", "downtown 33.8°C, suburbs 29.1°C",'
        + ' "120 developers and 30 designers")',
      target2: 'another item whose change the speaker mentioned — only if it differs from the first item; empty string if same or none',
      value2: 'that item\'s supporting figure — must be a number; empty string if same or none',
    },
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: {
      description: 'description of the image (including what triggers the reaction)',
    },
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: {
      caption: 'size description read to the listener — the item the speaker called big/small compared with a reference on screen,'
        + ' or its value if it is a chart/table amount (e.g. "a crane about twice as tall as the five-story building")',
    },
  },
  [NARRATION_TYPE_MAP.speakerIdentity]: {
    [SPEAKER_IDENTITY_KIND_MAP.named]: {
      speakerName: 'name on the participant name tag (without titles or honorifics)',
    },
    [SPEAKER_IDENTITY_KIND_MAP.positional]: {
      position: 'tile position in English (e.g. top left, center, bottom right)',
    },
  },
};
const ENGLISH_SILENCE_DESCRIPTION_LABEL_MAP = {
  description: 'description of the material the speaker asked to look at — for charts/tables the values and changes,'
    + ' for structure/flow diagrams the main components and how they connect (end with the material type)',
};

function readSlotList({ narrationType, subKind, origin = null, hasSecondClaim = false }) {
  const isSilenceDescription = origin === NARRATION_ORIGIN_MAP.silence
    && narrationType === NARRATION_TYPE_MAP.visualDescription && subKind === VISUAL_DESCRIPTION_KIND_MAP.reaction;
  if (isSilenceDescription) return SILENCE_DESCRIPTION_SLOT_LIST;
  const slotList = NARRATION_SLOT_MAP[narrationType]?.[subKind] || null;
  const isClaimPair = hasSecondClaim && narrationType === NARRATION_TYPE_MAP.interpretation
    && subKind === INTERPRETATION_KIND_MAP.claimToValue;
  if (!slotList || !isClaimPair) return slotList;
  // 둘째 변화를 둘째 칸 대신 첫 값 칸에 함께 쓰는 경우가 있어, 두 값이 다 들어가게 값 칸을 넓힌다.
  return [
    ...slotList.map((slot) => (slot.key === 'value' ? { ...slot, maxWordCount: CLAIM_PAIR_VALUE_MAX_WORD_COUNT } : slot)),
    ...CLAIM_SECOND_PAIR_SLOT_LIST,
  ];
}

// 영어는 관사·전치사 때문에 같은 내용도 한국어 어절보다 단어가 많다(9어절 상한에서는 영어 전환 묘사의 절반 가까이가 길어 버려졌다).
// 상한은 들리는 길이가 한국어와 같도록 TTS 2배속 실측 비율로 잡는다: 한국어 어절당 0.45초(mode-policy SPEECH_MS_PER_WORD)
// ÷ 영어 단어당 0.238초(MeloTTS EN-US, 10/18 6문장 72단어) ≈ 1.9.
// 하한은 그대로 둔다 — 영어가 한국어보다 단어가 적을 일은 드물고, 올리면 짧고 온전한 영어 구가 빈 칸으로 버려진다.
const ENGLISH_WORD_SCALE = 1.9;

function scaleMaxWordCount({ count, language }) {
  if (language !== CAPTION_LANGUAGE_MAP.en || !Number.isFinite(count) || count <= 0) return count;
  return Math.ceil(count * ENGLISH_WORD_SCALE);
}

// 렌더러가 모드별로 정한 어절 예산을 캡션 언어의 단어 수로 바꾼다. 한국어는 그대로다.
function scaleWordBudget({ minWordCount, maxWordCount, language }) {
  return { minWordCount, maxWordCount: scaleMaxWordCount({ count: maxWordCount, language }) };
}

// 영어 칸 가운데 어절 수를 그대로 옮기면 안 되는 칸. 지시 대상의 상황 칸은 대상 앞에 붙는 짧은 동작구("Looking at")다.
const ENGLISH_WORD_RANGE_OVERRIDE_MAP = {};

function getSlotList({ narrationType, subKind, origin = null, hasSecondClaim = false, language = CAPTION_LANGUAGE_MAP.ko }) {
  const slotList = readSlotList({ narrationType, subKind, origin, hasSecondClaim });
  if (!slotList || language !== CAPTION_LANGUAGE_MAP.en) return slotList;
  const isSilenceDescription = slotList === SILENCE_DESCRIPTION_SLOT_LIST;
  const labelMap = isSilenceDescription
    ? ENGLISH_SILENCE_DESCRIPTION_LABEL_MAP : (ENGLISH_SLOT_LABEL_MAP[narrationType]?.[subKind] || {});
  const overrideMap = isSilenceDescription ? {} : (ENGLISH_WORD_RANGE_OVERRIDE_MAP[narrationType]?.[subKind] || {});
  return slotList.map((slot) => ({
    ...slot,
    label: labelMap[slot.key] || slot.label,
    ...(overrideMap[slot.key] || scaleWordBudget({ minWordCount: slot.minWordCount, maxWordCount: slot.maxWordCount, language })),
  }));
}

function computeSlotTotal({ slotList }) {
  const outputSlotList = slotList.filter((slot) => !slot.isDiagnostic);
  return {
    minWordCount: outputSlotList.reduce((sum, slot) => sum + slot.minWordCount, 0),
    maxWordCount: outputSlotList.reduce((sum, slot) => sum + slot.maxWordCount, 0),
  };
}

function buildSlotInstruction({ slotList, language = CAPTION_LANGUAGE_MAP.ko }) {
  if (language === CAPTION_LANGUAGE_MAP.en) {
    return slotList
      .map((slot) => `  "${slot.key}": ${slot.label} — ${slot.minWordCount}–${slot.maxWordCount} words`
        + (slot.isDiagnostic ? ' (for the record — material for the final sentence)' : ''))
      .join('\n');
  }
  return slotList
    .map((slot) => `  "${slot.key}": ${slot.label} — ${slot.minWordCount}~${slot.maxWordCount}어절`
      + (slot.isDiagnostic ? ' (근거 기록용 — 최종 문장의 재료)' : ''))
    .join('\n');
}

// 영어 구가 끊긴 꼴로 끝나지 않게, 잘린 끝에 남은 관사·전치사·접속사를 뗀다.
const ENGLISH_DANGLING_WORD_SET = new Set([
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'with', 'for', 'in', 'on', 'at', 'by', 'from', 'as', 'into', 'than',
  'that', 'which', 'its', 'their', 'our', 'your', 'this', 'these', 'those', 'is', 'are', 'was', 'were',
]);

// 상한에서 자른 영어 구는 뒤쪽 절반에 쉼표가 있으면 그 마지막 쉼표에서 끊는다("…, and reduced" 처럼 말이 중간에 끊기지 않게).
function cutAtLastClauseComma({ text }) {
  const wordList = String(text || '').trim().split(/\s+/).filter(Boolean);
  for (let index = wordList.length - 2; index >= Math.floor(wordList.length / 2); index -= 1) {
    if (wordList[index].endsWith(',')) return wordList.slice(0, index + 1).join(' ');
  }
  return wordList.join(' ');
}

function trimEnglishDanglingTail({ text }) {
  const wordList = cutAtLastClauseComma({ text }).split(/\s+/).filter(Boolean);
  while (wordList.length > 1) {
    const last = wordList[wordList.length - 1].replace(TRAILING_MARK_PATTERN, '');
    if (!last || ENGLISH_DANGLING_WORD_SET.has(last.toLowerCase())) {
      wordList.pop(); continue;
    }
    wordList[wordList.length - 1] = last;
    break;
  }
  return wordList.join(' ').replace(TRAILING_MARK_PATTERN, '');
}

// 영어는 조사가 낱말로 떨어져 나와(관사·전치사) 한국어 어절보다 단어가 많다. 한국어 자료 명사 판정 대신
// 상한 + 허용치(SLOT_OVERAGE_TOLERANCE_WORD_COUNT)까지는 그대로 두고, 넘으면 그 길이에서 자른 뒤 끊긴 끝만 뗀다.
function normalizeEnglishSlotMap({ slotList, rawSlotMap }) {
  const slotMap = {};
  for (const slot of slotList) {
    const raw = rawSlotMap?.[slot.key];
    const text = typeof raw === 'string' ? raw : '';
    const wordLimit = slot.maxWordCount + SLOT_OVERAGE_TOLERANCE_WORD_COUNT;
    const truncated = truncateSlot({ text, maxWordCount: wordLimit });
    if (countWord({ text }) > wordLimit) {
      slotMap[slot.key] = trimEnglishDanglingTail({
        text: slot.mustContainValue ? dropValuelessTailItem({ text: truncated }) : truncated,
      });
    }
    else if (slot.tailNounList) slotMap[slot.key] = truncated.replace(TRAILING_PUNCTUATION_PATTERN, '');
    else if (slot.isPhrase) slotMap[slot.key] = truncated.replace(TRAILING_MARK_PATTERN, '');
    else slotMap[slot.key] = truncated;
  }
  return slotMap;
}

function isWithinEnglishSlotLimit({ text, maxWordCount }) {
  return countWord({ text }) <= maxWordCount + SLOT_OVERAGE_TOLERANCE_WORD_COUNT;
}

function normalizeSlotMap({ slotList, rawSlotMap, language = CAPTION_LANGUAGE_MAP.ko }) {
  if (language === CAPTION_LANGUAGE_MAP.en) return normalizeEnglishSlotMap({ slotList, rawSlotMap });
  const slotMap = {};
  for (const slot of slotList) {
    const raw = rawSlotMap?.[slot.key];
    const text = typeof raw === 'string' ? raw : '';
    if (slot.tailNounList
      && countWord({ text }) <= slot.maxWordCount + SLOT_OVERAGE_TOLERANCE_WORD_COUNT
      && hasCompleteTailNoun({ text, tailNounList: slot.tailNounList })) {
      slotMap[slot.key] = String(text).trim().replace(TRAILING_PUNCTUATION_PATTERN, '');
      continue;
    }
    const nounCut = slot.tailNounList ? cutAtTailNoun({
      text, maxWordCount: slot.maxWordCount, minWordCount: slot.minWordCount, tailNounList: slot.tailNounList,
    }) : null;
    if (nounCut) {
      slotMap[slot.key] = nounCut;
      continue;
    }
    const isWholeSentenceKept = slot.isWholeSentence
      && countWord({ text }) <= slot.maxWordCount + SLOT_OVERAGE_TOLERANCE_WORD_COUNT;
    if (isWholeSentenceKept) {
      slotMap[slot.key] = truncateSlot({ text, maxWordCount: slot.maxWordCount + SLOT_OVERAGE_TOLERANCE_WORD_COUNT });
      continue;
    }
    const truncated = truncateSlot({ text, maxWordCount: slot.maxWordCount });
    const isTruncated = countWord({ text }) > slot.maxWordCount;
    if (isTruncated) {
      slotMap[slot.key] = trimToCompletePhrase({
        text: slot.mustContainValue ? fitWholeItemList({ text, maxWordCount: slot.maxWordCount }) : truncated,
      });
    }
    else if (slot.isPhrase) slotMap[slot.key] = trimToCompletePhrase({ text: truncated, isConservative: true });
    else slotMap[slot.key] = truncated;
  }
  return slotMap;
}

// 값 목록("A 9.2시간에서 3.1시간, 고객 만족도 72점…")이 어절 수에서 잘리면 마지막 항목이 "고객"처럼
// 이름만 남는다. 쉼표 뒤 조각에 수치가 없으면 그 조각을 버린다.
// 숫자 안의 쉼표("3,000개", "1,325원")에서 나누면 "3, 000개"처럼 값이 깨진다. 쉼표 뒤 띄어쓰기나 숫자 아닌 이웃이 있을 때만 항목 경계로 본다.
const ITEM_SEPARATOR_PATTERN = /\s*,\s+|(?<!\d)\s*,\s*|\s*,\s*(?!\d)/;

function dropValuelessTailItem({ text }) {
  const itemList = String(text || '').split(ITEM_SEPARATOR_PATTERN);
  while (itemList.length > 1 && !hasValueToken({ text: itemList[itemList.length - 1] })) itemList.pop();
  return itemList.join(', ');
}

// 값 목록을 어절 상한에 맞출 때는 쉼표로 나뉜 항목을 통째로 넣거나 뺀다. 항목 가운데에서 자르면
// "…, 15분"처럼 조건 이름만 남고, 그 이름에 숫자가 들어 있어 완결된 항목처럼 보이기 때문이다.
// 첫 항목부터 상한을 넘으면 어절에서 자르는 예전 방식으로 둔다.
function fitWholeItemList({ text, maxWordCount }) {
  const rawItemList = String(text || '').split(ITEM_SEPARATOR_PATTERN).map((item) => item.trim()).filter(Boolean);
  const itemList = countWord({ text: rawItemList.join(', ') }) > maxWordCount ? dropRepeatedItemWord({ itemList: rawItemList }) : rawItemList;
  const keptList = [];
  for (const item of itemList) {
    if (countWord({ text: [...keptList, item].join(', ') }) > maxWordCount) break;
    keptList.push(item);
  }
  if (!keptList.length) return dropValuelessTailItem({ text: truncateSlot({ text, maxWordCount }) });
  return dropValuelessTailItem({ text: keptList.join(', ') });
}

// 값 항목마다 되풀이된 낱말("10분 스텝퍼 71, 15분 스텝퍼 53")을 뺀다. 낱말을 빼서 항목에 숫자만 남으면 그 항목은 그대로 둔다
// (조건 이름이 사라지면 대응이 깨진다).
function dropRepeatedItemWord({ itemList }) {
  if (itemList.length < 2) return itemList;
  const wordListList = itemList.map((item) => item.split(/\s+/));
  const needCount = itemList.length >= 3 ? itemList.length - 1 : itemList.length;
  const countMap = new Map();
  for (const wordList of wordListList) {
    for (const word of new Set(wordList.filter((item) => !/\d/.test(item)))) countMap.set(word, (countMap.get(word) || 0) + 1);
  }
  const repeatedSet = new Set([...countMap].filter(([, count]) => count >= needCount).map(([word]) => word));
  if (!repeatedSet.size) return itemList;
  return wordListList.map((wordList) => {
    const kept = wordList.filter((word) => !repeatedSet.has(word));
    return kept.some((word) => !/^[+\-−]?\d[\d.,]*$/.test(word)) ? kept.join(' ') : wordList.join(' ');
  });
}

// 대상 칸에 조건 이름 목록("공복 운동 후 혈당 수치, 식사 후 혈당 수치")을, 값 칸에 이름 없는 값 목록("76, 202")을 따로 쓰면
// 대상 칸이 상한에서 잘려 둘째 조건이 빠지고 202가 첫 조건의 값처럼 읽힌다. 항목 수가 같으면 순서대로 짝지어 값 칸으로 옮기고,
// 항목 이름의 같은 끝말("혈당 수치")은 대상 칸에 한 번만 둔다. 칸 상한을 적용하기 전(원 답 칸)에 한다.
const BARE_VALUE_ITEM_PATTERN = /^(?:약\s*|about\s+)?[+\-−]?\d[\d.,]*\s*(?:%|퍼센트|[A-Za-z/]+|원|명|건|개|번|회|배|분|초|시간|일|년|도|점|위|세|℃)?$/;
const PAIR_FUNCTION_WORD_SET = new Set(['후', '전', '때', '중', '뒤', '동안', '이후', '이전', '당시', '시', 'after', 'before', 'during']);

function pairTargetItemListWithValueList({ target, value }) {
  const targetItemList = String(target || '').split(ITEM_SEPARATOR_PATTERN).map((item) => item.trim()).filter(Boolean);
  const valueItemList = String(value || '').split(ITEM_SEPARATOR_PATTERN).map((item) => item.trim()).filter(Boolean);
  if (targetItemList.length < 2 || targetItemList.length !== valueItemList.length) return null;
  if (!valueItemList.every((item) => BARE_VALUE_ITEM_PATTERN.test(item))) return null;
  const wordListList = targetItemList.map((item) => item.split(/\s+/));
  let commonCount = 0;
  while (wordListList.every((wordList) => wordList.length > commonCount + 1
    && wordList[wordList.length - 1 - commonCount] === wordListList[0][wordListList[0].length - 1 - commonCount])
    && !PAIR_FUNCTION_WORD_SET.has(wordListList[0][wordListList[0].length - 1 - commonCount])) commonCount += 1;
  // 같은 끝말(측정량 낱말)이 없으면 대상 칸이 비므로 짝짓지 않는다.
  if (!commonCount) return null;
  const commonTail = wordListList[0].slice(-commonCount).join(' ');
  const pairList = wordListList.map((wordList, index) => `${wordList.slice(0, wordList.length - commonCount).join(' ')} ${valueItemList[index]}`);
  return { target: commonTail, value: pairList.join(', ') };
}

// 조립한 해설이 전체 어절·글자 예산을 넘으면 정보가 적은 쪽부터 줄인다: ① 값 항목마다 되풀이된 낱말을 빼고
// ② 대상 칸 앞쪽 꾸밈말을 빼되 끝의 측정량 낱말은 남기고(최소 2어절) ③ 그래도 넘치면 값 목록 뒤 항목부터 통째로 뺀다.
// 정상 JSON 경로에는 그동안 칸별 상한만 있고 전체 예산은 적용되지 않았다.
const MIN_TARGET_WORD_COUNT = 2;

function fitClaimPairToBudget({ target, value, maxWordCount, maxChars, language = CAPTION_LANGUAGE_MAP.ko }) {
  const isOver = (text) => (Number.isFinite(maxWordCount) && countWord({ text }) > maxWordCount)
    || (Number.isFinite(maxChars) && text.length > maxChars);
  let itemList = String(value || '').split(ITEM_SEPARATOR_PATTERN).filter(Boolean);
  let targetWordList = String(target || '').split(/\s+/).filter(Boolean);
  const build = () => assembleClaimPair({
    target: targetWordList.join(' '), value: dropValuelessTailItem({ text: itemList.join(', ') }), language,
  });
  let fitted = build();
  if (isOver(fitted)) { itemList = dropRepeatedItemWord({ itemList }); fitted = build(); }
  while (isOver(fitted) && targetWordList.length > MIN_TARGET_WORD_COUNT) { targetWordList = targetWordList.slice(1); fitted = build(); }
  while (isOver(fitted) && itemList.length > 1) { itemList.pop(); fitted = build(); }
  return fitted;
}

// 끝 문장부호("…막대 그래프.")는 떼고 본다. 붙은 채 보면 받을 수 있는 길이의 묘사도 미완결로 버려진다.
function hasCompleteTailNoun({ text, tailNounList = DESCRIPTION_TAIL_NOUN_LIST }) {
  const last = String(text || '').trim().replace(TRAILING_PUNCTUATION_PATTERN, '').split(/\s+/).pop() || '';
  return endsWithTailNoun({ word: last, tailNounList });
}

function hasInvalidTailSlot({ slotList, slotMap }) {
  return slotList.some((slot) => slot.tailNounList
    && !hasCompleteTailNoun({ text: slotMap[slot.key], tailNounList: slot.tailNounList }));
}

const VALUE_TOKEN_PATTERN = /\d|[일이삼사오육칠팔구십백천만억]\s*(?:%|퍼센트|배|위|개|명|건|원|년|세|단계|점|초|분|시간)/;

function hasValueToken({ text }) {
  return VALUE_TOKEN_PATTERN.test(String(text || ''));
}

function hasValuelessSlot({ slotList, slotMap }) {
  return slotList.some((slot) => slot.mustContainValue
    && !hasValueToken({ text: slotMap[slot.key] }));
}

const CONNECTIVE_ENDING_LIST = ['며', '고', '서', '면서', '거나', '지만', '는데', '어서', '아서'];
const SITUATION_FALLBACK_TAIL = '설명함';
// 가리켰다는 사실은 청자에게 정보가 아니다(지시 프롬프트 규칙 5). 모사할 동사가 없을 때 쓰는 "확인 중"으로 둔다.
const POINTING_SITUATION_PATTERN = /가리키|가리킴|가리켜/;
const POINTING_SITUATION_REPLACEMENT = '확인 중';
// "보시면"을 높임말 그대로("보시는 중")나 피동("보이는 중")으로 옮기거나 "보며 설명함"으로 쓰면 어색하다. 청자 쪽 동작 "보는 중"으로 맞춘다.
const LOOKING_SITUATION_PATTERN = /^(?:보시는 중|보이는 중|보며 설명함|보시며 설명함)$/;
const LOOKING_SITUATION_REPLACEMENT = '보는 중';

function completeSituationSlot({ situation }) {
  const text = String(situation || '').trim();
  if (!text) return text;
  if (POINTING_SITUATION_PATTERN.test(text)) return POINTING_SITUATION_REPLACEMENT;
  if (LOOKING_SITUATION_PATTERN.test(text)) return LOOKING_SITUATION_REPLACEMENT;
  const last = text.split(/\s+/).pop();
  const isConnective = CONNECTIVE_ENDING_LIST.some((ending) => last.endsWith(ending));
  return isConnective ? `${text} ${SITUATION_FALLBACK_TAIL}` : text;
}

function dropRepeatedWordAtSeam({ text }) {
  const wordList = String(text || '').split(' ');
  const keptList = wordList.filter((word, index) => index === 0 || word !== wordList[index - 1]);
  return keptList.join(' ');
}

// 대상 칸 이름이 값 칸에 모두 나오면("RSU, WAVE 단말기" + "RSU 79개, WAVE 단말기 3,000개") 이름이 두 번 읽힌다.
// 이름은 낱말 첫머리에서 나와야 같은 것으로 본다("시간"은 "9.2시간"에 든 것이 아니다).
const TARGET_ITEM_SEPARATOR = /\s*[,·]\s*|\s+및\s+/;
// 영어 값은 대소문자가 섞여 나온다("Developers" ↔ "120 developers"). 소문자로 맞춰 견준다.
const ENGLISH_TARGET_ITEM_SEPARATOR = /\s*[,·]\s*|\s+and\s+/i;

function isTargetRepeatedInValue({ target, value, language = CAPTION_LANGUAGE_MAP.ko }) {
  const isEnglish = language === CAPTION_LANGUAGE_MAP.en;
  const separator = isEnglish ? ENGLISH_TARGET_ITEM_SEPARATOR : TARGET_ITEM_SEPARATOR;
  const toComparable = (text) => (isEnglish ? String(text || '').toLowerCase() : String(text || ''));
  const itemList = toComparable(target).split(separator).map((item) => item.trim()).filter(Boolean);
  const spacedValue = ` ${toComparable(value)}`;
  return itemList.length > 0 && itemList.every((item) => spacedValue.includes(` ${item}`));
}

function assembleClaimPair({ target, value, language = CAPTION_LANGUAGE_MAP.ko }) {
  return isTargetRepeatedInValue({ target, value, language }) ? value : `${target}, ${value}`;
}

// 둘째 쌍은 대상과 수치가 다 있을 때만 붙이고, 두 쌍이 어절 예산을 넘으면 첫 쌍만 읽는다.
function assembleClaimToValue({ slotMap, maxWordCount, maxChars, language = CAPTION_LANGUAGE_MAP.ko }) {
  const first = fitClaimPairToBudget({ target: slotMap.target, value: slotMap.value, maxWordCount, maxChars, language });
  if (!slotMap.target2 || !hasValueToken({ text: slotMap.value2 })) return first;
  const both = `${first}. ${assembleClaimPair({ target: slotMap.target2, value: slotMap.value2, language })}`;
  return Number.isFinite(maxWordCount) && countWord({ text: both }) > maxWordCount ? first : both;
}

function hasEmptyRequiredSlot({ slotList, slotMap }) {
  return slotList.some((slot) => {
    if (slot.isDiagnostic || slot.minWordCount <= 0) return false;
    if (slot.tailNounList) return countWord({ text: slotMap[slot.key] }) < slot.minWordCount;
    return !slotMap[slot.key];
  });
}

const NARRATION_ASSEMBLE_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: {
    [PAGE_TRANSITION_KIND_MAP.slide]: ({ slotMap, index }) => (
      `슬라이드 ${index}: ${slotMap.description}`
    ),
    [PAGE_TRANSITION_KIND_MAP.document]: ({ slotMap }) => `페이지: ${slotMap.description}`,
  },
  [NARRATION_TYPE_MAP.deixis]: {
    [DEIXIS_FORM_MAP.simple]: ({ slotMap }) => slotMap.caption,
    [DEIXIS_FORM_MAP.complete]: ({ slotMap }) => slotMap.caption,
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: ({ slotMap }) => (
      `${attachJosa({ text: slotMap.value, withFinal: '은', withoutFinal: '는' })} `
      + `${attachJosa({ text: slotMap.frame, withFinal: '을', withoutFinal: '를' })} 의미`
    ),
    [INTERPRETATION_KIND_MAP.claimToValue]: assembleClaimToValue,
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: ({ slotMap }) => (
      `이미지 제시, ${String(slotMap.description || '').replace(/^\s*이미지 제시\s*,?\s*/, '')}`
    ),
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: ({ slotMap }) => slotMap.caption,
  },
  [NARRATION_TYPE_MAP.speakerIdentity]: {
    [SPEAKER_IDENTITY_KIND_MAP.named]: ({ slotMap }) => `${slotMap.speakerName}님이 말합니다`,
    [SPEAKER_IDENTITY_KIND_MAP.positional]: ({ slotMap }) => `${slotMap.position} 참가자가 말합니다`,
  },
};

// 영어 캡션의 조립 틀. 고정 문구(머리말·연결어)는 시스템이 붙이고, 칸에는 화면에서 읽은 구만 들어간다.
// 모델이 형식 예시를 흉내 내 머리말("Image:")을 직접 쓰면 떼고 붙인다.
const ENGLISH_IMAGE_PREFIX_PATTERN = /^\s*image\s*(?:presented|shown)?\s*[:,]\s*/i;
const ENGLISH_LEADING_ARTICLE_PATTERN = /^the\s+/i;

const ENGLISH_NARRATION_ASSEMBLE_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: {
    [PAGE_TRANSITION_KIND_MAP.slide]: ({ slotMap, index }) => `Slide ${index}: ${slotMap.description}`,
    [PAGE_TRANSITION_KIND_MAP.document]: ({ slotMap }) => `Page: ${slotMap.description}`,
  },
  [NARRATION_TYPE_MAP.deixis]: {
    [DEIXIS_FORM_MAP.simple]: ({ slotMap }) => slotMap.caption,
    [DEIXIS_FORM_MAP.complete]: ({ slotMap }) => slotMap.caption,
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: ({ slotMap }) => `${slotMap.value} means ${slotMap.frame}`,
    [INTERPRETATION_KIND_MAP.claimToValue]: ({ slotMap, maxWordCount, maxChars }) => assembleClaimToValue({
      slotMap, maxWordCount, maxChars, language: CAPTION_LANGUAGE_MAP.en,
    }),
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: ({ slotMap }) => (
      `Image: ${String(slotMap.description || '').replace(ENGLISH_IMAGE_PREFIX_PATTERN, '')}`
    ),
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: ({ slotMap }) => slotMap.caption,
  },
  [NARRATION_TYPE_MAP.speakerIdentity]: {
    [SPEAKER_IDENTITY_KIND_MAP.named]: ({ slotMap }) => `${slotMap.speakerName} is speaking`,
    [SPEAKER_IDENTITY_KIND_MAP.positional]: ({ slotMap }) => (
      `The participant at the ${String(slotMap.position || '').replace(ENGLISH_LEADING_ARTICLE_PATTERN, '')} is speaking`
    ),
  },
};

function capitalizeFirst(text) {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

// 한국어 끝맺음 검사(자료 명사·조사·관형형)와 상황 칸 보정은 영어에 맞지 않아 쓰지 않는다. 빈 칸·수치 검사는 같다.
function assembleEnglishNarration({ narrationType, subKind, rawSlotMap, index, origin, hasSecondClaim, maxWordCount, maxChars }) {
  const slotList = getSlotList({ narrationType, subKind, origin, hasSecondClaim, language: CAPTION_LANGUAGE_MAP.en });
  const assemble = ENGLISH_NARRATION_ASSEMBLE_MAP[narrationType]?.[subKind];
  if (!slotList || !assemble) return null;
  const slotMap = normalizeEnglishSlotMap({ slotList, rawSlotMap: pairClaimSlot({ narrationType, subKind, rawSlotMap }) });
  if (hasEmptyRequiredSlot({ slotList, slotMap })) return null;
  if (hasValuelessSlot({ slotList, slotMap })) return null;
  const joined = assemble({ slotMap, index, maxWordCount, maxChars }).replace(/\s+/g, ' ').trim();
  return { text: capitalizeFirst(dropRepeatedWordAtSeam({ text: joined })), slotMap };
}

// 주장→값은 대상 칸의 조건 목록과 값 칸의 이름 없는 값 목록을 짝지어 둔다(pairTargetItemListWithValueList).
function pairClaimSlot({ narrationType, subKind, rawSlotMap }) {
  const isClaim = narrationType === NARRATION_TYPE_MAP.interpretation && subKind === INTERPRETATION_KIND_MAP.claimToValue;
  const paired = isClaim ? pairTargetItemListWithValueList({ target: rawSlotMap?.target, value: rawSlotMap?.value }) : null;
  return paired ? { ...rawSlotMap, ...paired } : rawSlotMap;
}

function assembleNarration({ narrationType, subKind, rawSlotMap, index = '', origin = null,
  hasSecondClaim = false, maxWordCount = null, maxChars = null, language = CAPTION_LANGUAGE_MAP.ko }) {
  if (language === CAPTION_LANGUAGE_MAP.en) {
    return assembleEnglishNarration({
      narrationType, subKind, rawSlotMap, index, origin, hasSecondClaim, maxWordCount, maxChars,
    });
  }
  const slotList = getSlotList({ narrationType, subKind, origin, hasSecondClaim });
  const assemble = NARRATION_ASSEMBLE_MAP[narrationType]?.[subKind];
  if (!slotList || !assemble) return null;
  const slotMap = normalizeSlotMap({ slotList, rawSlotMap: pairClaimSlot({ narrationType, subKind, rawSlotMap }) });
  if (slotMap.situation) slotMap.situation = completeSituationSlot({ situation: slotMap.situation });
  if (hasEmptyRequiredSlot({ slotList, slotMap })) return null;
  if (hasValuelessSlot({ slotList, slotMap })) return null;
  if (hasInvalidTailSlot({ slotList, slotMap })) return null;
  const joined = assemble({ slotMap, index, maxWordCount, maxChars }).replace(/\s+/g, ' ').trim();
  return { text: dropRepeatedWordAtSeam({ text: joined }), slotMap };
}

module.exports = {
  NARRATION_SLOT_MAP, getSlotList, computeSlotTotal, buildSlotInstruction, DESCRIPTION_TAIL_NOUN_LIST, hasCompleteTailNoun,
  cutAtTailNoun,
  normalizeSlotMap, pairTargetItemListWithValueList, hasEmptyRequiredSlot, hasValuelessSlot, hasValueToken, assembleNarration, countWord, truncateSlot,
  trimToCompletePhrase, hasFinalConsonant, attachJosa, isWithinEnglishSlotLimit, SLOT_OVERAGE_TOLERANCE_WORD_COUNT,
  scaleWordBudget, ENGLISH_WORD_SCALE, trimEnglishDanglingTail,
};
