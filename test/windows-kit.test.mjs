import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKitArgs, sanitizeEnvText, readEnvValue, buildKitName, renderKitReadme, DEV_ONLY_ENV_KEY_LIST, KIT_APP_MAP,
} from '../tools/windows-kit/build-windows-kit.mjs';

const context = { env: {}, homeDir: '/home/u', repoRoot: '/repo' };

test('인자가 없으면 origin/production 을 받아 저장소 .env 로 빌드하고 바탕화면에 zip 을 둔다', () => {
  assert.deepEqual(parseKitArgs([], context), {
    app: 'meet', ref: 'origin/production', envFile: '/repo/.env', keyFile: null, outDir: '/home/u/Desktop', label: '', isFetch: true, buildDir: null,
  });
});

test('인자로 기준·env·키·출력 폴더·받는 사람 이름표·빌드 폴더를 바꾼다', () => {
  const option = parseKitArgs([
    '--ref', 'HEAD', '--env', 'my.env', '--key', '/k/app-key', '--out', 'kits', '--label', '김지오', '--no-fetch', '--build-dir', '/b',
  ], context);
  assert.equal(option.ref, 'HEAD');
  assert.equal(option.envFile, '/repo/my.env');
  assert.equal(option.keyFile, '/k/app-key');
  assert.equal(option.outDir, '/repo/kits');
  assert.equal(option.label, '김지오');
  assert.equal(option.isFetch, false);
  assert.equal(option.buildDir, '/b');
});

test('env SEEON_BUILD_TUNNEL_KEY 가 있으면 키 기본값으로 쓴다', () => {
  assert.equal(parseKitArgs([], { ...context, env: { SEEON_BUILD_TUNNEL_KEY: '/k/from-env' } }).keyFile, '/k/from-env');
});

test('모르는 인자나 값 없는 인자는 멈춘다', () => {
  assert.throws(() => parseKitArgs(['--oops'], context), /알 수 없는 인자/);
  assert.throws(() => parseKitArgs(['--ref'], context), /값이 필요/);
});

test('설치본 .env 에는 개발 PC 전용 값(터널 키 경로·터널 끄기)을 빼고 나머지는 그대로 둔다', () => {
  const text = [
    '# 주석', 'AWS_BEARER_TOKEN_BEDROCK=abc', 'SEEON_GPU_SSH_KEY=/Users/me/key', 'export SEEON_GPU_TUNNEL=off', '', 'SEEON_ASR_LANGUAGE=ko',
  ].join('\n');
  assert.equal(sanitizeEnvText(text), ['# 주석', 'AWS_BEARER_TOKEN_BEDROCK=abc', '', 'SEEON_ASR_LANGUAGE=ko'].join('\n'));
  assert.deepEqual(DEV_ONLY_ENV_KEY_LIST, ['SEEON_GPU_SSH_KEY', 'SEEON_GPU_TUNNEL']);
});

test('env 글에서 값 하나를 읽는다(따옴표·export 허용, 없으면 null)', () => {
  const text = 'A=1\nexport SEEON_GPU_SSH_KEY="/Users/me/key"\n';
  assert.equal(readEnvValue(text, 'SEEON_GPU_SSH_KEY'), '/Users/me/key');
  assert.equal(readEnvValue(text, 'B'), null);
});

test('zip 이름에 만든 시각·커밋·받는 사람 이름표를 넣는다', () => {
  const date = new Date(2026, 9, 6, 18, 5);
  assert.equal(buildKitName({ date, commit: '63cad457281d', label: '' }), 'SEEON-Windows-20261006-1805-63cad45');
  assert.equal(buildKitName({ date, commit: '63cad457281d', label: '김지오/테스트' }), 'SEEON-Windows-20261006-1805-63cad45-김지오테스트');
});

test('안내문은 Windows 메모장에서 깨지지 않게 UTF-8 BOM·CRLF 로 쓰고 버전·커밋을 채운다', () => {
  const text = renderKitReadme({
    template: '버전 {{VERSION}}\n커밋 {{COMMIT}} ({{REF}})\n만든 때 {{BUILT_AT}}\n', version: '0.1.0', commit: 'abc1234', ref: 'origin/production', builtAt: '2026-10-06 18:05',
  });
  assert.ok(text.startsWith('﻿'));
  assert.equal(text.slice(1), '버전 0.1.0\r\n커밋 abc1234 (origin/production)\r\n만든 때 2026-10-06 18:05\r\n');
});

test('--app lab 이면 실험 창 설치본을 origin/experiment 에서 만들고, --ref 를 주면 그 기준을 쓴다', () => {
  assert.equal(parseKitArgs(['--app', 'lab'], context).ref, 'origin/experiment');
  assert.equal(parseKitArgs(['--app', 'lab'], context).app, 'lab');
  assert.equal(parseKitArgs(['--ref', 'HEAD', '--app', 'lab'], context).ref, 'HEAD');
  assert.throws(() => parseKitArgs(['--app', 'zoom'], context), /--app 은 meet·lab/);
});

test('앱마다 빌드 스크립트·설치 파일 이름·zip 이름·안내문이 다르다', () => {
  assert.equal(KIT_APP_MAP.meet.distScript, 'dist:win');
  assert.equal(KIT_APP_MAP.lab.distScript, 'dist:win:lab');
  assert.ok(KIT_APP_MAP.lab.installerPattern.test('SEEON-Lab-Setup-0.1.0.exe'));
  assert.ok(!KIT_APP_MAP.lab.installerPattern.test('SEEON-Setup-0.1.0.exe'));
  assert.ok(!KIT_APP_MAP.meet.installerPattern.test('SEEON-Lab-Setup-0.1.0.exe'));
  assert.notEqual(KIT_APP_MAP.lab.readmeFileName, KIT_APP_MAP.meet.readmeFileName);
  const date = new Date(2026, 9, 11, 16, 30);
  assert.equal(buildKitName({ date, commit: '232932e1234', label: '김지오', app: 'lab' }), 'SEEON-Lab-Windows-20261011-1630-232932e-김지오');
  assert.equal(buildKitName({ date, commit: '232932e1234', label: '' }), 'SEEON-Windows-20261011-1630-232932e');
});
