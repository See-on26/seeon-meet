import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickArchiveSummaryText } from '../src/renderer/core/archive/archive-summary-text.js';
import { UI_TEXT_MAP } from '../src/renderer/core/i18n/ui-text.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('pickArchiveSummaryText: 글이 있으면 글, 없으면 pending·failed·없음 문구', () => {
  const t = (key) => key;
  assert.equal(pickArchiveSummaryText({ summaryText: '요약', summaryStatus: 'pending', t }), '요약');
  assert.equal(pickArchiveSummaryText({ summaryText: '', summaryStatus: 'pending', t }), 'archive.summaryPending');
  assert.equal(pickArchiveSummaryText({ summaryText: '', summaryStatus: 'failed', t }), 'archive.summaryFailed');
  assert.equal(pickArchiveSummaryText({ summaryText: '', summaryStatus: undefined, t }), 'archive.noSummary');
  // 회의 기록 read 는 상태가 없으면 null 을 준다. 글 쓰기만 실패한 done 도 "요약 없음"이다.
  for (const summaryStatus of [null, 'done', 'unknown', 'toString']) {
    assert.equal(pickArchiveSummaryText({ summaryText: '', summaryStatus, t }), 'archive.noSummary', String(summaryStatus));
  }
  assert.equal(pickArchiveSummaryText({ summaryText: '', summaryStatus: 'pending' }), '요약을 만드는 중이에요', '기본 번역기는 한국어');
});

test('지난 회의 상세는 스크립트가 요약보다 먼저다', () => {
  const html = readSource('src/renderer/app/index.html');
  const detailStart = html.indexOf('<section id="archiveDetail"');
  assert.ok(detailStart >= 0);
  const detailHtml = html.slice(detailStart, html.indexOf('</section>', detailStart));
  const indexList = [
    'data-ui-text="archive.scriptHeading"', 'id="archiveScript"',
    'data-ui-text="archive.summaryHeading"', 'id="archiveSummary"',
  ].map((marker) => detailHtml.indexOf(marker));
  assert.ok(indexList.every((index) => index >= 0), JSON.stringify(indexList));
  assert.deepEqual([...indexList].sort((left, right) => left - right), indexList);
});

const NEW_SUMMARY_TEXT_MAP = {
  'summary.generating': ['회의 요약 생성 중입니다…', 'Creating the meeting summary…'],
  'summary.savedText': ['회의 요약을 저장했어요 — 지난 회의에서 볼 수 있어요', 'Meeting summary saved — open it in past meetings'],
  'summary.audioSaved': ['회의 요약 음성을 저장했어요', 'Meeting summary audio saved'],
  'archive.summaryPending': ['요약을 만드는 중이에요', 'The summary is being created'],
  'archive.summaryFailed': ['요약을 만들지 못했어요', "The summary couldn't be created"],
};
const REMOVED_KEY_LIST = [
  'modal.summaryFailedTitle', 'modal.summaryFailedMessage', 'summary.savedWithAudio', 'summary.savedTextOnly',
];

test('ui-text: 새 요약 문구가 한·영 모두 있고 지운 키는 어디서도 쓰지 않는다', () => {
  for (const [key, [koText, enText]] of Object.entries(NEW_SUMMARY_TEXT_MAP)) {
    assert.equal(UI_TEXT_MAP.ko[key], koText, `ko.${key}`);
    assert.equal(UI_TEXT_MAP.en[key], enText, `en.${key}`);
  }
  for (const key of REMOVED_KEY_LIST) {
    assert.equal(Object.hasOwn(UI_TEXT_MAP.ko, key), false, `ko.${key}`);
    assert.equal(Object.hasOwn(UI_TEXT_MAP.en, key), false, `en.${key}`);
  }
  const sourceFileList = fs.readdirSync(SRC_DIR, { recursive: true })
    .filter((name) => /\.(?:m?js|html)$/.test(name));
  assert.ok(sourceFileList.length > 50, `소스 ${sourceFileList.length}개`);
  const usedList = [];
  for (const name of sourceFileList) {
    const source = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
    for (const key of REMOVED_KEY_LIST) if (source.includes(key)) usedList.push(`${name}: ${key}`);
  }
  assert.deepEqual(usedList, []);
});

// head 부터 맨 앞 칸의 닫는 줄(end) 앞까지, 곧 main.js 의 최상위 블록 하나를 읽는다.
function readBlockSource(source, { head, end }) {
  const start = source.indexOf(head);
  assert.ok(start >= 0, head);
  return source.slice(start, source.indexOf(end, start));
}

test('회의 요약은 창을 띄우지 않고 고지 줄로 알리며, 진행 알림은 음성 저장만 고지 줄에 낸다', () => {
  const source = readSource('src/renderer/app/main.js');
  const requestSource = readBlockSource(source, { head: 'async function requestMeetingSummary(', end: '\n}\n' });
  assert.equal(requestSource.includes('showModal('), false);
  const generatingIndex = requestSource.indexOf("showNotice(t('summary.generating'));");
  assert.ok(generatingIndex >= 0 && generatingIndex < requestSource.indexOf('window.seeon.generateSummary('),
    '요약을 부르기 전에 시작 고지를 띄운다');
  assert.ok(requestSource.includes("showNotice(t('summary.savedText'));"));
  assert.match(requestSource, /showNotice\(t\('summary\.failedNotice', \{ message: /);

  const progressSource = readBlockSource(source, { head: 'window.seeon.onSummaryProgress(', end: '\n});\n' });
  assert.equal((progressSource.match(/showNotice\(/g) || []).length, 1, progressSource);
  assert.ok(progressSource.includes("if (stage === SUMMARY_STAGE_MAP.audioDone) showNotice(t('summary.audioSaved'));"),
    progressSource);
  assert.ok(progressSource.includes('markDebug('));
});
