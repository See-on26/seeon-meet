import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoiStore, ROI_CHANGE_CAUSE_MAP, ROI_STORE_DEFAULT_MAP, resolveRoiChangeReset,
} from '../src/renderer/core/roi/roi-store.js';

// 가짜 Meet 실측(912×842 → 1464×842): 펼침 때 공유 화면 타일 (8,129,896,504), 접힘 때 (8,44,1200,675).
const EXPANDED = { vw: 912, vh: 842, rect: { x: 8, y: 129, w: 896, h: 504 } };
const COLLAPSED = { vw: 1464, vh: 842, rect: { x: 8, y: 44, w: 1200, h: 675 } };

function makeStore() {
  let nowMs = 10000;
  const store = new RoiStore({ now: () => nowMs });
  const advance = (ms) => { nowMs += ms; };
  const submit = ({ vw, vh, rect }) => store.submitViewportRoiList({
    viewport: { vw, vh, dpr: 2 }, roiList: rect ? [{ type: 'screen_share', rect }] : [],
  });
  // roi-scanner 는 500ms 마다 보낸다. 자리 잡기(700ms)를 넘기려면 세 번 받아야 한다.
  const settle = (layout) => { submit(layout); advance(500); submit(layout); advance(500); submit(layout); };
  return { store, advance, submit, settle };
}

test('Meet 크기가 바뀐 좌표가 오면, 새 좌표가 자리 잡기 전까지 옛 좌표를 내주지 않는다', () => {
  const { store, advance, submit, settle } = makeStore();
  settle(EXPANDED);
  assert.ok(store.getScreenRectNorm());
  assert.equal(store.isLayoutSettling(), false);

  advance(500);
  submit(COLLAPSED);
  assert.equal(store.getScreenRectNorm(), null, '옛 크기에서 잰 좌표로 새 화면을 자르면 엉뚱한 곳이 잘린다');
  assert.equal(store.hasScreenShare(), false);
  assert.equal(store.isLayoutSettling(), true);
});

test('새 크기의 좌표가 자리 잡으면 새 좌표를 내주고, 세대가 오르며 까닭은 layout 이다', () => {
  const { store, advance, settle } = makeStore();
  settle(EXPANDED);
  const before = store.getScreenGeneration();
  advance(500);
  settle(COLLAPSED);
  assert.equal(store.isLayoutSettling(), false);
  assert.equal(store.getScreenGeneration(), before + 1);
  assert.equal(store.getLastChangeCause(), ROI_CHANGE_CAUSE_MAP.layout);
  const rect = store.getScreenRectNorm();
  assert.ok(Math.abs(rect.w - 1200 / 1464) < 1e-9);
  assert.ok(Math.abs(rect.y - 44 / 842) < 1e-9);
});

test('크기가 같은 채 공유가 새로 생기면 까닭은 screen 이다', () => {
  const { store, settle } = makeStore();
  assert.equal(store.getScreenGeneration(), 0);
  settle(EXPANDED);
  assert.equal(store.getScreenGeneration(), 1);
  assert.equal(store.getLastChangeCause(), ROI_CHANGE_CAUSE_MAP.screen);
});

test('크기가 같은 채 공유 화면 위치가 크게 바뀌면 까닭은 screen 이다', () => {
  const { store, advance, settle } = makeStore();
  settle(EXPANDED);
  advance(500);
  settle({ ...EXPANDED, rect: { x: 8, y: 300, w: 600, h: 338 } });
  assert.equal(store.getScreenGeneration(), 2);
  assert.equal(store.getLastChangeCause(), ROI_CHANGE_CAUSE_MAP.screen);
});

test('정규화 좌표가 거의 같아도 크기가 바뀌면 자리 잡은 뒤 layout 세대를 올린다(배율이 달라 감지기 기준을 다시 잡는다)', () => {
  const { store, advance, submit, settle } = makeStore();
  settle(EXPANDED);
  const scaled = { vw: 1824, vh: 1684, rect: { x: 16, y: 258, w: 1792, h: 1008 } };
  advance(500);
  submit(scaled);
  assert.equal(store.getScreenRectNorm(), null);
  advance(500); submit(scaled); advance(500); submit(scaled);
  assert.ok(store.getScreenRectNorm());
  assert.equal(store.getScreenGeneration(), 2);
  assert.equal(store.getLastChangeCause(), ROI_CHANGE_CAUSE_MAP.layout);
});

test('자리 잡기는 같은 크기에서 잰 좌표끼리만 잇는다(크기가 다시 바뀌면 처음부터 기다린다)', () => {
  const { store, advance, submit, settle } = makeStore();
  settle(EXPANDED);
  const sameNormOtherSize = { vw: 1824, vh: 1684, rect: { x: 16, y: 258, w: 1792, h: 1008 } };
  advance(500);
  submit({ vw: 1464, vh: 842, rect: { x: 13, y: 129, w: 1438, h: 504 } });
  advance(500);
  submit(sameNormOtherSize);
  advance(400);
  submit(sameNormOtherSize);
  assert.equal(store.getScreenRectNorm(), null, '크기가 바뀐 뒤로는 400ms 만 지났다');
  advance(400);
  submit(sameNormOtherSize);
  assert.ok(store.getScreenRectNorm());
});

test('main 이 크기를 바꾼다고 알리면 그 크기의 좌표가 오기 전부터 좌표를 내주지 않는다', () => {
  const { store, advance, submit, settle } = makeStore();
  settle(EXPANDED);
  store.expectViewport({ vw: 1464, vh: 842 });
  assert.equal(store.isLayoutSettling(), true);
  assert.equal(store.getScreenRectNorm(), null, '캡처 영상은 수십 ms 만에 새 크기로 오지만 좌표는 수백 ms 뒤에 온다');
  advance(400);
  submit(EXPANDED);
  assert.equal(store.getScreenRectNorm(), null, '옛 크기 좌표가 한 번 더 와도 기다린다');
  advance(100);
  submit(COLLAPSED);
  assert.equal(store.getScreenRectNorm(), null, '알린 크기의 좌표가 와도 자리 잡을 때까지 기다린다');
  advance(500); submit(COLLAPSED); advance(500); submit(COLLAPSED);
  assert.equal(store.isLayoutSettling(), false);
  assert.ok(Math.abs(store.getScreenRectNorm().w - 1200 / 1464) < 1e-9);
  assert.equal(store.getLastChangeCause(), ROI_CHANGE_CAUSE_MAP.layout);
});

test('알린 크기의 좌표가 끝내 오지 않으면(쪽 확대 등) 3초 뒤 기다림을 풀고 받은 좌표로 돌아간다', () => {
  const { store, advance, submit, settle } = makeStore();
  settle(EXPANDED);
  store.expectViewport({ vw: 1464, vh: 842 });
  advance(ROI_STORE_DEFAULT_MAP.layoutWaitMs - 100);
  submit(EXPANDED);
  assert.equal(store.getScreenRectNorm(), null);
  advance(200);
  submit(EXPANDED);
  assert.equal(store.isLayoutSettling(), false);
  assert.ok(store.getScreenRectNorm());
});

test('지금과 같은 크기를 알리면 아무것도 바꾸지 않는다', () => {
  const { store, settle } = makeStore();
  settle(EXPANDED);
  const before = store.getScreenGeneration();
  store.expectViewport({ vw: 912, vh: 842 });
  assert.equal(store.isLayoutSettling(), false);
  assert.ok(store.getScreenRectNorm());
  assert.equal(store.getScreenGeneration(), before);
});

test('접었다가 새 좌표가 오기 전에 다시 펴면, 오지 않을 크기를 기다리지 않는다', () => {
  const { store, advance, settle } = makeStore();
  settle(EXPANDED);
  store.expectViewport({ vw: 1464, vh: 842 });
  advance(100);
  store.expectViewport({ vw: 912, vh: 842 });
  assert.equal(store.isLayoutSettling(), false);
  assert.ok(store.getScreenRectNorm());
});

test('크기만 바뀌고 새 크기에서 공유가 없으면, 공유 없음이 자리 잡은 뒤 까닭 screen 으로 세대를 올린다', () => {
  const { store, advance, submit, settle } = makeStore();
  settle(EXPANDED);
  advance(500);
  submit({ vw: 1464, vh: 842, rect: null });
  assert.equal(store.getScreenRectNorm(), null);
  advance(800); submit({ vw: 1464, vh: 842, rect: null });
  advance(800); submit({ vw: 1464, vh: 842, rect: null });
  assert.equal(store.isLayoutSettling(), false);
  assert.equal(store.getScreenRectNorm(), null);
  assert.equal(store.getScreenGeneration(), 2);
  assert.equal(store.getLastChangeCause(), ROI_CHANGE_CAUSE_MAP.screen);
});

test('reset 하면 기다리던 크기와 까닭도 지운다', () => {
  const { store, settle } = makeStore();
  settle(EXPANDED);
  store.expectViewport({ vw: 1464, vh: 842 });
  store.reset();
  assert.equal(store.isLayoutSettling(), false);
  assert.equal(store.getLastChangeCause(), ROI_CHANGE_CAUSE_MAP.screen);
  settle(EXPANDED);
  assert.ok(store.getScreenRectNorm());
});

test('크기만 바뀐(layout) 좌표 변경은 체류 판정 중인 전환 고지를 취소하지 않는다', () => {
  assert.deepEqual(resolveRoiChangeReset({ cause: ROI_CHANGE_CAUSE_MAP.layout }), { shouldResetDwell: false });
});

test('공유 시작·끝·바뀜(screen)이나 모르는 까닭은 지금처럼 체류 판정을 취소한다', () => {
  assert.deepEqual(resolveRoiChangeReset({ cause: ROI_CHANGE_CAUSE_MAP.screen }), { shouldResetDwell: true });
  assert.deepEqual(resolveRoiChangeReset({ cause: undefined }), { shouldResetDwell: true });
});
