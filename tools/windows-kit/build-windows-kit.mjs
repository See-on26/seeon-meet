#!/usr/bin/env node
// Windows 설치 파일(.exe)을 만들어 팀원에게 줄 zip(설치 파일 + 안내문 + 버전)으로 묶는다.
// 코드가 바뀔 때마다 이 스크립트 하나로 origin/production(또는 --ref)을 깨끗한 빌드 폴더에 받아 빌드한다.
// 내 작업 폴더의 미커밋 변경이 설치본에 섞이지 않게, 빌드는 늘 커밋 하나를 그대로 꺼낸 별도 worktree 에서 한다.
//
// 사용: node tools/windows-kit/build-windows-kit.mjs [--ref origin/production] [--env .env] [--key <앱 전용 터널 키>]
//                                             [--out ~/Desktop] [--label 받는사람] [--no-fetch] [--build-dir <폴더>]
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 설치본 .env 에는 앱이 읽는 SEEON_ 설정 줄만 넣는다(주석·다른 키·개발 PC 전용 값은 버린다).
import { readEnvKey, sanitizeEnvText } from './packaged-env.cjs';

const DEFAULT_REF = 'origin/production';
// zip 안 이름은 ASCII 로 둔다. bsdtar zip 은 한글 이름에 UTF-8 표시를 하지 않아 Windows 탐색기에서 깨진다.
const KIT_FOLDER_NAME = 'SEEON-Windows-kit';
const README_TEMPLATE_PATH = fileURLToPath(new URL('./windows-kit-README.txt', import.meta.url));
const LOCK_HASH_FILE_NAME = '.kit-lock-hash';
const isWindows = process.platform === 'win32';

const OPTION_KEY_MAP = {
  '--ref': 'ref', '--env': 'envFile', '--key': 'keyFile', '--out': 'outDir', '--label': 'label', '--build-dir': 'buildDir',
};
const PATH_OPTION_KEY_LIST = ['envFile', 'keyFile', 'outDir', 'buildDir'];

export function parseKitArgs(argList, { env, homeDir, repoRoot }) {
  const option = {
    ref: DEFAULT_REF, envFile: path.join(repoRoot, '.env'), keyFile: env.SEEON_BUILD_TUNNEL_KEY || null,
    outDir: path.join(homeDir, 'Desktop'), label: '', isFetch: true, buildDir: null,
  };
  for (let index = 0; index < argList.length; index += 1) {
    const arg = argList[index];
    if (arg === '--no-fetch') { option.isFetch = false; continue; }
    const key = OPTION_KEY_MAP[arg];
    if (!key) throw new Error(`알 수 없는 인자: ${arg}`);
    const value = argList[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 에는 값이 필요하다`);
    option[key] = PATH_OPTION_KEY_LIST.includes(key) ? path.resolve(repoRoot, value) : value;
    index += 1;
  }
  return option;
}

export function readEnvValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    if (readEnvKey(line) !== key) continue;
    return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}

const pad2 = (value) => String(value).padStart(2, '0');

export function buildKitName({ date, commit, label }) {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  const safeLabel = String(label || '').replace(/[^A-Za-z0-9가-힣_-]/g, '');
  return `SEEON-Windows-${stamp}-${commit.slice(0, 7)}${safeLabel ? `-${safeLabel}` : ''}`;
}

// Windows 메모장이 한글을 바로 읽게 UTF-8 BOM 을 붙이고 줄바꿈을 CRLF 로 바꾼다.
export function renderKitReadme({ template, version, commit, ref, builtAt }) {
  const text = template
    .replaceAll('{{VERSION}}', version).replaceAll('{{COMMIT}}', commit)
    .replaceAll('{{REF}}', ref).replaceAll('{{BUILT_AT}}', builtAt);
  return `﻿${text.replace(/\r?\n/g, '\r\n')}`;
}

function git(cwd, argList) {
  return execFileSync('git', ['-C', cwd, ...argList], { encoding: 'utf8' }).trim();
}

// 출력을 그대로 보여 준다. npm 은 Windows 에서 npm.cmd 라 셸로 부른다.
function run(command, argList, { cwd, env = process.env }) {
  const result = spawnSync(command, argList, { cwd, env, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) throw new Error(`${command} ${argList.join(' ')} 실패(종료 코드 ${result.status})`);
}

// 저장소 본체(.git 이 있는 곳) 옆의 <저장소>.wt/windows-build 를 빌드 폴더로 쓴다. 어느 worktree 에서 실행해도 같은 곳이다.
function resolveDefaultBuildDir({ repoRoot }) {
  const commonDir = path.resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir']));
  const mainRoot = path.dirname(commonDir);
  return path.join(`${mainRoot}.wt`, 'windows-build');
}

function prepareBuildDir({ repoRoot, buildDir, commit }) {
  if (!fs.existsSync(path.join(buildDir, '.git'))) {
    fs.mkdirSync(path.dirname(buildDir), { recursive: true });
    git(repoRoot, ['worktree', 'add', '--detach', buildDir, commit]);
    return;
  }
  // 다른 저장소의 폴더를 덮어쓰지 않게, 이 저장소의 worktree 일 때만 커밋을 바꾼다.
  const buildCommonDir = path.resolve(buildDir, git(buildDir, ['rev-parse', '--git-common-dir']));
  const repoCommonDir = path.resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir']));
  if (buildCommonDir !== repoCommonDir) throw new Error(`빌드 폴더가 이 저장소의 worktree 가 아니다: ${buildDir}`);
  git(buildDir, ['checkout', '--detach', '--force', commit]);
}

// package-lock 이 바뀌었을 때만 다시 설치한다. 같으면 지난 빌드의 node_modules 를 그대로 쓴다.
function installDependencies({ buildDir }) {
  const lockHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(buildDir, 'package-lock.json'))).digest('hex');
  const hashPath = path.join(buildDir, 'node_modules', LOCK_HASH_FILE_NAME);
  if (fs.existsSync(hashPath) && fs.readFileSync(hashPath, 'utf8') === lockHash) {
    console.log('[kit] 의존성 그대로 — npm ci 건너뜀');
    return;
  }
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: buildDir });
  fs.writeFileSync(hashPath, lockHash);
}

function findInstaller({ buildDir }) {
  const distDir = path.join(buildDir, 'dist');
  const name = fs.readdirSync(distDir).find((fileName) => /^SEEON-Setup-.*\.exe$/.test(fileName));
  if (!name) throw new Error(`설치 파일을 찾지 못했다: ${distDir}`);
  return path.join(distDir, name);
}

function formatBuiltAt(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

async function main() {
  const repoRoot = git(path.dirname(fileURLToPath(import.meta.url)), ['rev-parse', '--show-toplevel']);
  const option = parseKitArgs(process.argv.slice(2), { env: process.env, homeDir: os.homedir(), repoRoot });
  if (!fs.existsSync(option.envFile)) throw new Error(`.env 를 찾지 못했다(--env): ${option.envFile}`);
  const envText = fs.readFileSync(option.envFile, 'utf8');
  const keyFile = option.keyFile || readEnvValue(envText, 'SEEON_GPU_SSH_KEY');
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error('앱 전용 GPU 터널 키를 찾지 못했다 — --key <경로> 또는 .env 의 SEEON_GPU_SSH_KEY 로 알려 준다');
  }

  if (option.isFetch) git(repoRoot, ['fetch', 'origin']);
  const commit = git(repoRoot, ['rev-parse', `${option.ref}^{commit}`]);
  const buildDir = option.buildDir || resolveDefaultBuildDir({ repoRoot });
  console.log(`[kit] 기준 ${option.ref} = ${commit.slice(0, 7)} · 빌드 폴더 ${buildDir}`);
  prepareBuildDir({ repoRoot, buildDir, commit });
  installDependencies({ buildDir });

  // 비밀 파일은 임시 폴더에만 두고(권한 600) 빌드가 끝나면 지운다. 내용은 화면에 찍지 않는다.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeon-kit-'));
  const distDir = path.join(buildDir, 'dist');
  try {
    const buildEnvPath = path.join(tempDir, 'build.env');
    fs.writeFileSync(buildEnvPath, sanitizeEnvText(envText), { mode: 0o600 });
    fs.rmSync(distDir, { recursive: true, force: true });
    run('npm', ['run', 'dist:win'], {
      cwd: buildDir, env: { ...process.env, SEEON_BUILD_ENV_FILE: buildEnvPath, SEEON_BUILD_TUNNEL_KEY: keyFile },
    });

    const installerPath = findInstaller({ buildDir });
    const { version } = JSON.parse(fs.readFileSync(path.join(buildDir, 'package.json'), 'utf8'));
    const builtAt = new Date();
    const kitName = buildKitName({ date: builtAt, commit, label: option.label });
    const stageDir = path.join(tempDir, KIT_FOLDER_NAME);
    fs.mkdirSync(stageDir);
    fs.copyFileSync(installerPath, path.join(stageDir, path.basename(installerPath)));
    const readmeTemplate = fs.readFileSync(README_TEMPLATE_PATH, 'utf8');
    fs.writeFileSync(path.join(stageDir, 'README.txt'), renderKitReadme({
      template: readmeTemplate, version, commit: commit.slice(0, 7), ref: option.ref, builtAt: formatBuiltAt(builtAt),
    }));
    fs.writeFileSync(path.join(stageDir, 'VERSION.txt'),
      [`version=${version}`, `commit=${commit}`, `ref=${option.ref}`, `builtAt=${builtAt.toISOString()}`, ''].join('\r\n'));

    fs.mkdirSync(option.outDir, { recursive: true });
    const zipPath = path.join(option.outDir, `${kitName}.zip`);
    fs.rmSync(zipPath, { force: true });
    // bsdtar 는 macOS·Windows 10 이상에 모두 있고 -a 로 .zip 을 만든다.
    run('tar', ['-a', '-c', '-f', zipPath, '-C', tempDir, KIT_FOLDER_NAME], { cwd: tempDir });
    if (!isWindows) fs.chmodSync(zipPath, 0o600);
    const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    console.log(`[kit] 완료 → ${zipPath} (${sizeMb}MB, 커밋 ${commit.slice(0, 7)})`);
    console.log('[kit] 주의: 설치 파일 안에 GPU 서버 접속 키가 들어 있다. 팀원에게 1:1 로만 전달하고 공개 업로드하지 않는다.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    // 빌드 결과물(dist)에도 비밀이 들어 있어 zip 을 만든 뒤 지운다.
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[kit] 실패: ${error.message}`);
    process.exit(1);
  });
}
