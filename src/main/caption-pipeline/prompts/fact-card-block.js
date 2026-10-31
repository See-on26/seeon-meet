// 해설 에이전트 프롬프트에 넣는 "화면 사실 카드" 덩어리. 슬라이드가 바뀔 때 미리 읽어 둔 패널별 사실 중 발화와 가까운 것만 넣는다.
// 카드는 대상·기간·단위·비교 기준을 확인하는 보조이고, 지금 이미지와 다르면 이미지를 따르게 한다.

// 덩어리를 받는 해설. 수치는 값까지, 척도는 비교 대상 후보까지, 지시는 구역 이름·구성만(값·항목 이름 없이) 받는다.
const FACT_CARD_USAGE_MAP = { value: 'value', scale: 'scale', deixis: 'deixis' };
// 수치는 두 패널을 함께 말하는 일(왼쪽 그래프와 오른쪽 표의 변화)이 많아 2장까지 넣는다.
const FACT_CARD_BLOCK_LIMIT_MAP = {
  [FACT_CARD_USAGE_MAP.value]: { cardCount: 2, maxChars: 450 },
  [FACT_CARD_USAGE_MAP.scale]: { cardCount: 1, maxChars: 250 },
  [FACT_CARD_USAGE_MAP.deixis]: { cardCount: 1, maxChars: 200 },
};

const FACT_CARD_INTRO_LINE = '참고: 아래는 슬라이드가 바뀔 때 이 화면을 미리 읽어 패널별로 정리한 사실이다. 발표자가 말한 대상과 가까운 것만 골랐다.';
const FACT_CARD_INTRO_LINE_MAP = {
  [FACT_CARD_USAGE_MAP.value]: FACT_CARD_INTRO_LINE,
  [FACT_CARD_USAGE_MAP.scale]: FACT_CARD_INTRO_LINE,
  [FACT_CARD_USAGE_MAP.deixis]: '참고: 아래는 이 화면의 한 구역 이름과 구성이다(값은 넣지 않았다).',
};
// 둘째 안내 줄은 "어디서 확인하나"만 말한다. 무엇을 빠뜨리지 말라는 것은 각 에이전트의 규칙이 맡는다.
const FACT_CARD_USAGE_LINE_MAP = {
  [FACT_CARD_USAGE_MAP.value]: '  값의 대상·기간·단위·비교 기준은 여기서 확인해 빠뜨리지 않는다. 지금 이미지와 다르면 이미지를 따르고, 여기에도 이미지에도 없는 값은 쓰지 않는다.',
  [FACT_CARD_USAGE_MAP.scale]: '  축 범위·적힌 크기 값·같은 패널의 다른 항목을 비교 대상으로 쓸 수 있다. 지금 이미지와 다르면 이미지를 따른다.',
  [FACT_CARD_USAGE_MAP.deixis]: '  가리킨 대상이 이 구역이면 구역 이름·기간·축 범위·항목 수를 대상 이름에 쓰고, 다른 곳을 가리켰으면 무시한다.',
};
const FACT_CARD_KIND_LABEL_MAP = {
  chart: '그래프', table: '표', list: '목록', diagram: '도식', text: '글 상자', map: '지도', image: '그림',
};
const QUOTE_FENCE = '"""';
const ITEM_LINE_INDENT = '  ';
const ITEM_SEPARATOR = ' / ';
const EMPTY_BLOCK = { text: '', cardCount: 0, charCount: 0 };

function buildHeadLine({ card, number }) {
  const name = [FACT_CARD_KIND_LABEL_MAP[card.kind], card.title ? `「${card.title}」` : ''].filter(Boolean).join(' ');
  const position = card.position ? `(${card.position})` : '';
  return [
    `[사실 ${number}]${name || position ? ` ${name}${position}` : ''}`,
    card.period ? `기간 ${card.period}` : '',
    card.unit ? `단위 ${card.unit}` : '',
  ].filter(Boolean).join(' · ');
}

function formatAxis(axis) {
  const range = axis.from && axis.to ? `${axis.from}~${axis.to}` : (axis.from || axis.to);
  return [axis.name, range].filter(Boolean).join(' ');
}

function buildStructureLine(card) {
  const axisText = (card.axisList || []).map(formatAxis).filter(Boolean).join(' / ');
  const partList = [
    axisText ? `축: ${axisText}` : '',
    card.legendList?.length ? `범례: ${card.legendList.join(', ')}` : '',
    card.headerList?.length ? `머리글: ${card.headerList.join(' | ')}` : '',
    card.count > 0 ? `항목 ${card.count}개` : '',
  ].filter(Boolean);
  return partList.length ? `${ITEM_LINE_INDENT}${partList.join(' · ')}` : '';
}

function formatItem(item) {
  const body = item.label && item.value ? `${item.label}: ${item.value}` : (item.label || item.value);
  return item.note ? `${body} (${item.note})` : body;
}

// 남은 글자 안에서 ① 발화가 맞힌 항목 → ② 나머지 항목 순으로 담고, 담은 항목은 원래 순서로 돌려준다.
// 위에서부터 자르면 항목 많은 표 아래쪽에 있는 말한 대상의 행이 빠진다.
function selectItemTextList({ card, maxChars }) {
  const textList = (card.itemList || []).map(formatItem);
  const matchedSet = new Set(card.matchedItemIndexList || []);
  const orderList = [
    ...textList.map((_, index) => index).filter((index) => matchedSet.has(index)),
    ...textList.map((_, index) => index).filter((index) => !matchedSet.has(index)),
  ];
  const selectedSet = new Set();
  let usedChars = 0;
  for (const index of orderList) {
    const cost = textList[index].length + (selectedSet.size ? ITEM_SEPARATOR.length : ITEM_LINE_INDENT.length);
    if (!textList[index] || usedChars + cost > maxChars) continue;
    selectedSet.add(index);
    usedChars += cost;
  }
  return textList.filter((_, index) => selectedSet.has(index));
}

function buildFactCardBlock({ cardList = [], usage = FACT_CARD_USAGE_MAP.value }) {
  const limit = FACT_CARD_BLOCK_LIMIT_MAP[usage] || FACT_CARD_BLOCK_LIMIT_MAP[FACT_CARD_USAGE_MAP.value];
  const isValueHidden = usage === FACT_CARD_USAGE_MAP.deixis;
  const contentLineList = [];
  let charCount = 0;
  let cardCount = 0;
  for (const card of (Array.isArray(cardList) ? cardList : []).slice(0, limit.cardCount)) {
    // 머리 줄(종류·제목·위치·기간·단위)과 구성 줄(축·범례·머리글·개수)은 짧아 늘 담는다. 그것도 안 들어가면 그 카드는 넣지 않는다.
    const headLineList = [buildHeadLine({ card, number: cardCount + 1 }), buildStructureLine(card)].filter(Boolean);
    const headChars = headLineList.reduce((sum, text) => sum + text.length, 0);
    if (charCount + headChars > limit.maxChars) break;
    charCount += headChars;
    contentLineList.push(...headLineList);
    cardCount += 1;
    if (isValueHidden) continue;
    const itemTextList = selectItemTextList({ card, maxChars: limit.maxChars - charCount });
    if (!itemTextList.length) continue;
    const itemLine = `${ITEM_LINE_INDENT}${itemTextList.join(ITEM_SEPARATOR)}`;
    charCount += itemLine.length;
    contentLineList.push(itemLine);
  }
  if (!cardCount) return { ...EMPTY_BLOCK };
  return {
    text: [
      FACT_CARD_INTRO_LINE_MAP[usage] || FACT_CARD_INTRO_LINE,
      FACT_CARD_USAGE_LINE_MAP[usage] || FACT_CARD_USAGE_LINE_MAP[FACT_CARD_USAGE_MAP.value],
      QUOTE_FENCE, ...contentLineList, QUOTE_FENCE,
    ].join('\n'),
    cardCount,
    charCount,
  };
}

module.exports = { buildFactCardBlock, FACT_CARD_USAGE_MAP, FACT_CARD_BLOCK_LIMIT_MAP };
