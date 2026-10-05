import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('같은 회의의 요약은 스크립트와 같은 폴더에 넣고 음성 파일도 복사한다', async () => {
  const { rootDir, archive } = await makeArchive();
  const meetingDir = await archive.saveScript({ sessionId: 's1', startedAt, scriptText: '스크립트' });
  const audioFilePath = path.join(rootDir, 'source.mp3');
  await writeFile(audioFilePath, Buffer.from('mp3'));
  const summaryDir = await archive.saveSummary({ sessionId: 's1', startedAt, summaryText: '요약 본문', audioFilePath });
  assert.equal(summaryDir, meetingDir);
  assert.equal(await readFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summary), 'utf8'), '요약 본문');
  assert.equal((await readFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summaryAudio))).toString(), 'mp3');
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
  const meetingList = await archive.list();
  assert.deepEqual(meetingList.map(({ id, title, hasSummary, hasScript }) => ({ id, title, hasSummary, hasScript })), [
    { id: '2026-10-05 14-30 회의', title: '오늘 회의', hasSummary: true, hasScript: true },
    { id: '2026-10-04 14-30 회의', title: '어제 회의', hasSummary: false, hasScript: true },
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
