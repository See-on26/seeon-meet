export const DEIXIS_KIND_MAP = {
  demonstrative: 'demonstrative',
  color: 'color',
  ordinal: 'ordinal',
  position: 'position',
  superlative: 'superlative',
  sequence: 'sequence',
  data: 'data',
  attention: 'attention',
  pointing: 'pointing',
};

export const FEATURE1_KIND_LIST = [DEIXIS_KIND_MAP.demonstrative, DEIXIS_KIND_MAP.pointing];

export const ACTIVE_KIND_LIST = [...FEATURE1_KIND_LIST, DEIXIS_KIND_MAP.data, DEIXIS_KIND_MAP.color];

const STRONG_DEICTIC_LIST = [
  '이거', '이건', '이게', '이걸', '이것',
  '그거', '그건', '그게', '그걸', '그것',
  '저거', '저건', '저게', '저걸', '저것',
  '요거', '요건', '요게', '요걸', '요것',
  '이곳', '그곳', '저곳', '요곳', '이쪽', '그쪽', '저쪽', '요쪽',
  '여기', '거기', '저기', '요기', '여긴', '거긴', '저긴',
  '여길', '저길', '거길', '요서', '요기서', '여서', '거서', '저서',
  '이런', '저런', '그런것', '그런거', '그런게', '그런것들',
];

const DEMONSTRATIVE_LIST = ['이', '그', '저', '요'];

const POINTING_NOUN_LIST = [
  '부분', '부위', '영역', '파트', '수치', '값', '숫자', '표', '그래프', '차트',
  '그림', '사진', '이미지', '슬라이드', '도표', '자료', '칸', '셀', '행', '열',
  '줄', '항목', '색', '색깔', '동그라미', '네모', '화살표', '박스', '목록', '리스트',
  '글자', '단어', '문장', '문구', '텍스트', '제목', '라벨', '범례', '막대', '점',
  '체크', '밑줄', '표시', '지점', '위치', '코드', '수식', '공식', '도형', '페이지',
  '장면', '화면', '결과', '데이터',
];

const POSITION_LIST = [
  '오른쪽', '왼쪽', '우측', '좌측', '위쪽', '아래쪽', '상단', '하단', '가운데', '중앙', '맨위', '맨아래',
];

const COLLOQUIAL_DIRECTION_LIST = ['일로', '이리로', '그리로', '저리로', '요리로'];

const NON_REFERENT_FOLLOW_LIST = [
  '때', '때문', '정도', '만큼', '뿐', '후', '전', '동안', '사이', '순간', '경우', '이후', '이전',
  '무렵', '즈음', '와중', '대신', '덕분', '탓',
];

const COLOR_LIST = [
  '빨간', '빨강', '붉은', '파란', '파랑', '푸른', '노란', '노랑', '초록', '연두', '주황', '보라',
  '분홍', '핑크', '검은', '검정', '하얀', '흰', '회색', '남색', '하늘색', '갈색', '보라색',
];

// "빨간 쪽", "파란 선"처럼 색 바로 뒤에 오는 지시 대상 낱말.
const COLOR_REFERENT_LIST = ['쪽', '선', '것', '거', '걸', '게', '줄', '칸', '면'];

const LOOK_CUE_LIST = ['보세요', '보시죠', '보시면', '보면', '보십시오', '봐주세요', '보이시', '볼까요', '주목', '짚어'];

const NATIVE_ORDINAL_LIST = ['첫', '두', '둘', '세', '셋', '네', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '몇'];

const DATA_CUE_LIST = ['최대', '최저', '최고', '증가', '감소', '상승', '하락', '경향', '추세', '들쑥날쑥', '편차', '비율', '평균'];

const CHANGE_CUE_LIST = [
  '늘었', '늘어', '줄었', '줄어', '바뀌', '달라졌', '커졌', '작아졌',
  '높아졌', '낮아졌', '올랐', '내렸', '차이가', '대비',
];

const QUANTITY_UNIT_LIST = ['개', '원', '명', '건', '배', '회', '위', '점', '곳', '종', '달러', '톤'];

const ATTENTION_CUE_LIST = ['봐주세요', '보십시오', '보세요', '보시면', '보시죠', '보시고', '주목', '유의하', '확인해주', '확인하시', '짚어'];

const SUPERLATIVE_LIST = ['가장', '제일', '최대', '최소'];
const SEQUENCE_LIST = ['다음', '이전', '처음', '마지막', '먼저'];

const POINTING_NOUN_GROUP = POINTING_NOUN_LIST.join('|');
const REFERENT_NOUN_GROUP = [...POINTING_NOUN_LIST, '것', '거', '걸', '게'].join('|');
const PARTICLE_GROUP = '을|를|이|가|은|는|에|의';

const DEMONSTRATIVE_NOUN_PATTERN = new RegExp(
  `(?:${DEMONSTRATIVE_LIST.join('|')})\\s*(?:${POINTING_NOUN_GROUP})`,
);

const DEICTIC_MODIFIER_NOUN_PATTERN = new RegExp(
  `(?:^|\\s)(?:${DEMONSTRATIVE_LIST.join('|')})\\s+([가-힣A-Za-z][가-힣A-Za-z0-9]*)`,
);
const COLLOQUIAL_DIRECTION_PATTERN = new RegExp(
  `(?:^|\\s)(?:${COLLOQUIAL_DIRECTION_LIST.join('|')})(?=\\s|$)`,
);
const COLOR_PATTERN = new RegExp(
  `(?:${COLOR_LIST.join('|')})색?\\s*(?:${POINTING_NOUN_GROUP}|${COLOR_REFERENT_LIST.join('|')}|${PARTICLE_GROUP})`,
);
const ORDINAL_PATTERN = new RegExp(
  `(?:(?:${NATIVE_ORDINAL_LIST.join('|')})\\s*번째|\\d+\\s*번(?:째)?)`,
);
const POSITION_PATTERN = new RegExp(
  `(?:${POSITION_LIST.join('|')})\\s*(?:${POINTING_NOUN_GROUP}|${PARTICLE_GROUP})`,
);
const SUPERLATIVE_PATTERN = new RegExp(`(?:${SUPERLATIVE_LIST.join('|')})`);
const SEQUENCE_PATTERN = new RegExp(
  `(?:${SEQUENCE_LIST.join('|')})\\s*(?:으로|에|의)?\\s*(?:나오는|나온|보이는|있는)?\\s*(?:${REFERENT_NOUN_GROUP})`,
);
const DATA_CUE_PATTERN = new RegExp(`(?:${DATA_CUE_LIST.join('|')}|${CHANGE_CUE_LIST.join('|')}|\\d+\\s*(?:%|퍼센트|프로))`);
const QUANTITY_CUE_PATTERN = new RegExp(`(?:\\d[\\d,.]*\\s*(?:천|만|억)?|[일이삼사오육칠팔구]?[십백천만억])\\s*(?:${QUANTITY_UNIT_LIST.join('|')})`);
const ATTENTION_CUE_PATTERN = new RegExp(`(?:${ATTENTION_CUE_LIST.join('|')})`);

const DEFAULT_COOLDOWN_MS = 4000;

function findPointingNoun(text) {
  return POINTING_NOUN_LIST.find((noun) => text.includes(noun)) || null;
}

function matchStrongDeictic(text) {
  return STRONG_DEICTIC_LIST.find((word) => text.includes(word)) || null;
}

function matchPattern(pattern) {
  return (text) => text.match(pattern)?.[0] || null;
}

function matchColloquialDirection(text) {
  return text.match(COLLOQUIAL_DIRECTION_PATTERN)?.[0].trim() || null;
}

function matchModifierNoun(text) {
  const match = text.match(DEICTIC_MODIFIER_NOUN_PATTERN);
  if (!match) return null;
  const isNonReferentFollow = NON_REFERENT_FOLLOW_LIST.some((word) => match[1].startsWith(word));
  return isNonReferentFollow ? null : match[0].trim();
}

function matchLookCuePointing(text) {
  const pointingNoun = findPointingNoun(text);
  return pointingNoun && LOOK_CUE_LIST.some((cue) => text.includes(cue)) ? pointingNoun : null;
}

const DEIXIS_MATCHER_LIST = [
  { kind: DEIXIS_KIND_MAP.demonstrative, match: matchStrongDeictic },
  { kind: DEIXIS_KIND_MAP.demonstrative, match: matchPattern(DEMONSTRATIVE_NOUN_PATTERN) },
  { kind: DEIXIS_KIND_MAP.demonstrative, match: matchColloquialDirection },
  { kind: DEIXIS_KIND_MAP.demonstrative, match: matchModifierNoun },
  { kind: DEIXIS_KIND_MAP.color, match: matchPattern(COLOR_PATTERN) },
  { kind: DEIXIS_KIND_MAP.ordinal, match: matchPattern(ORDINAL_PATTERN) },
  { kind: DEIXIS_KIND_MAP.position, match: matchPattern(POSITION_PATTERN) },
  { kind: DEIXIS_KIND_MAP.sequence, match: matchPattern(SEQUENCE_PATTERN) },
  { kind: DEIXIS_KIND_MAP.superlative, match: matchPattern(SUPERLATIVE_PATTERN) },
  { kind: DEIXIS_KIND_MAP.data, match: matchPattern(DATA_CUE_PATTERN) },
  { kind: DEIXIS_KIND_MAP.data, match: matchPattern(QUANTITY_CUE_PATTERN) },
  { kind: DEIXIS_KIND_MAP.pointing, match: matchLookCuePointing },
  { kind: DEIXIS_KIND_MAP.attention, match: matchPattern(ATTENTION_CUE_PATTERN) },
];

// activeKindSet 이 주어지면 그 종류만 검사한다. 비활성 종류가 먼저 걸려 뒤의 활성 종류를 놓치지 않게 하기 위해서다.
export function detectDeixis(text, { activeKindSet = null } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { isDeixis: false, trigger: null, kind: null };
  for (const matcher of DEIXIS_MATCHER_LIST) {
    if (activeKindSet && !activeKindSet.has(matcher.kind)) continue;
    const trigger = matcher.match(trimmed);
    if (trigger) return { isDeixis: true, trigger, kind: matcher.kind };
  }
  return { isDeixis: false, trigger: null, kind: null };
}

export class DeixisDetector {
  constructor({ onDeixis, cooldownMs = DEFAULT_COOLDOWN_MS, activeKindList = ACTIVE_KIND_LIST }) {
    this.onDeixis = onDeixis;
    this.cooldownMs = cooldownMs;
    this.activeKindSet = new Set(activeKindList);
    this.lastFiredAt = -Infinity;
  }

  reset() {
    this.lastFiredAt = -Infinity;
  }

  handleTranscript({ text, captureTs, eventWallTs = null, resolveEventWallTs = null }) {
    const result = detectDeixis(text, { activeKindSet: this.activeKindSet });
    if (!result.isDeixis) return null;
    if (captureTs - this.lastFiredAt < this.cooldownMs) return null;
    this.lastFiredAt = captureTs;
    const deixisEvent = {
      text: text.trim(), trigger: result.trigger, kind: result.kind, captureTs,
      eventWallTs: resolveEventWallTs ? resolveEventWallTs({ trigger: result.trigger }) : eventWallTs,
    };
    this.onDeixis?.(deixisEvent);
    return deixisEvent;
  }
}
