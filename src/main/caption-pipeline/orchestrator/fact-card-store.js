// 새 슬라이드(major)마다 화면 사실 카드를 한 번 만들어 두고, 해설 순간 수치·척도(·지시) 에이전트가 골라 쓴다.
// 카드 만들기(VLM 이미지 호출)는 동시에 하나만 돈다. 도는 중에 새 장이 오면 가장 최근 장만 기다리게 하고 밀려난 장은 건너뛴다
// — 슬라이드를 빨리 넘기는 회의에서 스쳐 간 장의 카드까지 만들면 전환 고지·라벨 같은 다른 호출이 시간 초과로 빠진다.
const { INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const { SLIDE_TEXT_STATUS_MAP } = require('./slide-text-store');
const { isValuePresent, VALUE_PRESENCE_VERDICT_MAP } = require('./value-presence');

const FACT_CARD_STATUS_MAP = {
  missing: 'missing',
  pending: 'pending',
  ready: 'ready',
  none: 'none',
  failed: 'failed',
  skipped: 'skipped',
};
// 실패·건너뛴 장은 그 장으로 돌아왔을 때 한 번만 다시 만든다. 실패한 그 자리에서는 다시 묻지 않는다(GPU 부담).
const FACT_CARD_RETRYABLE_STATUS_LIST = [FACT_CARD_STATUS_MAP.failed, FACT_CARD_STATUS_MAP.skipped];
const FACT_CARD_RETRY_LIMIT = 1;
const FACT_CARD_VERIFY_SOURCE_NONE = 'none';

function toMajorKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

// 값 존재 검사와 같은 숫자 대조(천 단위 쉼표 무시, 앞뒤가 다른 숫자로 이어지면 다른 값)로 카드 값을 전사 글자와 맞춘다.
// verified: true(전사에 있음) · false(없어서 비움) · null(숫자가 없거나 전사를 못 써서 검사하지 않음)
function checkFactValue({ value, slideText, canVerify }) {
  if (!value || !canVerify) return { value, verified: null };
  const { verdict } = isValuePresent({
    value, slideText, slideTextStatus: SLIDE_TEXT_STATUS_MAP.ready, subKind: INTERPRETATION_KIND_MAP.claimToValue,
  });
  if (verdict === VALUE_PRESENCE_VERDICT_MAP.unchecked) return { value, verified: null };
  if (verdict === VALUE_PRESENCE_VERDICT_MAP.present) return { value, verified: true };
  return { value: '', verified: false };
}

// 카드의 숫자(항목 값·축 눈금·기간)는 같은 장의 전사 글자에 있을 때만 남긴다. 전사가 "글자 없음"이면 숫자 값은 모두 지어낸 것으로 본다.
// 전사가 실패했거나 아직이면 값을 두고 확인 안 됨으로 둔다. 카드 글자는 값 존재 검사의 대조 원본에 넣지 않는다(같은 출처끼리 확인하는 순환).
function verifyFactCardValues({ cardList = [], slideText }) {
  const status = slideText?.status;
  const canVerify = status === SLIDE_TEXT_STATUS_MAP.ready || status === SLIDE_TEXT_STATUS_MAP.none;
  const text = status === SLIDE_TEXT_STATUS_MAP.ready ? String(slideText.text || '') : '';
  let checkedValueCount = 0;
  let droppedValueCount = 0;
  const verifiedList = cardList.map((card) => {
    let cardDroppedCount = 0;
    const check = (value) => {
      const result = checkFactValue({ value, slideText: text, canVerify });
      if (result.verified !== null) checkedValueCount += 1;
      if (result.verified === false) cardDroppedCount += 1;
      return result;
    };
    const itemList = card.itemList.map((item) => {
      const { value, verified } = check(item.value);
      return { ...item, value, isValueVerified: verified };
    });
    const axisList = card.axisList.map((axis) => ({ ...axis, from: check(axis.from).value, to: check(axis.to).value }));
    const period = check(card.period).value;
    droppedValueCount += cardDroppedCount;
    return { ...card, period, axisList, itemList, droppedValueCount: cardDroppedCount };
  });
  return { cardList: verifiedList, checkedValueCount, droppedValueCount };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// build: 그림 한 장 → { screenTitle, cardList, isTruncated, rawLength, jsonMode } (fact-card-agent)
// slideTextStore: 값 검증에 쓸 같은 장의 전사. readSlideTextSource: 그 전사를 읽은 엔진(ocr·vlm, 기록용).
function createFactCardStore({ build, slideTextStore, readSlideTextSource = () => null, isEnabled = () => true,
  onSettled = () => {}, now = Date.now }) {
  let entryByKeyMap = new Map();
  // 세션이 바뀌면 올린다. 앞 세션의 늦은 결과가 새 세션의 같은 번호 장에 붙지 않게 한다.
  let generation = 0;
  // 세션을 넘어도 유지한다 — 앞 세션의 호출이 끝나기 전에 새 호출을 겹쳐 부르지 않는다.
  let isBuilding = false;
  let queuedEntry = null;

  function settle(entry, patch) {
    if (entry.generation === generation) {
      Object.assign(entry, patch);
      onSettled({
        slideLabel: entry.key, status: entry.status, frameTs: entry.frameTs, isRetry: entry.isRetry,
        screenTitle: entry.screenTitle, cardList: entry.cardList, verify: entry.verify,
        elapsedMs: entry.elapsedMs, queuedMs: entry.queuedMs, rawLength: entry.rawLength,
        jsonMode: entry.jsonMode, isTruncated: entry.isTruncated, errorMessage: entry.errorMessage,
      });
    }
    entry.settled.resolve();
  }

  async function finishBuilt({ entry, built }) {
    const cardList = (built.cardList || []).map((card, index) => ({ ...card, id: `${entry.key}:${index + 1}` }));
    const base = {
      screenTitle: built.screenTitle || '', rawLength: built.rawLength ?? null,
      jsonMode: built.jsonMode ?? null, isTruncated: Boolean(built.isTruncated),
    };
    if (!cardList.length) {
      settle(entry, {
        ...base, status: FACT_CARD_STATUS_MAP.none, cardList: [],
        verify: { source: FACT_CARD_VERIFY_SOURCE_NONE, slideTextStatus: null, checkedValueCount: 0, droppedValueCount: 0 },
      });
      return;
    }
    // 전사는 카드와 같은 순간에 나란히 시작했으므로 대개 먼저 끝나 있다.
    await slideTextStore.waitFor(entry.key);
    const slideText = slideTextStore.get(entry.key);
    const verified = verifyFactCardValues({ cardList, slideText });
    const slideTextSource = readSlideTextSource(entry.key);
    settle(entry, {
      ...base, status: FACT_CARD_STATUS_MAP.ready, cardList: verified.cardList,
      verify: {
        source: slideTextSource ? `slide_text_${slideTextSource}` : FACT_CARD_VERIFY_SOURCE_NONE,
        slideTextStatus: slideText?.status ?? null,
        checkedValueCount: verified.checkedValueCount, droppedValueCount: verified.droppedValueCount,
      },
    });
  }

  function runNext() {
    isBuilding = false;
    const next = queuedEntry;
    queuedEntry = null;
    if (next) run(next);
  }

  function run(entry) {
    isBuilding = true;
    const { jpegBuffer } = entry;
    entry.jpegBuffer = null;
    const startedAt = now();
    entry.queuedMs = startedAt - entry.frameTs;
    Promise.resolve()
      .then(() => build({ jpegBuffer }))
      .then(
        (built) => {
          entry.elapsedMs = now() - startedAt;
          runNext();
          if (entry.generation !== generation) return entry.settled.resolve();
          return finishBuilt({ entry, built });
        },
        (error) => {
          entry.elapsedMs = now() - startedAt;
          runNext();
          settle(entry, { status: FACT_CARD_STATUS_MAP.failed, errorMessage: error?.message || String(error) });
        },
      )
      .catch((error) => settle(entry, { status: FACT_CARD_STATUS_MAP.failed, errorMessage: error?.message || String(error) }));
  }

  function enqueue(entry) {
    if (!isBuilding) {
      run(entry);
      return;
    }
    if (queuedEntry) {
      const skippedEntry = queuedEntry;
      settle(skippedEntry, { status: FACT_CARD_STATUS_MAP.skipped, jpegBuffer: null, queuedMs: now() - skippedEntry.frameTs });
    }
    queuedEntry = entry;
  }

  // 새 장이면 만들기를 건다. isRetry 는 복귀 때 실패·건너뛴 장을 한 번 다시 만들 때만 준다.
  function ensure({ slideLabel, jpegBuffer, isRetry = false }) {
    if (!isEnabled()) return false;
    const key = toMajorKey(slideLabel);
    if (!key || !jpegBuffer) return false;
    const existing = entryByKeyMap.get(key);
    if (existing) {
      if (!isRetry || !FACT_CARD_RETRYABLE_STATUS_LIST.includes(existing.status)
        || existing.retryCount >= FACT_CARD_RETRY_LIMIT) return false;
    } else if (isRetry) {
      return false;
    }
    const entry = {
      key, generation, status: FACT_CARD_STATUS_MAP.pending, isRetry, retryCount: existing ? existing.retryCount + 1 : 0,
      frameTs: now(), jpegBuffer, screenTitle: '', cardList: [], verify: null, elapsedMs: null, queuedMs: null,
      rawLength: null, jsonMode: null, isTruncated: false, errorMessage: '', settled: createDeferred(),
    };
    entryByKeyMap.set(key, entry);
    enqueue(entry);
    return true;
  }

  function get(slideLabel) {
    const major = toMajorKey(slideLabel);
    const entry = entryByKeyMap.get(major);
    if (!entry) return { status: FACT_CARD_STATUS_MAP.missing, major, screenTitle: '', cardList: [], frameTs: null };
    return {
      status: entry.status, major, screenTitle: entry.screenTitle, cardList: entry.cardList, frameTs: entry.frameTs,
    };
  }

  // 만드는 중이면 카드가 끝나거나 untilPromise(같은 프레임 OCR 대기)가 끝날 때까지만 기다린다. untilPromise 가 없으면 기다리지 않는다.
  async function waitUntil({ slideLabel, untilPromise = null }) {
    const startedAt = now();
    const entry = entryByKeyMap.get(toMajorKey(slideLabel));
    if (entry?.status === FACT_CARD_STATUS_MAP.pending && untilPromise) {
      await Promise.race([entry.settled.promise, Promise.resolve(untilPromise).catch(() => {})]);
    }
    return { ...get(slideLabel), waitedMs: now() - startedAt };
  }

  function reset() {
    generation += 1;
    if (queuedEntry) queuedEntry.settled.resolve();
    queuedEntry = null;
    entryByKeyMap = new Map();
  }

  return { ensure, get, waitUntil, reset };
}

module.exports = {
  createFactCardStore, verifyFactCardValues, FACT_CARD_STATUS_MAP, FACT_CARD_RETRY_LIMIT,
};
