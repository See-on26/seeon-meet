import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  parseKitArgs, readEnvValue, buildKitName, renderKitReadme,
} from '../tools/windows-kit/build-windows-kit.mjs';

const require = createRequire(import.meta.url);
const { sanitizeEnvText, countUnpackagedEnvLine, DEV_ONLY_ENV_KEY_LIST } = require('../tools/windows-kit/packaged-env.cjs');

const context = { env: {}, homeDir: '/home/u', repoRoot: '/repo' };

test('인자가 없으면 origin/production 을 받아 저장소 .env 로 빌드하고 바탕화면에 zip 을 둔다', () => {
  assert.deepEqual(parseKitArgs([], context), {
    ref: 'origin/production', envFile: '/repo/.env', keyFile: null, outDir: '/home/u/Desktop', label: '', isFetch: true, buildDir: null,
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

test('설치본 .env 에는 앱이 읽는 SEEON_ 설정 줄만 넣고, 주석·빈 줄·외부 AI 서비스 키·개발 PC 전용 값(터널 키 경로·터널 끄기)은 뺀다', () => {
  const text = [
    '# 주석', '# GPU_SSH_PASSWORD=secret', '#OPENAI_API_KEY=sk-x', '  # SEEON_GPU_SSH_USER=me',
    'AWS_BEARER_TOKEN_BEDROCK=abc', 'OPENAI_API_KEY=sk-1', 'GEMINI_API_KEY=g-1', 'SEEON_BEDROCK_REGION=us-east-1',
    'SEEON_GPU_SSH_KEY=/Users/me/key', 'export SEEON_GPU_TUNNEL=off', '', 'SEEON_ASR_LANGUAGE=ko',
    'export SEEON_GPU_SSH_HOST=gpu.example',
  ].join('\r\n');
  assert.equal(sanitizeEnvText(text), ['SEEON_ASR_LANGUAGE=ko', 'export SEEON_GPU_SSH_HOST=gpu.example'].join('\n'));
  assert.equal(sanitizeEnvText('# 주석만\n\n'), '');
  assert.deepEqual(DEV_ONLY_ENV_KEY_LIST, ['SEEON_GPU_SSH_KEY', 'SEEON_GPU_TUNNEL']);
});

test('설치본 .env: 값 뒤 주석은 앱이 읽는 방식대로 떼고, 같은 줄에서 닫히지 않는 여러 줄 값은 통째로 뺀다', () => {
  const text = [
    'SEEON_ASR_URL=http://h:1 # GPU_SSH_PASSWORD=secret', 'SEEON_VLM_MODEL=m#secret', 'SEEON_TTS_URL="http://t # 안" # 밖',
    "SEEON_ASR_LANGUAGE='ko' # 밖", 'SEEON_VLM_PROMPT="첫 줄', '이어지는 줄"', 'SEEON_GPU_SSH_PORT=22',
  ].join('\n');
  assert.equal(sanitizeEnvText(text), [
    'SEEON_ASR_URL=http://h:1', 'SEEON_VLM_MODEL=m', 'SEEON_TTS_URL="http://t # 안"', "SEEON_ASR_LANGUAGE='ko'",
    'SEEON_GPU_SSH_PORT=22',
  ].join('\n'));
});

test('설치본에 넣지 않는 줄 수를 센다(빈 줄은 세지 않는다) — 걸러 낸 글은 0 이다', () => {
  const text = '# 주석\n\nSEEON_ASR_LANGUAGE=ko\nOPENAI_API_KEY=sk-1\nSEEON_GPU_SSH_KEY=/k\nSEEON_ASR_URL=http://h # 비밀\n';
  assert.equal(countUnpackagedEnvLine(text), 4);
  assert.equal(countUnpackagedEnvLine(sanitizeEnvText(text)), 0);
  assert.equal(countUnpackagedEnvLine('SEEON_ASR_LANGUAGE=ko  \r\n'), 0);
});

test('설치본 .env: 줄 가운데 CR·줄 구분 문자가 있어도 멈추지 않고 앱이 읽는 대로 거른다', () => {
  assert.equal(sanitizeEnvText('SEEON_ASR_URL=v\r\r\nSEEON_ASR_LANGUAGE=ko'), 'SEEON_ASR_URL=v\nSEEON_ASR_LANGUAGE=ko');
  assert.equal(countUnpackagedEnvLine('SEEON_ASR_URL=v\r\r\n'), 0);
  assert.doesNotThrow(() => sanitizeEnvText('SEEON_ASR_URL=a\u2028b'));
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
