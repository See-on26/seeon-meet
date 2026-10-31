import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

// 공유 화면 밖은 처리하지 않는다. 화자 확인은 참가자 타일 영역만 찍고, 그 영역을 모르면 Meet 창 전체를 보내지 않고 건너뛴다.
test('화자 확인 영역: 참가자 타일 영역을 모르면 창 전체로 대신하지 않고 null 이다', () => {
  const source = readSource('src/renderer/app/main.js');
  const start = source.indexOf('function getParticipantRegionPx()');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 2);
  assert.match(body, /return rect \? normRectToPx\(rect, vw, vh\) : null;/);
  assert.doesNotMatch(body, /\{ x: 0, y: 0, w: vw, h: vh \}/);
  const pollStart = source.indexOf('async function pollSpeakerIdentity()');
  const pollBody = source.slice(pollStart, source.indexOf('\n}\n', pollStart) + 2);
  assert.match(pollBody, /참가자 영역을 몰라 화자 확인을 건너뜀/);
});

// 회의 소리·영상은 파일로 남기지 않는다. 쓰는 곳 없는 저장 통로도 두지 않는다.
test('회의 소리·영상 저장 통로가 없다', () => {
  for (const relativePath of ['src/main/ipc.js', 'src/preload/viewer.js']) {
    const source = readSource(relativePath);
    assert.doesNotMatch(source, /save-audio|save-video|saveAudio|saveVideo/, relativePath);
  }
});
