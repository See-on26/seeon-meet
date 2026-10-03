import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { needsRecaption, buildSlideSectionListFromContext } = require('../src/main/summary/context-slide-section.js');

const snapshot = {
  slideList: [
    { major: 3, label: { title: '연봉', keywordList: [], summary: '' }, pageTopic: '반기 연봉', slideText: '1,500(C)', description: '그래프' },
    { major: 4, label: null, pageTopic: '복지', slideText: '', description: '복지 표' },
    { major: 5, label: null, pageTopic: '', slideText: '', description: '' },
  ],
  utteranceList: [
    { ts: 1, text: 'a', speakerHint: null, slideMajor: 3 },
    { ts: 2, text: 'b', speakerHint: null, slideMajor: 4 },
  ],
};

test('글자·묘사가 모두 없거나 주석 프레임이 있으면 다시 캡션한다', () => {
  assert.equal(needsRecaption({ slide: snapshot.slideList[0], asset: { lastAnnotationFilePath: null } }), false);
  assert.equal(needsRecaption({ slide: snapshot.slideList[0], asset: { lastAnnotationFilePath: '/a.jpg' } }), true);
  assert.equal(needsRecaption({ slide: snapshot.slideList[2], asset: { lastAnnotationFilePath: null } }), true);
  assert.equal(needsRecaption({ slide: null, asset: { lastAnnotationFilePath: null } }), true);
});

test('저장소로 요약 슬라이드 묶음을 만들고, 재캡션 결과는 비어 있는 칸만 채운다', () => {
  const assetList = [{ major: '3' }, { major: '4' }, { major: '5' }];
  const recaptionByMajorMap = new Map([
    ['3', { title: '재캡션 제목', bodyText: '재캡션 본문', annotationText: '빨간 동그라미' }],
    ['5', { title: '빈 슬라이드', bodyText: '사진 한 장', annotationText: '' }],
  ]);
  assert.deepEqual(buildSlideSectionListFromContext({ snapshot, assetList, recaptionByMajorMap }), [
    { major: '3', title: '연봉', bodyText: '1,500(C)', annotationText: '빨간 동그라미', utteranceList: [{ ts: 1, text: 'a', speakerHint: null, slideMajor: 3 }] },
    { major: '4', title: '복지', bodyText: '복지 표', annotationText: '', utteranceList: [{ ts: 2, text: 'b', speakerHint: null, slideMajor: 4 }] },
    { major: '5', title: '빈 슬라이드', bodyText: '사진 한 장', annotationText: '', utteranceList: [] },
  ]);
});
