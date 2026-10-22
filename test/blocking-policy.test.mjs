import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NARRATION_PRIORITY_MAP, BLOCKING_RULE_MAP, BLOCKING_RELATION_MAP, NARRATION_CLASS_LABEL_MAP,
  BLOCKING_RELATION_LABEL_MAP, POINTED_MIN_INTERVAL_MS, SPEECH_ONLY_MIN_INTERVAL_MS,
  SILENCE_AFTER_TRANSITION_MIN_INTERVAL_MS, SCREEN_CHANGE_MIN_INTERVAL_MS, readNarrationPriority, normalizeNarrationClass,
  findBlockingRule, resolveMinIntervalMs, readBlockingRelation,
} = require('../src/main/caption-pipeline/orchestrator/blocking-policy.js');
const { NARRATION_CLASS_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');

const {
  userCommand, pageTransition, speakerIdentity, silenceBased, speechBased, deixis, screenChange,
} = NARRATION_CLASS_MAP;
const CLASS_LIST = Object.values(NARRATION_CLASS_MAP);

// 렌더러 표와 같은지는 narration-queue 테스트가 비교한다(렌더러 ESM 을 이미 읽는 테스트라 경고가 늘지 않는다).
test('재생 우선순위는 질문 답 > 페이지 전환·화자 > 무발화 > 발화 기반·화면 변화 > 지시 순이다', () => {
  assert.deepEqual(NARRATION_PRIORITY_MAP, {
    [userCommand]: 0, [pageTransition]: 1, [speakerIdentity]: 1, [silenceBased]: 2, [speechBased]: 3, [screenChange]: 3,
    [deixis]: 4,
  });
});

test('분류가 빠졌거나 모르는 분류는 지시 순위로 읽는다', () => {
  for (const narrationClass of [null, undefined, '', 'unknown', 'constructor']) {
    assert.equal(readNarrationPriority({ narrationClass }), NARRATION_PRIORITY_MAP[deixis], String(narrationClass));
  }
  assert.equal(normalizeNarrationClass({ narrationClass: null }), deixis);
  assert.equal(normalizeNarrationClass({ narrationClass: 'unknown' }), deixis);
  assert.equal(normalizeNarrationClass({ narrationClass: speechBased }), speechBased);
});

test('모든 재생 분류가 차단 규칙 표에 행으로 적혀 있다', () => {
  assert.deepEqual(Object.keys(BLOCKING_RULE_MAP).sort(), [...CLASS_LIST].sort());
});

test('낮은 순위 해설은 높은 순위 해설을 막지 않는다 — 막는 분류는 순위 숫자가 같거나 작다(화면 변화 → 무발화만 예외)', () => {
  for (const [narrationClass, rule] of Object.entries(BLOCKING_RULE_MAP)) {
    if (!rule) continue;
    for (const blockedByClass of rule.blockedByClassList) {
      // 화면 변화 해설은 방금 화면을 말해 전환 고지처럼 무발화 해설만 막는다.
      if (narrationClass === silenceBased && blockedByClass === screenChange) continue;
      assert.ok(
        NARRATION_PRIORITY_MAP[blockedByClass] <= NARRATION_PRIORITY_MAP[narrationClass],
        `${blockedByClass}(${NARRATION_PRIORITY_MAP[blockedByClass]}) 가 ${narrationClass}(${NARRATION_PRIORITY_MAP[narrationClass]}) 를 막음`,
      );
    }
  }
});

test('질문 답은 내보냈어도 어느 자동 해설도 막지 않는다', () => {
  for (const rule of Object.values(BLOCKING_RULE_MAP)) {
    if (rule) assert.equal(rule.blockedByClassList.includes(userCommand), false);
  }
});

test('질문 답·페이지 전환·화자 안내는 간격 검사를 받지 않는다', () => {
  for (const narrationClass of [userCommand, pageTransition, speakerIdentity]) {
    assert.equal(BLOCKING_RULE_MAP[narrationClass], null, narrationClass);
    assert.equal(findBlockingRule({ narrationClass }), null, narrationClass);
  }
});

test('안내(질문 답·화자 안내)는 어떤 해설도 막지 않고, 페이지 전환 고지는 무발화 해설만 막는다', () => {
  for (const [narrationClass, rule] of Object.entries(BLOCKING_RULE_MAP)) {
    if (!rule) continue;
    assert.equal(rule.blockedByClassList.includes(userCommand), false, narrationClass);
    assert.equal(rule.blockedByClassList.includes(speakerIdentity), false, narrationClass);
    assert.equal(rule.blockedByClassList.includes(pageTransition), narrationClass === silenceBased, narrationClass);
  }
});

test('무발화 해설은 페이지 전환 고지·화면 변화 해설 뒤 12초만 막힌다(무발화끼리는 무발화 게이트가 막는다)', () => {
  const rule = findBlockingRule({ narrationClass: silenceBased });
  assert.deepEqual(rule.blockedByClassList, [pageTransition, screenChange]);
  assert.equal(SILENCE_AFTER_TRANSITION_MIN_INTERVAL_MS, 12000);
  assert.equal(resolveMinIntervalMs({ rule, hasPointingRegion: false }), 12000);
  assert.equal(resolveMinIntervalMs({ rule, hasPointingRegion: true }), 12000);
});

test('발화 기반 해설은 무발화·발화 기반 해설에만 막히고 지시 해설에는 막히지 않는다', () => {
  const rule = findBlockingRule({ narrationClass: speechBased });
  assert.deepEqual([...rule.blockedByClassList].sort(), [silenceBased, speechBased].sort());
});

test('지시 해설은 무발화·발화 기반·지시 해설에 막힌다', () => {
  const rule = findBlockingRule({ narrationClass: deixis });
  assert.deepEqual([...rule.blockedByClassList].sort(), [silenceBased, speechBased, deixis].sort());
});

test('화면 변화 해설은 화면 변화 해설에만 20초 간격으로 막히고, 발화 기반·지시 해설을 막지 않는다', () => {
  const rule = findBlockingRule({ narrationClass: screenChange });
  assert.deepEqual(rule.blockedByClassList, [screenChange]);
  assert.equal(SCREEN_CHANGE_MIN_INTERVAL_MS, 20000);
  assert.equal(resolveMinIntervalMs({ rule, hasPointingRegion: false }), 20000);
  for (const narrationClass of [speechBased, deixis]) {
    assert.equal(findBlockingRule({ narrationClass }).blockedByClassList.includes(screenChange), false, narrationClass);
  }
});

test('발화 기반·지시 해설 간격은 가리킨 곳이 있으면 12초, 발화만 있으면 18초다', () => {
  assert.equal(POINTED_MIN_INTERVAL_MS, 12000);
  assert.equal(SPEECH_ONLY_MIN_INTERVAL_MS, 18000);
  for (const narrationClass of [speechBased, deixis]) {
    const rule = findBlockingRule({ narrationClass });
    assert.equal(resolveMinIntervalMs({ rule, hasPointingRegion: true }), 12000, narrationClass);
    assert.equal(resolveMinIntervalMs({ rule, hasPointingRegion: false }), 18000, narrationClass);
  }
});

test('분류가 빠졌거나 모르는 분류의 해설은 지시 규칙을 따른다', () => {
  const deixisRule = findBlockingRule({ narrationClass: deixis });
  assert.equal(findBlockingRule({ narrationClass: null }), deixisRule);
  assert.equal(findBlockingRule({ narrationClass: 'unknown' }), deixisRule);
});

test('막은 해설과의 관계를 같은 분류·같은 순위·더 높은 순위로 가른다', () => {
  assert.equal(readBlockingRelation({ narrationClass: deixis, blockedByClass: deixis }), BLOCKING_RELATION_MAP.sameClass);
  assert.equal(readBlockingRelation({ narrationClass: deixis, blockedByClass: speechBased }), BLOCKING_RELATION_MAP.higherPriority);
  assert.equal(readBlockingRelation({ narrationClass: silenceBased, blockedByClass: pageTransition }), BLOCKING_RELATION_MAP.higherPriority);
  assert.equal(
    readBlockingRelation({ narrationClass: pageTransition, blockedByClass: speakerIdentity }),
    BLOCKING_RELATION_MAP.samePriority,
  );
  assert.equal(readBlockingRelation({ narrationClass: null, blockedByClass: deixis }), BLOCKING_RELATION_MAP.sameClass);
  assert.equal(
    readBlockingRelation({ narrationClass: silenceBased, blockedByClass: screenChange }),
    BLOCKING_RELATION_MAP.lowerPriority,
  );
});

test('로그에 쓸 분류·관계의 한국어 이름이 빠짐없이 있다', () => {
  assert.deepEqual(Object.keys(NARRATION_CLASS_LABEL_MAP).sort(), [...CLASS_LIST].sort());
  assert.deepEqual(Object.keys(BLOCKING_RELATION_LABEL_MAP).sort(), Object.values(BLOCKING_RELATION_MAP).sort());
});
