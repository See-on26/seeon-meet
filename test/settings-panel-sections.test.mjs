import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

// id 로 요소 하나를 여는 태그부터 짝이 맞는 닫는 태그까지 잘라 낸다(같은 이름의 태그가 안에 겹쳐 있어도 센다).
function sliceElementById(html, id) {
  const openIndex = html.search(new RegExp(`<(\\w+)[^>]*\\sid="${id}"`));
  assert.ok(openIndex >= 0, `#${id} 가 없다`);
  const tagName = html.slice(openIndex + 1).match(/^\w+/)[0];
  const tagPattern = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'g');
  tagPattern.lastIndex = openIndex;
  let depth = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(openIndex, match.index + match[0].length);
  }
  throw new Error(`#${id} 의 닫는 태그가 없다`);
}

const DIAGNOSTIC_ID_LIST = ['pipeChk', 'slideTextBackendSelect', 'stCapture', 'stRes', 'stDelay', 'stBuffer', 'stGpuTunnel'];
const USER_SETTING_ID_LIST = ['featureToggleList', 'captionLanguageSelect', 'questionPresetList', 'modeNote'];

test('사용자 설정에는 사용자가 고를 것만 두고, 점검용 항목은 숨겨 둔 개발자 진단 영역에 둔다', () => {
  const html = readSource('src/renderer/app/index.html');
  const panel = sliceElementById(html, 'settingsPanel');
  const diagnostic = sliceElementById(panel, 'devSettingsSection');
  assert.match(diagnostic.slice(0, diagnostic.indexOf('>') + 1), /\shidden[\s>]/, '개발자 모드를 열기 전에는 보이지 않는다');
  for (const id of DIAGNOSTIC_ID_LIST) assert.ok(diagnostic.includes(`id="${id}"`), `${id} 는 개발자 진단 영역에 있다`);
  const userPart = panel.replace(diagnostic, '');
  for (const id of DIAGNOSTIC_ID_LIST) assert.ok(!userPart.includes(`id="${id}"`), `${id} 는 사용자 설정에 없다`);
  for (const id of USER_SETTING_ID_LIST) assert.ok(userPart.includes(`id="${id}"`), `${id} 는 사용자 설정에 남는다`);
});

test('로고를 5번 누르면 흐름 창과 함께 설정 패널의 개발자 진단 영역을 연다', () => {
  const source = readSource('src/renderer/app/main.js');
  const start = source.indexOf("$('brandLogo').addEventListener");
  const handler = source.slice(start, source.indexOf('});', start));
  assert.match(handler, /logoTapCounter\.tap\(\)/);
  assert.match(handler, /\$\('devSettingsSection'\)\.hidden = false/);
  assert.match(handler, /openDevFlow\(\)/);
});
