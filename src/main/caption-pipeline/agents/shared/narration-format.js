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

function stripTailParticle(word) {
  const particle = TAIL_PARTICLE_LIST.find((candidate) => word.length > candidate.length && word.endsWith(candidate));
  return particle ? word.slice(0, -particle.length) : word;
}

// VLM 이 상한을 넘겨 쓰거나 자료 명사로 맺지 못한 묘사를, 상한 안에서 자료 명사로 끝나는 가장 긴 지점까지 자른다.
// 그 지점의 조사는 뗀다("…설명한 본문과" → "…설명한 본문"). 하한보다 짧아지면 null 이다.
function cutAtTailNoun({ text, maxWordCount, minWordCount, tailNounList = DESCRIPTION_TAIL_NOUN_LIST }) {
  const wordList = String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, maxWordCount);
  const endsWithTailNoun = (word) => tailNounList.some((noun) => word.endsWith(noun));
  for (let lastIndex = wordList.length - 1; lastIndex >= minWordCount - 1; lastIndex -= 1) {
    const word = wordList[lastIndex].replace(TRAILING_MARK_PATTERN, '');
    const candidate = endsWithTailNoun(word) ? word : stripTailParticle(word);
    if (endsWithTailNoun(candidate)) return [...wordList.slice(0, lastIndex), candidate].join(' ');
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
    if (!last || INCOMPLETE_WORD_SET.has(last)
      || tailPattern.test(last) || INCOMPLETE_SUFFIX_PATTERN.test(last)) {
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
    [DEIXIS_FORM_MAP.simple]: [
      { key: 'target', label: '지시대상 묘사/내용 — 자료 종류(표·사진 등)까지 포함 (예: 2년간 매출 추이 표를)', minWordCount: 2, maxWordCount: 5, isPhrase: true },
      { key: 'situation', label: "상황 묘사 — 발화 모사 ('보는 중', '주목' 등)", minWordCount: 2, maxWordCount: 2 },
    ],
    [DEIXIS_FORM_MAP.complete]: [
      { key: 'mimicry', label: '발화 모사 — 기존 발화의 표현·어휘', minWordCount: 2, maxWordCount: 3, isDiagnostic: true },
      { key: 'target', label: '지시대상 — 간략한 주제를 덧붙여', minWordCount: 1, maxWordCount: 2, isDiagnostic: true, isPhrase: true },
      { key: 'explanation', label: '설명 — 묘사/설명·대상 사이의 관계성', minWordCount: 3, maxWordCount: 5, isDiagnostic: true, isPhrase: true },
      {
        key: 'sentence',
        label: '위 세 요소(발화 모사 + 지시대상 + 설명)를 **모두 포함**하는 자연스러운 한 문장'
          + ' (순서는 자연스럽게 바꿔도 된다)',
        minWordCount: 6,
        maxWordCount: 10,
      },
    ],
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: [
      { key: 'value', label: '발화에 나온 단순 수치 (예: 73%)', minWordCount: 1, maxWordCount: 2, mustContainValue: true },
      { key: 'frame', label: '값의 해석틀 — 화면에서 찾은 대상·기준 (예: 작년 대비 A사 기업가치 성장률)', minWordCount: 3, maxWordCount: 5, isPhrase: true },
    ],
    // 발화 표현을 칸에 넣으면 "…빨라졌습니다를 의미"처럼 발화가 그대로 붙는다. 대상과 근거 값만 화면에서 읽는다.
    [INTERPRETATION_KIND_MAP.claimToValue]: [
      { key: 'target', label: '변화·비교의 대상 — 화면에 적힌 항목 이름. 발표자가 여러 항목을 묶어 부른 말이면 그 묶음 이름 (예: 첫 응답 시간, 4분기 매출, 인력)', minWordCount: 1, maxWordCount: 4, isPhrase: true },
      { key: 'value', label: '화면에서 찾은 근거 값 — 반드시 수치. 변화면 바뀌기 전 값에서 바뀐 뒤 값(바뀐 뒤 값만 있으면 그 값), 비교면 두 대상과 각 값, 묶음 이름이면 항목 2개까지 각 이름과 값 (예: 9.2시간에서 3.1시간, 도심 33.8도 교외 29.1도, 개발자 120명과 디자이너 30명)', minWordCount: 1, maxWordCount: 6, mustContainValue: true },
    ],
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: [
      // 무발화 묘사는 값·변화를 담아 "…그래프"로 끝맺는다. 5어절에서 자르면 자료 종류 꼬리가 빠져 묘사가 버려진다.
      { key: 'description', label: '이미지에 대한 묘사 (반응을 일으키는 요소 포함)', minWordCount: 3, maxWordCount: 8, isPhrase: true },
    ],
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: [
      { key: 'comparison', label: '비교 대상 (화면 속 다른 객체, 예: 소나무)', minWordCount: 1, maxWordCount: 2 },
      {
        key: 'scale',
        label: '비교 척도 — 숫자만 (예: 4). **숫자로 가늠할 수 없으면 빈 문자열**',
        minWordCount: 0,
        maxWordCount: 1,
      },
      { key: 'direction', label: '방향 — "큰" 또는 "작은" 중 하나', minWordCount: 1, maxWordCount: 1 },
      { key: 'target', label: '그 대상 (예: 불상)', minWordCount: 1, maxWordCount: 1, isPhrase: true },
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
  },
];

// 한 발화에 변화를 두 번 말했으면(hasSecondClaim) 둘째 대상·값 칸을 더한다. 같은 대상이면 비워 두고 첫 쌍만 읽는다.
const CLAIM_PAIR_VALUE_MAX_WORD_COUNT = 10;
const CLAIM_SECOND_PAIR_SLOT_LIST = [
  { key: 'target2', label: '발표자가 또 말한 변화의 대상 — 첫 대상과 다를 때만. 같거나 없으면 빈 문자열', minWordCount: 0, maxWordCount: 4, isPhrase: true },
  { key: 'value2', label: '그 대상의 근거 값 — 반드시 수치. 같거나 없으면 빈 문자열', minWordCount: 0, maxWordCount: 5 },
];

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
    [DEIXIS_FORM_MAP.simple]: {
      target: 'the referenced item and its content, including the material type (e.g. "the two-year sales trend table")',
      situation: 'short lead-in action phrase that mimics the speaker\'s verb and is read right before the target'
        + ' (e.g. "Looking at", "Focusing on", "Comparing")',
    },
    [DEIXIS_FORM_MAP.complete]: {
      mimicry: 'speaker mimicry — wording taken from the utterance',
      target: 'the referenced item — with a brief topic',
      explanation: 'explanation — what it shows or how it relates to the item',
      sentence: 'one natural sentence that **includes all three** of the above (mimicry + item + explanation)'
        + ' (the order may change)',
    },
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
      comparison: 'comparison object (another object on screen, e.g. the pine tree)',
      scale: 'scale — number only (e.g. 4). **Empty string if it cannot be estimated as a number**',
      direction: 'direction — exactly "larger" or "smaller"',
      target: 'the item itself (e.g. the Buddha statue)',
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

// 영어는 관사·전치사 때문에 같은 내용도 한국어 어절보다 단어가 많다. 영어 한 단어는 한국어 한 어절보다 짧게 읽히므로
// 상한을 어절의 1.5배로 잡으면 들리는 길이가 비슷하다(9어절 상한에서는 영어 전환 묘사의 절반 가까이가 길어 버려졌다).
// 하한은 그대로 둔다 — 영어가 한국어보다 단어가 적을 일은 드물고, 올리면 짧고 온전한 영어 구가 빈 칸으로 버려진다.
const ENGLISH_WORD_SCALE = 1.5;

function scaleMaxWordCount({ count, language }) {
  if (language !== CAPTION_LANGUAGE_MAP.en || !Number.isFinite(count) || count <= 0) return count;
  return Math.ceil(count * ENGLISH_WORD_SCALE);
}

// 렌더러가 모드별로 정한 어절 예산을 캡션 언어의 단어 수로 바꾼다. 한국어는 그대로다.
function scaleWordBudget({ minWordCount, maxWordCount, language }) {
  return { minWordCount, maxWordCount: scaleMaxWordCount({ count: maxWordCount, language }) };
}

// 영어 칸 가운데 어절 수를 그대로 옮기면 안 되는 칸. 지시 대상의 상황 칸은 대상 앞에 붙는 짧은 동작구("Looking at")다.
const ENGLISH_WORD_RANGE_OVERRIDE_MAP = {
  [NARRATION_TYPE_MAP.deixis]: { [DEIXIS_FORM_MAP.simple]: { situation: { minWordCount: 1, maxWordCount: 3 } } },
};

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
    const truncated = truncateSlot({ text, maxWordCount: slot.maxWordCount });
    const isTruncated = countWord({ text }) > slot.maxWordCount;
    if (isTruncated) {
      slotMap[slot.key] = trimToCompletePhrase({
        text: slot.mustContainValue ? dropValuelessTailItem({ text: truncated }) : truncated,
      });
    }
    else if (slot.isPhrase) slotMap[slot.key] = trimToCompletePhrase({ text: truncated, isConservative: true });
    else slotMap[slot.key] = truncated;
  }
  return slotMap;
}

// 값 목록("A 9.2시간에서 3.1시간, 고객 만족도 72점…")이 어절 수에서 잘리면 마지막 항목이 "고객"처럼
// 이름만 남는다. 쉼표 뒤 조각에 수치가 없으면 그 조각을 버린다.
function dropValuelessTailItem({ text }) {
  const itemList = String(text || '').split(/\s*,\s*/);
  while (itemList.length > 1 && !hasValueToken({ text: itemList[itemList.length - 1] })) itemList.pop();
  return itemList.join(', ');
}

// 끝 문장부호("…막대 그래프.")는 떼고 본다. 붙은 채 보면 받을 수 있는 길이의 묘사도 미완결로 버려진다.
function hasCompleteTailNoun({ text, tailNounList = DESCRIPTION_TAIL_NOUN_LIST }) {
  const last = String(text || '').trim().replace(TRAILING_PUNCTUATION_PATTERN, '').split(/\s+/).pop() || '';
  return tailNounList.some((noun) => last.endsWith(noun));
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

function completeSituationSlot({ situation }) {
  const text = String(situation || '').trim();
  if (!text) return text;
  if (POINTING_SITUATION_PATTERN.test(text)) return POINTING_SITUATION_REPLACEMENT;
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
function assembleClaimToValue({ slotMap, maxWordCount, language = CAPTION_LANGUAGE_MAP.ko }) {
  const first = assembleClaimPair({ target: slotMap.target, value: slotMap.value, language });
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
    [DEIXIS_FORM_MAP.simple]: ({ slotMap }) => (
      `${slotMap.target} ${slotMap.situation}`
    ),
    [DEIXIS_FORM_MAP.complete]: ({ slotMap }) => slotMap.sentence,
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
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: ({ slotMap }) => (slotMap.scale
      ? `${slotMap.comparison}보다 ${slotMap.scale}배 ${slotMap.direction} ${slotMap.target}`
      : `${slotMap.comparison}보다 ${slotMap.direction} ${slotMap.target}`),
  },
  [NARRATION_TYPE_MAP.speakerIdentity]: {
    [SPEAKER_IDENTITY_KIND_MAP.named]: ({ slotMap }) => `${slotMap.speakerName}님이 말합니다`,
    [SPEAKER_IDENTITY_KIND_MAP.positional]: ({ slotMap }) => `${slotMap.position} 참가자가 말합니다`,
  },
};

// 영어 캡션의 조립 틀. 고정 문구(머리말·연결어)는 시스템이 붙이고, 칸에는 화면에서 읽은 구만 들어간다.
// 모델이 형식 예시를 흉내 내 머리말("Image:")을 직접 쓰면 떼고 붙인다.
const ENGLISH_IMAGE_PREFIX_PATTERN = /^\s*image\s*(?:presented|shown)?\s*[:,]\s*/i;
const ENGLISH_SCALE_SUFFIX_PATTERN = /\s*(?:x|times)$/i;
const ENGLISH_LEADING_ARTICLE_PATTERN = /^the\s+/i;

const ENGLISH_NARRATION_ASSEMBLE_MAP = {
  [NARRATION_TYPE_MAP.pageTransition]: {
    [PAGE_TRANSITION_KIND_MAP.slide]: ({ slotMap, index }) => `Slide ${index}: ${slotMap.description}`,
    [PAGE_TRANSITION_KIND_MAP.document]: ({ slotMap }) => `Page: ${slotMap.description}`,
  },
  [NARRATION_TYPE_MAP.deixis]: {
    [DEIXIS_FORM_MAP.simple]: ({ slotMap }) => `${slotMap.situation} ${slotMap.target}`,
    [DEIXIS_FORM_MAP.complete]: ({ slotMap }) => slotMap.sentence,
  },
  [NARRATION_TYPE_MAP.interpretation]: {
    [INTERPRETATION_KIND_MAP.valueToMeaning]: ({ slotMap }) => `${slotMap.value} means ${slotMap.frame}`,
    [INTERPRETATION_KIND_MAP.claimToValue]: ({ slotMap, maxWordCount }) => assembleClaimToValue({
      slotMap, maxWordCount, language: CAPTION_LANGUAGE_MAP.en,
    }),
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: ({ slotMap }) => (
      `Image: ${String(slotMap.description || '').replace(ENGLISH_IMAGE_PREFIX_PATTERN, '')}`
    ),
    [VISUAL_DESCRIPTION_KIND_MAP.scale]: ({ slotMap }) => {
      const scale = String(slotMap.scale || '').replace(ENGLISH_SCALE_SUFFIX_PATTERN, '');
      return scale
        ? `${slotMap.target}, ${scale} times ${slotMap.direction} than ${slotMap.comparison}`
        : `${slotMap.target}, ${slotMap.direction} than ${slotMap.comparison}`;
    },
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
function assembleEnglishNarration({ narrationType, subKind, rawSlotMap, index, origin, hasSecondClaim, maxWordCount }) {
  const slotList = getSlotList({ narrationType, subKind, origin, hasSecondClaim, language: CAPTION_LANGUAGE_MAP.en });
  const assemble = ENGLISH_NARRATION_ASSEMBLE_MAP[narrationType]?.[subKind];
  if (!slotList || !assemble) return null;
  const slotMap = normalizeEnglishSlotMap({ slotList, rawSlotMap });
  if (hasEmptyRequiredSlot({ slotList, slotMap })) return null;
  if (hasValuelessSlot({ slotList, slotMap })) return null;
  const joined = assemble({ slotMap, index, maxWordCount }).replace(/\s+/g, ' ').trim();
  return { text: capitalizeFirst(dropRepeatedWordAtSeam({ text: joined })), slotMap };
}

function assembleNarration({ narrationType, subKind, rawSlotMap, index = '', origin = null,
  hasSecondClaim = false, maxWordCount = null, language = CAPTION_LANGUAGE_MAP.ko }) {
  if (language === CAPTION_LANGUAGE_MAP.en) {
    return assembleEnglishNarration({
      narrationType, subKind, rawSlotMap, index, origin, hasSecondClaim, maxWordCount,
    });
  }
  const slotList = getSlotList({ narrationType, subKind, origin, hasSecondClaim });
  const assemble = NARRATION_ASSEMBLE_MAP[narrationType]?.[subKind];
  if (!slotList || !assemble) return null;
  const slotMap = normalizeSlotMap({ slotList, rawSlotMap });
  if (slotMap.situation) slotMap.situation = completeSituationSlot({ situation: slotMap.situation });
  if (hasEmptyRequiredSlot({ slotList, slotMap })) return null;
  if (hasValuelessSlot({ slotList, slotMap })) return null;
  if (hasInvalidTailSlot({ slotList, slotMap })) return null;
  const joined = assemble({ slotMap, index, maxWordCount }).replace(/\s+/g, ' ').trim();
  return { text: dropRepeatedWordAtSeam({ text: joined }), slotMap };
}

module.exports = {
  NARRATION_SLOT_MAP, getSlotList, computeSlotTotal, buildSlotInstruction, DESCRIPTION_TAIL_NOUN_LIST, hasCompleteTailNoun,
  cutAtTailNoun,
  normalizeSlotMap, hasEmptyRequiredSlot, hasValuelessSlot, hasValueToken, assembleNarration, countWord, truncateSlot,
  trimToCompletePhrase, hasFinalConsonant, attachJosa, isWithinEnglishSlotLimit, SLOT_OVERAGE_TOLERANCE_WORD_COUNT,
  scaleWordBudget, ENGLISH_WORD_SCALE,
};
