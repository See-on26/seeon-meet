import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSummaryGenerator } = require('../src/main/summary/summary-generator.js');
const { registerSummary } = require('../src/main/summary/index.js');
const { createMeetingArchive } = require('../src/main/archive/meeting-archive.js');
const { TRUNCATED_NOTICE } = require('../src/main/summary/summary-document.js');

// 생성기의 단계별 로그·경고가 시험 출력에 섞이지 않게 막는다.
beforeEach(() => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});
afterEach(() => mock.restoreAll());

const VISIT_MS = 60000;
const MAJOR_LIST = [1, 2, 3, 4];
const nextTick = () => new Promise((resolve) => { setImmediate(resolve); });

async function waitFor(predicate) {
  for (let count = 0; count < 200 && !predicate(); count += 1) await nextTick();
  assert.ok(predicate(), '기다린 조건이 끝내 참이 되지 않았다');
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 슬라이드 1~4 를 1분씩 차례로 보고, 마지막 슬라이드를 보던 중(4분)에 회의가 끝났다.
function buildSnapshot({ segmentSummaryList = [], qaList = [], majorList = MAJOR_LIST } = {}) {
  return {
    sessionId: 'session-1',
    startedAt: 0,
    slideList: majorList.map((major) => ({
      major, displayNumber: major, hasTransition: true,
      visitList: [{ startTs: (major - 1) * VISIT_MS, endTs: major === majorList.at(-1) ? null : major * VISIT_MS }],
    })),
    transitionList: majorList.map((major) => ({
      ts: (major - 1) * VISIT_MS + 1000, slideMajor: major, text: `슬라이드 ${major}: 화면 ${major}`,
    })),
    utteranceList: majorList.map((major) => ({
      ts: (major - 1) * VISIT_MS + 2000, text: `말 ${major}`, speakerHint: '김지오',
    })),
    narrationList: [],
    qaList,
    cancelledTransitionList: [],
    segmentSummaryList,
  };
}

function buildSession({ captionLanguage = 'ko', slideMarkList = [], majorList = MAJOR_LIST } = {}) {
  return {
    sessionId: 'session-1', startedAt: 0, endedAt: majorList.length * VISIT_MS, captionLanguage,
    asrEntryList: majorList.map((major) => ({ ts: (major - 1) * VISIT_MS + 2000, text: `말 ${major}`, speakerHint: '김지오' })),
    slideMarkList,
  };
}

// 회의 중에 슬라이드 1 은 요약을 마쳤고, 2 는 실패, 3 은 요청만 한 채 회의가 끝났다. 4 는 아직 요청 전이다.
const STORED_SEGMENT_LIST = [
  { key: '1@0', slideMajor: 1, startTs: 0, endTs: VISIT_MS, isRevisit: false, text: '첫 화면 요약.', status: 'ready' },
  { key: '2@60000', slideMajor: 2, startTs: VISIT_MS, endTs: 2 * VISIT_MS, isRevisit: false, text: '', status: 'failed' },
  { key: '3@120000', slideMajor: 3, startTs: 2 * VISIT_MS, endTs: 3 * VISIT_MS, isRevisit: false, text: '', status: 'requested' },
];

// 부른 순서를 callList 에 남기는 가짜 에이전트·TTS. 구간 요약은 재료의 슬라이드 번호로 글을 만든다.
function makeFakeSet({ segmentText = null, summaryError = null, summaryTruncated = false } = {}) {
  const callList = [];
  return {
    callList,
    recaptionAgent: {
      generate: async ({ slideMajor }) => {
        callList.push({ name: 'recaption', slideMajor });
        return { title: '분기 매출 표', bodyText: '' };
      },
    },
    segmentSummaryAgent: {
      summarize: async ({ materialText, language }) => {
        callList.push({ name: 'segment', materialText, language });
        if (segmentText) return segmentText({ materialText });
        const major = materialText.match(/화면: 슬라이드 (\d+)/)?.[1];
        return { text: `슬라이드 ${major} 새 요약.` };
      },
    },
    summaryAgent: {
      summarize: async ({ integrationText, language }) => {
        callList.push({ name: 'summarize', integrationText, language });
        if (summaryError) throw summaryError;
        return { text: '초안.', isTruncated: summaryTruncated };
      },
    },
    rewriteAgent: {
      rewrite: async ({ draftText, isTruncated, language }) => {
        callList.push({ name: 'rewrite', draftText, isTruncated, language });
        return { text: '듣는 글 본문.', isTruncated: false, isRewritten: true };
      },
    },
    ttsClient: {
      synthesizeLong: async ({ text, language }) => {
        callList.push({ name: 'speak', text, language });
        return Buffer.from('mp3');
      },
    },
  };
}

function makeGenerator({ summariesDir, fakeSet, ...optionMap }) {
  const { callList, ...agentMap } = fakeSet;
  return createSummaryGenerator({ config: {}, summariesDir, ...agentMap, ...optionMap });
}

const listCallName = (callList) => callList.map((call) => call.name);

test('generateText: Store 에 없는 구간만 채우고 통합·재작성을 한 번씩 부른다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  const fakeSet = makeFakeSet();
  const generator = makeGenerator({ summariesDir, fakeSet });
  const result = await generator.generateText({
    session: buildSession(), contextSnapshot: buildSnapshot({ segmentSummaryList: STORED_SEGMENT_LIST }),
  });

  // ready 인 슬라이드 1 은 다시 만들지 않고, failed·requested·없음(2·3·4)은 구간 순서대로 만든다.
  const segmentCallList = fakeSet.callList.filter((call) => call.name === 'segment');
  assert.deepEqual(segmentCallList.map((call) => call.materialText.match(/화면: (슬라이드 \d+)/)[1]),
    ['슬라이드 2', '슬라이드 3', '슬라이드 4']);
  assert.ok(segmentCallList.every((call) => call.language === 'ko'));
  assert.deepEqual(listCallName(fakeSet.callList), ['segment', 'segment', 'segment', 'summarize', 'rewrite']);

  const [summarizeCall] = fakeSet.callList.filter((call) => call.name === 'summarize');
  assert.equal(summarizeCall.integrationText, [
    '[00:00~01:00] 슬라이드 1 — 슬라이드 1: 화면 1\n첫 화면 요약.',
    '[01:00~02:00] 슬라이드 2 — 슬라이드 2: 화면 2\n슬라이드 2 새 요약.',
    '[02:00~03:00] 슬라이드 3 — 슬라이드 3: 화면 3\n슬라이드 3 새 요약.',
    '[03:00~04:00] 슬라이드 4 — 슬라이드 4: 화면 4\n슬라이드 4 새 요약.',
  ].join('\n\n'));
  const [rewriteCall] = fakeSet.callList.filter((call) => call.name === 'rewrite');
  assert.equal(rewriteCall.draftText, '초안.');

  assert.equal(result.isOk, true);
  assert.equal(result.isTruncated, false);
  assert.equal(result.slideCount, 4);
  assert.match(result.documentText, /^회의 요약\n/);
  assert.match(result.documentText, /\n듣는 글 본문\.\n$/);
  assert.equal(fs.readFileSync(result.textFilePath, 'utf8'), result.documentText);
  assert.equal('audioFilePath' in result, false);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: Store 의 ready 구간도 시작·끝 시각이 지금 계산한 구간과 다르면 다시 만든다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  // 회의 중에는 슬라이드 1 이 30초에 닫힌 것으로 요약했지만, 지금 계산하면 1분까지다.
  const storedList = [
    { ...STORED_SEGMENT_LIST[0], endTs: 30000, text: '앞 조각만 담은 요약.' },
    { key: '2@60000', slideMajor: 2, startTs: VISIT_MS, endTs: 2 * VISIT_MS, isRevisit: false, text: '둘째 화면 요약.', status: 'ready' },
  ];
  const fakeSet = makeFakeSet();
  await makeGenerator({ summariesDir, fakeSet }).generateText({
    session: buildSession(), contextSnapshot: buildSnapshot({ segmentSummaryList: storedList }),
  });
  const segmentCallList = fakeSet.callList.filter((call) => call.name === 'segment');
  assert.deepEqual(segmentCallList.map((call) => call.materialText.match(/화면: (슬라이드 \d+)/)[1]),
    ['슬라이드 1', '슬라이드 3', '슬라이드 4']);
  const [summarizeCall] = fakeSet.callList.filter((call) => call.name === 'summarize');
  assert.ok(!summarizeCall.integrationText.includes('앞 조각만 담은 요약.'));
  assert.ok(summarizeCall.integrationText.includes('둘째 화면 요약.'));
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 요약이 잘렸으면 재작성이 잘림을 놓쳐도 문서에 잘림 안내를 단다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  const fakeSet = makeFakeSet({ summaryTruncated: true });
  const result = await makeGenerator({ summariesDir, fakeSet }).generateText({
    session: buildSession(), contextSnapshot: buildSnapshot(),
  });
  assert.equal(result.isTruncated, true);
  assert.match(result.documentText, new RegExp(`${TRUNCATED_NOTICE}\n$`));
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 구간 요약이 모두 비면 통합을 부르지 않는다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  // 실패한 구간 없이 GPU 가 모든 구간을 담을 내용이 없다고 답했다.
  const fakeSet = makeFakeSet({ segmentText: () => ({ text: '' }) });
  const generator = makeGenerator({ summariesDir, fakeSet });
  const result = await generator.generateText({ session: buildSession(), contextSnapshot: buildSnapshot() });
  assert.deepEqual(listCallName(fakeSet.callList), ['segment', 'segment', 'segment', 'segment']);
  assert.equal(result.isOk, true);
  assert.equal(result.isTruncated, false);
  assert.match(result.documentText, /\n\n회의에서 요약할 만한 말과 화면 기록이 없어요\n$/);
  assert.equal(fs.readFileSync(result.textFilePath, 'utf8'), result.documentText);

  const englishFakeSet = makeFakeSet({ segmentText: () => ({ text: '' }) });
  const englishResult = await makeGenerator({ summariesDir, fakeSet: englishFakeSet }).generateText({
    session: buildSession({ captionLanguage: 'en' }), contextSnapshot: buildSnapshot(),
  });
  assert.match(englishResult.documentText, /^Meeting summary\n/);
  assert.match(englishResult.documentText, /\n\nThere was no speech or screen record to summarize\n$/);
  assert.ok(!listCallName(englishFakeSet.callList).includes('summarize'));
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 구간 요약이 모두 실패하면 던진다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  // 슬라이드 1 은 회의 중에 빈 구간으로 끝났고, 회의 뒤에는 실패·빈 구간·실패다. 글이 있는 구간이 없다.
  const storedList = [{ ...STORED_SEGMENT_LIST[0], text: '' }];
  let callCount = 0;
  const fakeSet = makeFakeSet({
    segmentText: () => {
      callCount += 1;
      if (callCount === 2) return { text: '' };
      throw new Error('GPU 시간 초과');
    },
  });
  await assert.rejects(
    makeGenerator({ summariesDir, fakeSet }).generateText({
      session: buildSession(), contextSnapshot: buildSnapshot({ segmentSummaryList: storedList }),
    }),
    /구간 요약 2개가 실패.*GPU 시간 초과/,
  );
  assert.deepEqual(listCallName(fakeSet.callList), ['segment', 'segment', 'segment'], '통합·재작성을 부르지 않는다');
  assert.deepEqual(fs.readdirSync(summariesDir), [], '요약 문서를 쓰지 않는다');
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 일부 구간만 실패하면 경고를 남기고 나머지로 통합한다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  const fakeSet = makeFakeSet({
    segmentText: ({ materialText }) => {
      if (materialText.includes('화면: 슬라이드 2')) throw new Error('GPU 시간 초과');
      return { text: `${materialText.match(/화면: (슬라이드 \d+)/)[1]} 요약.` };
    },
  });
  const result = await makeGenerator({ summariesDir, fakeSet }).generateText({
    session: buildSession(), contextSnapshot: buildSnapshot(),
  });
  assert.equal(result.isOk, true);
  const [summarizeCall] = fakeSet.callList.filter((call) => call.name === 'summarize');
  assert.ok(!summarizeCall.integrationText.includes('슬라이드 2 요약.'));
  assert.ok(summarizeCall.integrationText.includes('슬라이드 3 요약.'));
  const warnTextList = console.warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(warnTextList.some((text) => /구간 요약 4개 가운데 1개가 실패/.test(text)), warnTextList.join('\n'));
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 연속 3번 실패하면 나머지를 묻지 않고 던진다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  // 슬라이드 1 은 회의 중에 요약을 마쳤다. 회의 뒤 슬라이드 2·3·4 가 잇달아 실패하면 5·6 은 묻지 않는다.
  const majorList = [1, 2, 3, 4, 5, 6];
  const fakeSet = makeFakeSet({ segmentText: () => { throw new Error('GPU 응답 없음'); } });
  await assert.rejects(
    makeGenerator({ summariesDir, fakeSet }).generateText({
      session: buildSession({ majorList }),
      contextSnapshot: buildSnapshot({ majorList, segmentSummaryList: [STORED_SEGMENT_LIST[0]] }),
    }),
    /연속 3개.*GPU 응답 없음/,
  );
  const segmentCallList = fakeSet.callList.filter((call) => call.name === 'segment');
  assert.deepEqual(segmentCallList.map((call) => call.materialText.match(/화면: (슬라이드 \d+)/)[1]),
    ['슬라이드 2', '슬라이드 3', '슬라이드 4']);
  assert.deepEqual(listCallName(fakeSet.callList), ['segment', 'segment', 'segment']);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 재료가 없는 구간은 GPU 에 묻지 않고 빈 구간으로 둔다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  // 슬라이드 3 을 보는 동안에는 말도 해설도 질문도 없었고, 화면 정보도 없다.
  const snapshot = buildSnapshot();
  snapshot.utteranceList = snapshot.utteranceList.filter((utterance) => !utterance.text.endsWith('3'));
  const fakeSet = makeFakeSet();
  await makeGenerator({ summariesDir, fakeSet }).generateText({ session: buildSession(), contextSnapshot: snapshot });
  const segmentCallList = fakeSet.callList.filter((call) => call.name === 'segment');
  assert.deepEqual(segmentCallList.map((call) => call.materialText.match(/화면: (슬라이드 \d+)/)[1]),
    ['슬라이드 1', '슬라이드 2', '슬라이드 4']);
  const [summarizeCall] = fakeSet.callList.filter((call) => call.name === 'summarize');
  assert.ok(!summarizeCall.integrationText.includes('슬라이드 3'), summarizeCall.integrationText);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 전환 해설이 없던 화면은 회의 뒤 텍스트화한 한 줄을 구간 재료에 넣는다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  const slideFilePath = path.join(summariesDir, 'slide-1.jpg');
  fs.writeFileSync(slideFilePath, Buffer.from('jpeg'));
  const snapshot = buildSnapshot();
  snapshot.slideList[0].hasTransition = false;
  snapshot.transitionList = snapshot.transitionList.filter((transition) => transition.slideMajor !== 1);
  const fakeSet = makeFakeSet();
  await makeGenerator({ summariesDir, fakeSet }).generateText({
    session: buildSession({ slideMarkList: [{ ts: 0, slideLabel: '1', frameKind: 'base', filePath: slideFilePath }] }),
    contextSnapshot: snapshot,
  });
  assert.deepEqual(fakeSet.callList.filter((call) => call.name === 'recaption').map((call) => call.slideMajor), ['1']);
  const firstSegmentCall = fakeSet.callList.find((call) => call.name === 'segment');
  assert.match(firstSegmentCall.materialText, /^화면: 슬라이드 1\n화면 설명: 분기 매출 표$/m);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 화면 정보 텍스트화는 다시 만들 구간의 묘사·라벨 없는 화면만 배경 순위로 한다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  const slideMarkList = [1, 2, 3].map((major) => {
    const filePath = path.join(summariesDir, `slide-${major}.jpg`);
    fs.writeFileSync(filePath, Buffer.from('jpeg'));
    return { ts: (major - 1) * VISIT_MS, slideLabel: String(major), frameKind: 'base', filePath };
  });
  // 슬라이드 1~3 은 전환 고지가 없었다. 1 은 회의 중에 구간 요약을 마쳤고, 2 는 라벨이 있다.
  const snapshot = buildSnapshot({ segmentSummaryList: [STORED_SEGMENT_LIST[0]] });
  for (const slide of snapshot.slideList.slice(0, 3)) slide.hasTransition = false;
  snapshot.slideList[1].label = { title: '채용 계획', keywordList: [], summary: '' };
  snapshot.transitionList = snapshot.transitionList.filter((transition) => transition.slideMajor === 4);
  const fakeSet = makeFakeSet();
  const vlmTraffic = {
    runBackground: async (task) => {
      fakeSet.callList.push({ name: 'background' });
      return task();
    },
  };
  await makeGenerator({ summariesDir, fakeSet, vlmTraffic }).generateText({
    session: buildSession({ slideMarkList }), contextSnapshot: snapshot,
  });
  assert.deepEqual(fakeSet.callList.filter((call) => call.name === 'recaption').map((call) => call.slideMajor), ['3']);
  assert.deepEqual(listCallName(fakeSet.callList).slice(0, 2), ['background', 'recaption'], '배경 순위 안에서 텍스트화한다');
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateText: 스크립트 파일은 스크립트 전문이다(── 줄 없음)', async () => {
  const summariesDir = makeTempDir('summary-background-');
  const fakeSet = makeFakeSet();
  const result = await makeGenerator({ summariesDir, fakeSet }).generateText({
    session: buildSession(),
    contextSnapshot: buildSnapshot({ qaList: [{ ts: 70000, question: '매출은요?', answer: '두 배입니다.', route: 'screen', slideMajorList: [2] }] }),
  });
  const scriptFilePath = result.textFilePath.replace(/\.txt$/, '-script.txt');
  const scriptText = fs.readFileSync(scriptFilePath, 'utf8');
  assert.equal(scriptText, [
    '[00:02] 김지오: 말 1',
    '[01:02] 김지오: 말 2',
    '[01:10] 사용자 질문: 매출은요?',
    '[01:10] SEEON 답: 두 배입니다.',
    '[02:02] 김지오: 말 3',
    '[03:02] 김지오: 말 4',
  ].join('\n'));
  assert.doesNotMatch(scriptText, /──/);
  assert.equal(result.scriptText, scriptText);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

test('generateAudio: 회의가 진행 중이면 기다렸다가 한 번만 합성한다', async () => {
  const summariesDir = makeTempDir('summary-background-');
  const eventList = [];
  const liveAnswerList = [true, true, false];
  const fakeSet = makeFakeSet();
  fakeSet.ttsClient = {
    synthesizeLong: async ({ text, language }) => {
      eventList.push(`speak:${language}:${text}`);
      return Buffer.from('mp3');
    },
  };
  const generator = makeGenerator({
    summariesDir,
    fakeSet,
    isMeetingLive: () => {
      const isLive = liveAnswerList.shift();
      eventList.push(`live:${isLive}`);
      return isLive;
    },
    sleep: async (ms) => { eventList.push(`sleep:${ms}`); },
  });
  const audioFilePath = await generator.generateAudio({ sessionId: 'session-1', documentText: '요약 글', language: 'ko' });
  assert.deepEqual(eventList, ['live:true', 'sleep:5000', 'live:true', 'sleep:5000', 'live:false', 'speak:ko:요약 글']);
  assert.equal(audioFilePath, path.join(summariesDir, 'summary-session-1.mp3'));
  assert.equal(fs.readFileSync(audioFilePath, 'utf8'), 'mp3');

  // 합성에 실패하면 null 이다(요약 글은 이미 저장돼 있다).
  const failingSet = makeFakeSet();
  failingSet.ttsClient = { synthesizeLong: async () => { throw new Error('TTS(요약본) HTTP 503'); } };
  assert.equal(await makeGenerator({ summariesDir, fakeSet: failingSet }).generateAudio({
    sessionId: 'session-2', documentText: '요약 글', language: 'ko',
  }), null);
  fs.rmSync(summariesDir, { recursive: true, force: true });
});

// registerSummary 를 가짜 ipcMain·파이프라인 핸들·실제 회의 기록(임시 폴더)으로 띄운다.
async function startSummaryIpc({
  fakeSet, isMeetingLive = () => false, session = buildSession(), contextSnapshot = buildSnapshot(),
  archiveOverrideMap = {},
}) {
  const summariesDir = makeTempDir('summary-background-');
  const rootDir = makeTempDir('summary-background-archive-');
  const meetingArchive = { ...createMeetingArchive({ rootDir }), ...archiveOverrideMap };
  await meetingArchive.saveScript({ sessionId: session.sessionId, startedAt: session.startedAt, title: '분기 보고', scriptText: '스크립트' });
  const handlerMap = new Map();
  const progressList = [];
  registerSummary({
    ipcMain: { handle: (channel, handler) => handlerMap.set(channel, handler) },
    getViewerView: () => ({ webContents: { send: (channel, payload) => progressList.push({ channel, ...payload }) } }),
    pipelineHandle: {
      config: {},
      consumeLastSession: () => session,
      consumeLastContext: () => contextSnapshot,
      isMeetingLive,
    },
    meetingArchive,
    createGenerator: (optionMap) => makeGenerator({ ...optionMap, summariesDir, fakeSet, sleep: nextTick }),
  });
  const readMeeting = async () => {
    const [{ id }] = await meetingArchive.list();
    return meetingArchive.read({ id });
  };
  const cleanUp = () => {
    fs.rmSync(summariesDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  };
  return { handler: handlerMap.get('summary-generate'), progressList, readMeeting, cleanUp };
}

test('summary-generate 성공: 글을 먼저 돌려주고 음성은 진행 중인 회의가 끝난 뒤 저장한다', async () => {
  const fakeSet = makeFakeSet();
  let isLive = true;
  const ipc = await startSummaryIpc({ fakeSet, isMeetingLive: () => isLive });
  const result = await ipc.handler();
  assert.equal(result.isOk, true);
  assert.equal(result.sessionId, 'session-1', '렌더러가 지난 회의 창에 열린 그 회의 상세를 다시 채울 수 있게 알린다');
  assert.equal(typeof result.textFilePath, 'string');
  assert.ok(!listCallName(fakeSet.callList).includes('speak'));
  const textMeeting = await ipc.readMeeting();
  assert.equal(textMeeting.meeting.summaryStatus, 'done');
  assert.match(textMeeting.summaryText, /듣는 글 본문\./);
  assert.equal(fs.existsSync(path.join(textMeeting.meetingDir, '회의 요약.mp3')), false);

  isLive = false;
  await waitFor(() => ipc.progressList.some((progress) => progress.stage === 'audio-done'));
  assert.equal(ipc.progressList.find((progress) => progress.stage === 'audio-done').sessionId, 'session-1');
  assert.equal(listCallName(fakeSet.callList).filter((name) => name === 'speak').length, 1);
  assert.equal(fs.readFileSync(path.join(textMeeting.meetingDir, '회의 요약.mp3'), 'utf8'), 'mp3');
  ipc.cleanUp();
});

test('진행 알림은 start·done·fail·audio-done 만 보낸다', async () => {
  // 화면 정보 텍스트화·구간 채우기·통합·재작성·음성 합성 단계는 알리지 않는다.
  const fakeSet = makeFakeSet();
  const slideDir = makeTempDir('summary-background-slide-');
  const slideFilePath = path.join(slideDir, 'slide-1.jpg');
  fs.writeFileSync(slideFilePath, Buffer.from('jpeg'));
  const snapshot = buildSnapshot();
  snapshot.slideList[0].hasTransition = false;
  snapshot.transitionList = snapshot.transitionList.filter((transition) => transition.slideMajor !== 1);
  const ipc = await startSummaryIpc({
    fakeSet,
    session: buildSession({ slideMarkList: [{ ts: 0, slideLabel: '1', frameKind: 'base', filePath: slideFilePath }] }),
    contextSnapshot: snapshot,
  });
  await ipc.handler();
  await waitFor(() => ipc.progressList.some((progress) => progress.stage === 'audio-done'));
  assert.deepEqual(listCallName(fakeSet.callList),
    ['recaption', 'segment', 'segment', 'segment', 'segment', 'summarize', 'rewrite', 'speak']);
  assert.deepEqual(ipc.progressList.map((progress) => progress.stage), ['start', 'done', 'audio-done']);
  assert.ok(ipc.progressList.every((progress) => progress.channel === 'summary-progress' && progress.message));
  assert.equal(ipc.progressList[0].message, '회의 요약 생성 중입니다…');
  ipc.cleanUp();
  fs.rmSync(slideDir, { recursive: true, force: true });

  const failingIpc = await startSummaryIpc({ fakeSet: makeFakeSet({ summaryError: new Error('GPU 응답 없음') }) });
  await failingIpc.handler();
  assert.deepEqual(failingIpc.progressList.map((progress) => progress.stage), ['start', 'fail']);
  failingIpc.cleanUp();
});

test('summary-generate: 구간 요약이 모두 실패하면 failed 상태와 fail 알림', async () => {
  const fakeSet = makeFakeSet({ segmentText: () => { throw new Error('GPU 응답 없음'); } });
  const ipc = await startSummaryIpc({ fakeSet });
  const result = await ipc.handler();
  assert.equal(result.isOk, false);
  assert.match(result.message, /GPU 응답 없음/);
  const meeting = await ipc.readMeeting();
  assert.equal(meeting.meeting.summaryStatus, 'failed');
  assert.equal(meeting.summaryText, '', '"요약할 내용 없음" 문서를 남기지 않는다');
  assert.deepEqual(ipc.progressList.map((progress) => progress.stage), ['start', 'fail']);
  assert.match(ipc.progressList[1].message, /GPU 응답 없음/);
  await nextTick();
  assert.ok(!listCallName(fakeSet.callList).some((name) => ['summarize', 'rewrite', 'speak'].includes(name)));
  ipc.cleanUp();
});

test('summary-generate: 회의 기록에 요약 글을 쓰지 못하면 failed 상태와 fail 알림', async () => {
  const fakeSet = makeFakeSet();
  const ipc = await startSummaryIpc({
    fakeSet, archiveOverrideMap: { saveSummary: async () => { throw new Error('디스크 공간 부족'); } },
  });
  const result = await ipc.handler();
  assert.equal(result.isOk, false);
  assert.match(result.message, /디스크 공간 부족/);
  const meeting = await ipc.readMeeting();
  assert.equal(meeting.meeting.summaryStatus, 'failed', '지난 회의가 "요약 없음" 대신 실패를 알린다');
  // done 은 생성기가 out/summaries 에 문서를 쓴 알림(개발 기록용)이고, 회의 기록 저장 실패는 그 뒤 fail 로 알린다.
  assert.deepEqual(ipc.progressList.map((progress) => progress.stage), ['start', 'done', 'fail']);
  assert.match(ipc.progressList.at(-1).message, /디스크 공간 부족/);
  await nextTick();
  assert.ok(!listCallName(fakeSet.callList).includes('speak'), '실패로 알린 요약의 음성은 만들지 않는다');
  ipc.cleanUp();
});

test('summary-generate 실패: 상태 failed·fail 진행 알림', async () => {
  const fakeSet = makeFakeSet({ summaryError: new Error('GPU 응답 없음') });
  const ipc = await startSummaryIpc({ fakeSet });
  const result = await ipc.handler();
  assert.deepEqual(result, { isOk: false, message: 'GPU 응답 없음', sessionId: 'session-1' });
  const meeting = await ipc.readMeeting();
  assert.equal(meeting.meeting.summaryStatus, 'failed');
  assert.equal(meeting.summaryText, '');
  const failList = ipc.progressList.filter((progress) => progress.stage === 'fail');
  assert.equal(failList.length, 1);
  assert.match(failList[0].message, /GPU 응답 없음/);
  // 글을 못 만들었으니 음성도 만들지 않는다.
  await nextTick();
  assert.ok(!listCallName(fakeSet.callList).includes('speak'));
  ipc.cleanUp();
});
