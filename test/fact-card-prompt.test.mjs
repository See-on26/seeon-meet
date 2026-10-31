import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildFactCardBlock, FACT_CARD_USAGE_MAP } = require('../src/main/caption-pipeline/prompts/fact-card-block.js');
const { createInterpretiveBridgeAgent } = require('../src/main/caption-pipeline/agents/interpretive-bridge-agent.js');
const { createVisualDescriptionAgent } = require('../src/main/caption-pipeline/agents/visual-description-agent.js');
const { createDeixisResolutionAgent } = require('../src/main/caption-pipeline/agents/deixis-resolution-agent.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');
const { resolveFactCardUsage } = require('../src/main/caption-pipeline/orchestrator/fact-card-select.js');

// 화면 사실 카드 덩어리는 수치(규칙 앞)·척도(청자 줄 앞)의 OCR 덩어리 바로 앞에, 지시(켰을 때)는 지시 표현 줄 다음에 넣는다.
// 카드가 없으면 프롬프트는 지금과 글자 하나까지 같다. 아래 화면은 모두 지어낸 예다.
const item = (label, value, note = '') => ({ label, value, note, isValueVerified: null });
const factCardList = [{
  id: '3:1', kind: 'chart', title: '지역별 판매량', position: '왼쪽', period: '2023~2024', unit: '천 대',
  axisList: [{ name: '판매량', from: '0', to: '800' }], legendList: ['2023', '2024'], headerList: [],
  itemList: [item('서울', '2023 410, 2024 520'), item('부산', '2023 300, 2024 280')], count: 5, matchedItemIndexList: [0],
}];
const screenLineList = [{ text: '지역별 판매량', score: 0.95 }, { text: '서울 410 520', score: 0.93 }];
const LISTENER_LINE = '청자는 화면을 볼 수 없다.';
const OCR_INTRO_PREFIX = '참고: 아래는 같은 화면을 글자 인식기(OCR)로';
const DEIXIS_LISTENER_PREFIX = '청자는 화면을 볼 수 없다. 발표자가 가리킨 대상 중';
const EMPTY_CARD_LIST = [undefined, null, []];
const insertBefore = ({ prompt, marker, block }) => {
  const index = prompt.indexOf(marker);
  assert.ok(index > 0, marker);
  return `${prompt.slice(0, index)}${block}\n\n${prompt.slice(index)}`;
};

test('카드가 없거나 빈 목록이면 수치 프롬프트는 지금과 같다(유형·언어·OCR 줄·둘째 변화 조합 전부)', () => {
  for (const subKind of ['claim_to_value', 'value_to_meaning', null]) {
    for (const language of ['ko', 'en']) {
      for (const lineList of [[], screenLineList]) {
        for (const mergedClaimList of [[], ['방문자도 늘었습니다']]) {
          const option = { utterance: '서울 판매가 크게 늘었습니다', subKind, language, screenLineList: lineList, mergedClaimList };
          const base = buildInterpretationPrompt(option);
          for (const emptyList of EMPTY_CARD_LIST) {
            assert.equal(buildInterpretationPrompt({ ...option, factCardList: emptyList }), base,
              `${subKind}/${language}/${lineList.length}/${mergedClaimList.length}/${JSON.stringify(emptyList)}`);
          }
          assert.doesNotMatch(base, /패널별로 정리한 사실/);
        }
      }
    }
  }
});

test('수치 프롬프트: 카드 덩어리는 OCR 덩어리 바로 앞(없으면 청자 줄 앞)에 빈 줄 하나를 두고 들어간다', () => {
  const block = buildFactCardBlock({ cardList: factCardList, usage: FACT_CARD_USAGE_MAP.value }).text;
  assert.ok(block);
  for (const subKind of ['claim_to_value', 'value_to_meaning']) {
    const option = { utterance: '서울 판매가 크게 늘었습니다', subKind };
    assert.equal(
      buildInterpretationPrompt({ ...option, factCardList }),
      insertBefore({ prompt: buildInterpretationPrompt(option), marker: LISTENER_LINE, block }), subKind,
    );
    const withOcr = buildInterpretationPrompt({ ...option, screenLineList });
    assert.equal(
      buildInterpretationPrompt({ ...option, screenLineList, factCardList }),
      insertBefore({ prompt: withOcr, marker: OCR_INTRO_PREFIX, block }), subKind,
    );
  }
});

test('카드가 없거나 빈 목록이면 척도 프롬프트는 지금과 같고, 사진 반응·무발화 묘사는 카드를 받아도 넣지 않는다', () => {
  for (const language of ['ko', 'en']) {
    for (const lineList of [[], screenLineList]) {
      const option = { subKind: 'scale', utterance: '저 건물 정말 크죠', mergedAnchorList: ['저 건물'], language, screenLineList: lineList };
      const base = buildVisualDescriptionPrompt(option);
      for (const emptyList of EMPTY_CARD_LIST) {
        assert.equal(buildVisualDescriptionPrompt({ ...option, factCardList: emptyList }), base, `${language}/${lineList.length}`);
      }
    }
  }
  for (const option of [{ subKind: 'reaction' }, { subKind: 'reaction', origin: 'silence', recentTranscript: '그래프 보시죠' }]) {
    assert.equal(buildVisualDescriptionPrompt({ ...option, factCardList }), buildVisualDescriptionPrompt(option));
  }
});

test('척도 프롬프트: 척도용 카드 덩어리를 OCR 덩어리 바로 앞(없으면 청자 줄 앞)에 넣는다', () => {
  const block = buildFactCardBlock({ cardList: factCardList, usage: FACT_CARD_USAGE_MAP.scale }).text;
  const option = { subKind: 'scale', utterance: '판매량이 정말 크죠' };
  assert.equal(
    buildVisualDescriptionPrompt({ ...option, factCardList }),
    insertBefore({ prompt: buildVisualDescriptionPrompt(option), marker: '청자는 화면을 볼 수 없다. 발표자는', block }),
  );
  assert.equal(
    buildVisualDescriptionPrompt({ ...option, screenLineList, factCardList }),
    insertBefore({ prompt: buildVisualDescriptionPrompt({ ...option, screenLineList }), marker: OCR_INTRO_PREFIX, block }),
  );
  assert.match(block, /비교 대상으로 쓸 수 있다/);
});

test('카드가 없거나 빈 목록이면 지시 프롬프트는 지금과 같다. 카드가 오면 지시 표현 줄 다음·청자 줄 앞에 값 없는 덩어리를 넣는다', () => {
  for (const subKind of ['simple', 'complete', null]) {
    for (const language of ['ko', 'en']) {
      for (const hasPointingRegion of [false, true]) {
        const option = { utterance: '여기 이 지역', maxChars: 60, subKind, language, hasPointingRegion, mergedAnchorList: ['이 지역'] };
        const base = buildGroundingPrompt(option);
        for (const emptyList of EMPTY_CARD_LIST) {
          assert.equal(buildGroundingPrompt({ ...option, factCardList: emptyList }), base, `${subKind}/${language}/${hasPointingRegion}`);
        }
        const block = buildFactCardBlock({ cardList: factCardList, usage: FACT_CARD_USAGE_MAP.deixis }).text;
        const withCard = buildGroundingPrompt({ ...option, factCardList });
        assert.equal(withCard, insertBefore({ prompt: base, marker: DEIXIS_LISTENER_PREFIX, block }));
        assert.ok(withCard.indexOf('발표자가 지시한 표현') < withCard.indexOf('구역 이름과 구성'));
        assert.doesNotMatch(withCard, /410|부산/);
      }
    }
  }
});

test('기본 설정에서는 지시 에이전트가 카드를 받지 않는다', () => {
  const config = readPipelineConfig({ SEEON_FACT_CARD: 'on' });
  assert.equal(resolveFactCardUsage({
    narrationType: 'deixis', isEnabled: config.isFactCardEnabled, agentList: config.factCardAgentList,
  }), null);
  assert.equal(resolveFactCardUsage({
    narrationType: 'interpretation', isEnabled: config.isFactCardEnabled, agentList: config.factCardAgentList,
  }), FACT_CARD_USAGE_MAP.value);
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function runAgent({ createAgent, content, generateOption }) {
  const promptList = [];
  globalThis.fetch = async (_url, init) => {
    promptList.push(JSON.parse(init.body).messages[0].content.find((block) => block.type === 'text').text);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const result = await createAgent({ config: { vlmUrl: 'http://x', vlmModel: 'm' } })
    .generate({ jpegBuffer: Buffer.from('x'), ...generateOption });
  return { result, promptList };
}

test('에이전트: 카드를 받으면 덩어리를 넣고 들어간 장수·글자 수를 돌려준다. 없으면 0이다', async () => {
  const caseList = [
    { createAgent: createInterpretiveBridgeAgent, content: '{"target":"서울 판매량","value":"410에서 520"}', usage: FACT_CARD_USAGE_MAP.value,
      generateOption: { utterance: '서울 판매가 크게 늘었습니다', subKind: 'claim_to_value' } },
    { createAgent: createVisualDescriptionAgent, content: '{"caption":"800 눈금에 가까운 서울 막대"}', usage: FACT_CARD_USAGE_MAP.scale,
      generateOption: { utterance: '판매량이 정말 크죠', subKind: 'scale' } },
    { createAgent: createDeixisResolutionAgent, content: '{"seen":"지역별 판매량","caption":"지역별 판매량 그래프"}', usage: FACT_CARD_USAGE_MAP.deixis,
      generateOption: { utterance: '여기 이 그래프', subKind: 'simple' } },
  ];
  for (const { createAgent, content, usage, generateOption } of caseList) {
    const block = buildFactCardBlock({ cardList: factCardList, usage });
    const withCard = await runAgent({ createAgent, content, generateOption: { ...generateOption, factCardList } });
    assert.ok(withCard.promptList[0].includes(block.text), usage);
    assert.deepEqual(withCard.result.factCardBlock, { cardCount: 1, charCount: block.charCount }, usage);
    const withoutCard = await runAgent({ createAgent, content, generateOption });
    assert.doesNotMatch(withoutCard.promptList[0], /패널별로 정리한 사실|구역 이름과 구성/, usage);
    assert.deepEqual(withoutCard.result.factCardBlock, { cardCount: 0, charCount: 0 }, usage);
  }
});
