import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createMeetingArchive, formatMeetingDirName, ARCHIVE_FILE_NAME_MAP,
} = require('../src/main/archive/meeting-archive.js');

const startedAt = new Date(2026, 9, 5, 14, 30, 12).getTime();

async function makeArchive() {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'seeon-archive-'));
  return { rootDir, archive: createMeetingArchive({ rootDir }) };
}

test('회의 폴더 이름은 시작 날짜·시각(분)이다', () => {
  assert.equal(formatMeetingDirName({ startedAt }), '2026-10-05 14-30 회의');
});

test('회의가 끝나면 대화 스크립트와 회의 정보를 날짜별 폴더에 저장한다', async () => {
  const { rootDir, archive } = await makeArchive();
  const meetingDir = await archive.saveScript({
    sessionId: 's1', startedAt, endedAt: startedAt + 60_000, title: '분기 매출', slideCount: 5, utteranceCount: 22,
    scriptText: '[00:01] 안녕하세요',
  });
  assert.equal(path.basename(meetingDir), '2026-10-05 14-30 회의');
  assert.equal(await readFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.script), 'utf8'), '[00:01] 안녕하세요');
  const meta = JSON.parse(await readFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.meta), 'utf8'));
  assert.deepEqual(meta, {
    sessionId: 's1', startedAt, endedAt: startedAt + 60_000, title: '분기 매출', slideCount: 5, utteranceCount: 22,
  });
  await rm(rootDir, { recursive: true, force: true });
});

test('요약 상태와 요약 음성을 따로 저장하고 read 가 상태를 돌려준다', async () => {
  const { rootDir, archive } = await makeArchive();
  const meetingDir = await archive.saveScript({
    sessionId: 's1', startedAt, endedAt: startedAt + 60_000, title: '분기 매출', scriptText: '스크립트',
  });
  const meetingId = path.basename(meetingDir);
  assert.equal((await archive.read({ id: meetingId })).meeting.summaryStatus, null);

  assert.equal(await archive.setSummaryStatus({ sessionId: 's1', startedAt, status: 'pending' }), meetingDir);
  const pending = await archive.read({ id: meetingId });
  assert.equal(pending.meeting.summaryStatus, 'pending');
  assert.equal(pending.meeting.title, '분기 매출');
  assert.equal(pending.meeting.endedAt, startedAt + 60_000);

  // 요약 글은 음성보다 먼저 저장한다. 글만 쓰고 음성 파일은 건드리지 않는다.
  assert.equal(await archive.saveSummary({ sessionId: 's1', startedAt, summaryText: '요약 본문' }), meetingDir);
  await archive.setSummaryStatus({ sessionId: 's1', startedAt, status: 'done' });
  const done = await archive.read({ id: meetingId });
  assert.equal(done.meeting.summaryStatus, 'done');
  assert.equal(done.summaryText, '요약 본문');
  assert.equal(await readFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summaryAudio)).catch(() => null), null);

  const audioFilePath = path.join(rootDir, 'source.mp3');
  await writeFile(audioFilePath, Buffer.from('mp3'));
  assert.equal(await archive.saveSummaryAudio({ sessionId: 's1', startedAt, audioFilePath }), meetingDir);
  assert.equal((await readFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summaryAudio))).toString(), 'mp3');

  await archive.setSummaryStatus({ sessionId: 's1', startedAt, status: 'failed' });
  assert.equal((await archive.read({ id: meetingId })).meeting.summaryStatus, 'failed');
  await assert.rejects(archive.setSummaryStatus({ sessionId: 's1', startedAt, status: 'unknown' }), RangeError);
  await rm(rootDir, { recursive: true, force: true });
});

test('meeting-archive: 시작 때 남은 pending 은 failed 로 바꾸고 다른 상태는 그대로 둔다', async () => {
  const { rootDir, archive } = await makeArchive();
  const statusBySessionMap = { a: 'pending', b: 'done', c: 'failed', d: null, e: 'pending' };
  const idBySessionMap = {};
  for (const [index, [sessionId, status]] of Object.entries(statusBySessionMap).entries()) {
    const meetingStartedAt = startedAt + index * 3_600_000;
    const meetingDir = await archive.saveScript({
      sessionId, startedAt: meetingStartedAt, endedAt: meetingStartedAt + 60_000, title: `회의 ${sessionId}`, scriptText: 'x',
    });
    if (status) await archive.setSummaryStatus({ sessionId, startedAt: meetingStartedAt, status });
    idBySessionMap[sessionId] = path.basename(meetingDir);
  }
  await writeFile(path.join(rootDir, 'stray.txt'), '폴더가 아닌 파일');

  assert.equal(await archive.failStalePendingSummary(), 2);
  const readMeeting = async (sessionId) => (await archive.read({ id: idBySessionMap[sessionId] })).meeting;
  assert.deepEqual(
    await Promise.all(Object.keys(statusBySessionMap).map(async (sessionId) => (await readMeeting(sessionId)).summaryStatus)),
    ['failed', 'done', 'failed', null, 'failed'],
  );
  const changed = await readMeeting('a');
  assert.equal(changed.title, '회의 a', '제목·끝 시각은 그대로');
  assert.equal(changed.endedAt, startedAt + 60_000);
  assert.equal(await archive.failStalePendingSummary(), 0, '다시 불러도 바꿀 것이 없다');
  await rm(rootDir, { recursive: true, force: true });
});

test('meeting-archive: 한 회의의 요약 상태를 바꾸지 못해도 나머지 회의는 계속 바꾼다', async (t) => {
  const { rootDir, archive } = await makeArchive();
  const idBySessionMap = {};
  for (const [index, sessionId] of ['a', 'b', 'c'].entries()) {
    const meetingStartedAt = startedAt + index * 3_600_000;
    const meetingDir = await archive.saveScript({ sessionId, startedAt: meetingStartedAt, scriptText: 'x' });
    await archive.setSummaryStatus({ sessionId, startedAt: meetingStartedAt, status: 'pending' });
    idBySessionMap[sessionId] = path.basename(meetingDir);
  }
  const originalWriteFile = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', async (filePath, ...argList) => {
    if (String(filePath).includes(idBySessionMap.b)) throw new Error('쓰기 권한 없음');
    return originalWriteFile.call(fs.promises, filePath, ...argList);
  });
  const warn = t.mock.method(console, 'warn', () => {});

  assert.equal(await archive.failStalePendingSummary(), 2);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /쓰기 권한 없음/);
  t.mock.restoreAll();
  const readStatus = async (sessionId) => (await archive.read({ id: idBySessionMap[sessionId] })).meeting.summaryStatus;
  assert.deepEqual([await readStatus('a'), await readStatus('b'), await readStatus('c')], ['failed', 'pending', 'failed']);
  await rm(rootDir, { recursive: true, force: true });
});

test('같은 분에 시작한 다른 회의는 번호를 붙여 따로 저장한다', async () => {
  const { rootDir, archive } = await makeArchive();
  await archive.saveScript({ sessionId: 's1', startedAt, scriptText: 'a' });
  const secondDir = await archive.saveScript({ sessionId: 's2', startedAt: startedAt + 20_000, scriptText: 'b' });
  assert.equal(path.basename(secondDir), '2026-10-05 14-30 회의 (2)');
  assert.deepEqual((await readdir(rootDir)).sort(), ['2026-10-05 14-30 회의', '2026-10-05 14-30 회의 (2)']);
  await rm(rootDir, { recursive: true, force: true });
});

test('지난 회의 목록은 최신 회의부터, 요약·스크립트가 있는지와 함께 돌려준다', async () => {
  const { rootDir, archive } = await makeArchive();
  await archive.saveScript({ sessionId: 'old', startedAt: startedAt - 86_400_000, title: '어제 회의', scriptText: 'x' });
  await archive.saveScript({ sessionId: 'new', startedAt, title: '오늘 회의', scriptText: 'y' });
  await archive.saveSummary({ sessionId: 'new', startedAt, summaryText: '요약' });
  await archive.setSummaryStatus({ sessionId: 'new', startedAt, status: 'done' });
  await archive.saveScript({ sessionId: 'making', startedAt: startedAt - 3_600_000, title: '만드는 중', scriptText: 'z' });
  await archive.setSummaryStatus({ sessionId: 'making', startedAt: startedAt - 3_600_000, status: 'pending' });
  const meetingList = await archive.list();
  assert.deepEqual(meetingList.map(({ id, title, hasSummary, hasScript, summaryStatus }) => ({
    id, title, hasSummary, hasScript, summaryStatus,
  })), [
    { id: '2026-10-05 14-30 회의', title: '오늘 회의', hasSummary: true, hasScript: true, summaryStatus: 'done' },
    { id: '2026-10-05 13-30 회의', title: '만드는 중', hasSummary: false, hasScript: true, summaryStatus: 'pending' },
    { id: '2026-10-04 14-30 회의', title: '어제 회의', hasSummary: false, hasScript: true, summaryStatus: null },
  ]);
  await rm(rootDir, { recursive: true, force: true });
});

test('기록 폴더가 아직 없으면 빈 목록이다', async () => {
  const archive = createMeetingArchive({ rootDir: path.join(tmpdir(), `seeon-archive-none-${Date.now()}`) });
  assert.deepEqual(await archive.list(), []);
});

test('회의 하나를 읽으면 요약과 스크립트를 돌려주고, 없는 파일은 빈 문자열이다', async () => {
  const { rootDir, archive } = await makeArchive();
  await archive.saveScript({ sessionId: 's1', startedAt, title: '분기 매출', scriptText: '스크립트 본문' });
  const result = await archive.read({ id: '2026-10-05 14-30 회의' });
  assert.equal(result.isOk, true);
  assert.equal(result.meeting.title, '분기 매출');
  assert.equal(result.scriptText, '스크립트 본문');
  assert.equal(result.summaryText, '');
  await rm(rootDir, { recursive: true, force: true });
});

test('기록 폴더 밖을 가리키는 id 는 읽지 않는다', async () => {
  const { rootDir, archive } = await makeArchive();
  for (const id of ['../etc', '..', 'a/b', '', '.hidden']) {
    assert.equal((await archive.read({ id })).isOk, false, id);
  }
  await rm(rootDir, { recursive: true, force: true });
});

const { pickMeetingTitle } = require('../src/main/archive/meeting-archive.js');

test('회의 제목은 앞쪽 슬라이드 제목(라벨 제목, 없으면 화면 주제) 두 개를 잇는다', () => {
  assert.equal(pickMeetingTitle({ snapshot: { slideList: [
    { major: 1, label: { title: '분기 매출' } },
    { major: 2, pageTopic: '채용 계획' },
    { major: 3, label: { title: '분기 매출' } },
    { major: 4, pageTopic: '복지' },
  ] } }), '분기 매출 · 채용 계획');
  assert.equal(pickMeetingTitle({ snapshot: { slideList: [] } }), '');
  assert.equal(pickMeetingTitle({ snapshot: null }), '');
});
