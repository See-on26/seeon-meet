import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, detectEnglishCandidateList, TRIGGER_TYPE_MAP } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');
const { createNarrationHistory } = require('../src/main/caption-pipeline/orchestrator/narration-history.js');
const { NARRATION_CLASS_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

// v5.4: 다섯 판 S 오답 판정에서 트리거가 놓친 화면 자료 표현. 문장은 바꿔 썼다.
const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
let kiwiTrigger = null;

before(async () => {
  if (!hasKiwiModel) return;
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  kiwiTrigger = createSpeechTrigger({ tokenizer });
});

const { number, change, adjectiveNoun, demonstrative } = TRIGGER_TYPE_MAP;

function phraseListOf({ candidateList, type }) {
  return candidateList.filter((candidate) => candidate.type === type).map((candidate) => candidate.phrase);
}

test('한국어: 방향어 + 자료 명사, 표시한 부분, 단위 없는 범위 수를 잡는다', { skip: !hasKiwiModel }, () => {
  const detect = (text) => kiwiTrigger.detect({ text }).candidateList;
  assert.ok(phraseListOf({ candidateList: detect('오른쪽 그래프를 보시면 판매량이 빠집니다'), type: adjectiveNoun }).some((p) => p.includes('오른쪽 그래프')));
  assert.ok(phraseListOf({ candidateList: detect('파란 동그라미로 표시한 부분이 공장 부지입니다'), type: adjectiveNoun }).some((p) => p.includes('표시한 부분')));
  assert.ok(phraseListOf({ candidateList: detect('남쪽은 시간당 20에서 30 정도 내립니다'), type: number }).some((p) => p.includes('20에서 30')));
  // 단위가 붙은 범위·연도 범위는 이 규칙으로 더하지 않는다.
  assert.ok(!phraseListOf({ candidateList: detect('2012년에서 2017년까지 운영했습니다'), type: number }).some((p) => p.includes('에서')));
});

test('영어: show you the …, than 없는 do slightly better 를 잡는다', () => {
  assert.deepEqual(phraseListOf({ candidateList: detectEnglishCandidateList({ text: 'I can show you the first rows' }), type: demonstrative }), ['show you the']);
  assert.ok(phraseListOf({ candidateList: detectEnglishCandidateList({ text: 'the new models do slightly better on the test' }), type: change })
    .includes('do slightly better'));
});

test('간격 억제: 막는 해설에 없던 수치가 든 해설은 6초만 둔다', () => {
  const history = createNarrationHistory();
  history.remember({ text: '분기별 매출 표', ts: 0, narrationClass: NARRATION_CLASS_MAP.deixis });
  const same = history.findRateLimited({ narrationClass: NARRATION_CLASS_MAP.deixis, ts: 8000, text: '분기별 매출 표의 제목' });
  assert.equal(same.isRateLimited, true);
  const newFact = history.findRateLimited({ narrationClass: NARRATION_CLASS_MAP.deixis, ts: 8000, text: '3분기 서울 매출 42억' });
  assert.equal(newFact.isRateLimited, false);
  const tooSoon = history.findRateLimited({ narrationClass: NARRATION_CLASS_MAP.deixis, ts: 4000, text: '3분기 서울 매출 42억' });
  assert.equal(tooSoon.isRateLimited, true);
});
