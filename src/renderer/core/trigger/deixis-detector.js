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

export const ACTIVE_KIND_LIST = [...FEATURE1_KIND_LIST, DEIXIS_KIND_MAP.data];

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
  '빨간', '빨강', '파란', '파랑', '노란', '노랑', '초록', '주황', '보라',
  '분홍', '핑크', '검은', '흰', '회색', '남색', '하늘색', '갈색', '보라색',
];

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
  `(?:${COLOR_LIST.join('|')})색?\\s*(?:${POINTING_NOUN_GROUP}|${PARTICLE_GROUP})`,
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

export function detectDeixis(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { isDeixis: false, trigger: null, kind: null };

  for (const word of STRONG_DEICTIC_LIST) {
    if (trimmed.includes(word)) {
      return { isDeixis: true, trigger: word, kind: DEIXIS_KIND_MAP.demonstrative };
    }
  }
  const demonstrativeMatch = trimmed.match(DEMONSTRATIVE_NOUN_PATTERN);
  if (demonstrativeMatch) {
    return { isDeixis: true, trigger: demonstrativeMatch[0], kind: DEIXIS_KIND_MAP.demonstrative };
  }
  const colloquialDirectionMatch = trimmed.match(COLLOQUIAL_DIRECTION_PATTERN);
  if (colloquialDirectionMatch) {
    return {
      isDeixis: true, trigger: colloquialDirectionMatch[0].trim(), kind: DEIXIS_KIND_MAP.demonstrative,
    };
  }

  const modifierNounMatch = trimmed.match(DEICTIC_MODIFIER_NOUN_PATTERN);
  const isNonReferentFollow = modifierNounMatch
    && NON_REFERENT_FOLLOW_LIST.some((word) => modifierNounMatch[1].startsWith(word));
  if (modifierNounMatch && !isNonReferentFollow) {
    return {
      isDeixis: true, trigger: modifierNounMatch[0].trim(), kind: DEIXIS_KIND_MAP.demonstrative,
    };
  }
  const colorMatch = trimmed.match(COLOR_PATTERN);
  if (colorMatch) {
    return { isDeixis: true, trigger: colorMatch[0], kind: DEIXIS_KIND_MAP.color };
  }
  const ordinalMatch = trimmed.match(ORDINAL_PATTERN);
  if (ordinalMatch) {
    return { isDeixis: true, trigger: ordinalMatch[0], kind: DEIXIS_KIND_MAP.ordinal };
  }
  const positionMatch = trimmed.match(POSITION_PATTERN);
  if (positionMatch) {
    return { isDeixis: true, trigger: positionMatch[0], kind: DEIXIS_KIND_MAP.position };
  }
  const sequenceMatch = trimmed.match(SEQUENCE_PATTERN);
  if (sequenceMatch) {
    return { isDeixis: true, trigger: sequenceMatch[0], kind: DEIXIS_KIND_MAP.sequence };
  }
  const superlativeMatch = trimmed.match(SUPERLATIVE_PATTERN);
  if (superlativeMatch) {
    return { isDeixis: true, trigger: superlativeMatch[0], kind: DEIXIS_KIND_MAP.superlative };
  }
  const dataMatch = trimmed.match(DATA_CUE_PATTERN);
  if (dataMatch) {
    return { isDeixis: true, trigger: dataMatch[0], kind: DEIXIS_KIND_MAP.data };
  }
  const quantityMatch = trimmed.match(QUANTITY_CUE_PATTERN);
  if (quantityMatch) {
    return { isDeixis: true, trigger: quantityMatch[0], kind: DEIXIS_KIND_MAP.data };
  }

  const pointingNoun = findPointingNoun(trimmed);
  if (pointingNoun && LOOK_CUE_LIST.some((cue) => trimmed.includes(cue))) {
    return { isDeixis: true, trigger: pointingNoun, kind: DEIXIS_KIND_MAP.pointing };
  }
  const attentionMatch = trimmed.match(ATTENTION_CUE_PATTERN);
  if (attentionMatch) {
    return { isDeixis: true, trigger: attentionMatch[0], kind: DEIXIS_KIND_MAP.attention };
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

  handleTranscript({ text, captureTs }) {
    const result = detectDeixis(text);
    if (!result.isDeixis) return null;
    if (!this.activeKindSet.has(result.kind)) return null;
    if (captureTs - this.lastFiredAt < this.cooldownMs) return null;
    this.lastFiredAt = captureTs;
    const deixisEvent = { text: text.trim(), trigger: result.trigger, kind: result.kind, captureTs };
    this.onDeixis?.(deixisEvent);
    return deixisEvent;
  }
}
