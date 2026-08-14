import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MEET_MEETING_URL_PATTERN as RENDERER_MEET_MEETING_URL_PATTERN } from '../src/renderer/core/constants.js';

const require = createRequire(import.meta.url);
const {
  MEET_HOME_URL, isMeetingUrl, isInViewUrl, handleMeetWindowOpen,
} = require('../src/main/meeting/meet-navigation.js');

// Meet 은 회의 코드를 도메인 바로 뒤에도, meet/ 아래에도 붙여 회의를 연다.
const MEETING_URL_LIST = [
  'https://meet.google.com/abc-defg-hij',
  'https://meet.google.com/abc-defg-hij?authuser=0',
  'https://meet.google.com/meet/wkx-pupt-nvs',
  'https://meet.google.com/meet/wkx-pupt-nvs?authuser=0',
];

// 회의 코드가 없거나 형식이 틀리면 meet/ 가 붙어도 회의가 아니다.
const NOT_MEETING_URL_LIST = [
  MEET_HOME_URL,
  'https://meet.google.com/landing',
  'https://meet.google.com/meet',
  'https://meet.google.com/meet/',
  'https://meet.google.com/meet/landing',
  'https://meet.google.com/ab-defg-hij',
  'https://meet.google.com/abcdefghij',
  'https://meet.google.com/meet/ab-defg-hij',
  'https://meet.google.com/meet/abcdefghij',
  'https://meet.google.com/meet/meet/abc-defg-hij',
  'https://meet.google.com/lookup/abc-defg-hij',
  'http://meet.google.com/meet/abc-defg-hij',
  'https://workspace.google.com/products/meet/',
  '',
];

test('회의 코드가 붙은 Meet 주소만 회의 주소로 본다', () => {
  assert.equal(isMeetingUrl('https://meet.google.com/abc-defg-hij'), true);
  assert.equal(isMeetingUrl('https://meet.google.com/abc-defg-hij?authuser=0'), true);
  assert.equal(isMeetingUrl(MEET_HOME_URL), false);
  assert.equal(isMeetingUrl('https://meet.google.com/landing'), false);
  assert.equal(isMeetingUrl('https://workspace.google.com/products/meet/'), false);
  assert.equal(isMeetingUrl(''), false);
  assert.equal(isMeetingUrl(undefined), false);
});

test('meet/ 아래에 회의 코드가 붙은 주소도 회의 주소로 보고, 코드가 없거나 틀리면 회의 주소가 아니다', () => {
  for (const url of MEETING_URL_LIST) assert.equal(isMeetingUrl(url), true, url);
  for (const url of NOT_MEETING_URL_LIST) assert.equal(isMeetingUrl(url), false, url);
});

test('렌더러 회의 주소 규칙도 main 과 같은 주소를 회의로 본다', () => {
  for (const url of MEETING_URL_LIST) assert.equal(RENDERER_MEET_MEETING_URL_PATTERN.test(url), true, url);
  for (const url of NOT_MEETING_URL_LIST) assert.equal(RENDERER_MEET_MEETING_URL_PATTERN.test(url), false, url);
});

test('Meet 와 구글 로그인 주소만 회의 화면 안에서 연다', () => {
  assert.equal(isInViewUrl('https://meet.google.com/abc-defg-hij'), true);
  assert.equal(isInViewUrl('https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/'), true);
  assert.equal(isInViewUrl('https://support.google.com/meet/answer/1'), false);
  assert.equal(isInViewUrl('http://meet.google.com/abc-defg-hij'), false);
  assert.equal(isInViewUrl('https://meet.google.com.example.com/'), false);
  assert.equal(isInViewUrl('not a url'), false);
});

function openWith(url) {
  const callList = [];
  const result = handleMeetWindowOpen({
    url,
    loadInView: (target) => callList.push(['loadInView', target]),
    openExternal: (target) => callList.push(['openExternal', target]),
  });
  return { result, callList };
}

test('새 창 링크: Meet·로그인 주소는 회의 화면에 열고 새 창은 막는다', () => {
  const { result, callList } = openWith('https://meet.google.com/abc-defg-hij');
  assert.deepEqual(result, { action: 'deny' });
  assert.deepEqual(callList, [['loadInView', 'https://meet.google.com/abc-defg-hij']]);
});

test('새 창 링크: 그 밖의 웹 주소는 회의 화면을 바꾸지 않고 기본 브라우저로 연다', () => {
  const { result, callList } = openWith('https://support.google.com/meet/answer/1');
  assert.deepEqual(result, { action: 'deny' });
  assert.deepEqual(callList, [['openExternal', 'https://support.google.com/meet/answer/1']]);
});

test('새 창 링크: 웹 주소가 아니면 어디에도 열지 않는다', () => {
  for (const url of ['mailto:someone@example.com', 'javascript:alert(1)', 'file:///etc/passwd']) {
    const { result, callList } = openWith(url);
    assert.deepEqual(result, { action: 'deny' });
    assert.deepEqual(callList, [], url);
  }
});
