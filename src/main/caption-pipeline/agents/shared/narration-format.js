const {
  NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP, DEIXIS_FORM_MAP,
  INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP, SPEAKER_IDENTITY_KIND_MAP,
} = require('../../contracts/narration-types');

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
];

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
      { key: 'description', label: '묘사 (제목·주제)', minWordCount: 5, maxWordCount: 7, isPhrase: true, tailNounList: DESCRIPTION_TAIL_NOUN_LIST },
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
    [INTERPRETATION_KIND_MAP.claimToValue]: [
      { key: 'value', label: '화면에서 찾은 구체적 근거 값 — 반드시 수치 (예: 80%, 25세, 3단계)', minWordCount: 1, maxWordCount: 2, mustContainValue: true },
      { key: 'frame', label: '발화의 변화·비교·결론 표현', minWordCount: 3, maxWordCount: 5, isPhrase: true },
    ],
  },
  [NARRATION_TYPE_MAP.visualDescription]: {
    [VISUAL_DESCRIPTION_KIND_MAP.reaction]: [
      { key: 'description', label: '이미지에 대한 묘사 (반응을 일으키는 요소 포함)', minWordCount: 3, maxWordCount: 5, isPhrase: true },
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

function getSlotList({ narrationType, subKind }) {
  return NARRATION_SLOT_MAP[narrationType]?.[subKind] || null;
}

function computeSlotTotal({ slotList }) {
  const outputSlotList = slotList.filter((slot) => !slot.isDiagnostic);
  return {
    minWordCount: outputSlotList.reduce((sum, slot) => sum + slot.minWordCount, 0),
    maxWordCount: outputSlotList.reduce((sum, slot) => sum + slot.maxWordCount, 0),
  };
}

function buildSlotInstruction({ slotList }) {
  return slotList
    .map((slot) => `  "${slot.key}": ${slot.label} — ${slot.minWordCount}~${slot.maxWordCount}어절`
      + (slot.isDiagnostic ? ' (근거 기록용 — 최종 문장의 재료)' : ''))
    .join('\n');
}

function normalizeSlotMap({ slotList, rawSlotMap }) {
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
    const truncated = truncateSlot({ text, maxWordCount: slot.maxWordCount });
    const isTruncated = countWord({ text }) > slot.maxWordCount;
    if (isTruncated) slotMap[slot.key] = trimToCompletePhrase({ text: truncated });
    else if (slot.isPhrase) slotMap[slot.key] = trimToCompletePhrase({ text: truncated, isConservative: true });
    else slotMap[slot.key] = truncated;
  }
  return slotMap;
}

function hasCompleteTailNoun({ text, tailNounList = DESCRIPTION_TAIL_NOUN_LIST }) {
  const last = String(text || '').trim().split(/\s+/).pop() || '';
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

function completeSituationSlot({ situation }) {
  const text = String(situation || '').trim();
  if (!text) return text;
  const last = text.split(/\s+/).pop();
  const isConnective = CONNECTIVE_ENDING_LIST.some((ending) => last.endsWith(ending));
  return isConnective ? `${text} ${SITUATION_FALLBACK_TAIL}` : text;
}

function dropRepeatedWordAtSeam({ text }) {
  const wordList = String(text || '').split(' ');
  const keptList = wordList.filter((word, index) => index === 0 || word !== wordList[index - 1]);
  return keptList.join(' ');
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
    [PAGE_TRANSITION_KIND_MAP.document]: ({ slotMap }) => (
      `${slotMap.screenForm}, ${slotMap.description}`
    ),
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
    [INTERPRETATION_KIND_MAP.claimToValue]: ({ slotMap }) => (
      `${attachJosa({ text: slotMap.value, withFinal: '은', withoutFinal: '는' })} `
      + `${attachJosa({ text: slotMap.frame, withFinal: '을', withoutFinal: '를' })} 의미`
    ),
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

function assembleNarration({ narrationType, subKind, rawSlotMap, index = '' }) {
  const slotList = getSlotList({ narrationType, subKind });
  const assemble = NARRATION_ASSEMBLE_MAP[narrationType]?.[subKind];
  if (!slotList || !assemble) return null;
  const slotMap = normalizeSlotMap({ slotList, rawSlotMap });
  if (slotMap.situation) slotMap.situation = completeSituationSlot({ situation: slotMap.situation });
  if (hasEmptyRequiredSlot({ slotList, slotMap })) return null;
  if (hasValuelessSlot({ slotList, slotMap })) return null;
  if (hasInvalidTailSlot({ slotList, slotMap })) return null;
  const joined = assemble({ slotMap, index }).replace(/\s+/g, ' ').trim();
  return { text: dropRepeatedWordAtSeam({ text: joined }), slotMap };
}

module.exports = {
  NARRATION_SLOT_MAP, getSlotList, computeSlotTotal, buildSlotInstruction, DESCRIPTION_TAIL_NOUN_LIST, hasCompleteTailNoun,
  normalizeSlotMap, hasEmptyRequiredSlot, hasValuelessSlot, hasValueToken, assembleNarration, countWord, truncateSlot,
  trimToCompletePhrase, hasFinalConsonant, attachJosa,
};
