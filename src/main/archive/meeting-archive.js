const fs = require('fs');
const path = require('path');

// 회의별 요약·스크립트를 사용자 문서 폴더에 날짜별로 남긴다. 앱의 "지난 회의"가 이 폴더를 읽는다.
const ARCHIVE_FILE_NAME_MAP = {
  meta: 'meeting.json',
  script: '대화 스크립트.txt',
  summary: '회의 요약.txt',
  summaryAudio: '회의 요약.mp3',
};

const pad2 = (value) => String(value).padStart(2, '0');

// 폴더 이름에 쓸 수 없는 ':' 대신 '-' 로 시각을 적는다(윈도우 호환).
function formatMeetingDirName({ startedAt }) {
  const date = new Date(startedAt);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + ` ${pad2(date.getHours())}-${pad2(date.getMinutes())} 회의`;
}

// 기록 폴더 바로 아래 이름만 받는다. 경로 구분자·상위 폴더·숨김 이름은 거른다.
function isSafeMeetingId(id) {
  return typeof id === 'string' && id.length > 0 && !id.startsWith('.')
    && path.basename(id) === id && !id.includes('/') && !id.includes('\\');
}

async function readTextOrEmpty(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function readMeta(meetingDir) {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.meta), 'utf8'));
  } catch {
    return null;
  }
}

async function isFile(filePath) {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

const TITLE_SLIDE_LIMIT = 2;

// 목록에서 회의를 알아볼 수 있게 앞쪽 슬라이드 제목을 회의 제목으로 쓴다.
function pickMeetingTitle({ snapshot }) {
  const titleList = [];
  for (const slide of snapshot?.slideList || []) {
    const title = String(slide.label?.title || slide.pageTopic || '').trim();
    if (title && !titleList.includes(title)) titleList.push(title);
    if (titleList.length >= TITLE_SLIDE_LIMIT) break;
  }
  return titleList.join(' · ');
}

function createMeetingArchive({ rootDir }) {
  async function listMeetingDirName() {
    try {
      const entryList = await fs.promises.readdir(rootDir, { withFileTypes: true });
      return entryList.filter((entry) => entry.isDirectory() && isSafeMeetingId(entry.name)).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  // 같은 회의(sessionId)는 한 폴더에 모은다. 같은 분에 시작한 다른 회의는 " (2)" 처럼 번호를 붙인다.
  async function ensureMeetingDir({ sessionId, startedAt }) {
    for (const dirName of await listMeetingDirName()) {
      const meta = await readMeta(path.join(rootDir, dirName));
      if (meta?.sessionId === sessionId) return path.join(rootDir, dirName);
    }
    const baseName = formatMeetingDirName({ startedAt });
    const existingSet = new Set(await listMeetingDirName());
    let dirName = baseName;
    for (let suffix = 2; existingSet.has(dirName); suffix += 1) dirName = `${baseName} (${suffix})`;
    const meetingDir = path.join(rootDir, dirName);
    await fs.promises.mkdir(meetingDir, { recursive: true });
    await writeMeta({ meetingDir, meta: { sessionId, startedAt } });
    return meetingDir;
  }

  async function writeMeta({ meetingDir, meta }) {
    await fs.promises.writeFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.meta), JSON.stringify(meta, null, 2), 'utf8');
  }

  async function saveScript({ sessionId, startedAt, endedAt = null, title = '', slideCount = 0,
    utteranceCount = 0, scriptText }) {
    const meetingDir = await ensureMeetingDir({ sessionId, startedAt });
    await writeMeta({ meetingDir, meta: { sessionId, startedAt, endedAt, title, slideCount, utteranceCount } });
    await fs.promises.writeFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.script), scriptText, 'utf8');
    return meetingDir;
  }

  async function saveSummary({ sessionId, startedAt, summaryText, audioFilePath = null }) {
    const meetingDir = await ensureMeetingDir({ sessionId, startedAt });
    await fs.promises.writeFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summary), summaryText, 'utf8');
    if (audioFilePath) {
      await fs.promises.copyFile(audioFilePath, path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summaryAudio));
    }
    return meetingDir;
  }

  async function list() {
    const meetingList = [];
    for (const dirName of await listMeetingDirName()) {
      const meetingDir = path.join(rootDir, dirName);
      const meta = await readMeta(meetingDir);
      if (!meta) continue;
      meetingList.push({
        id: dirName,
        startedAt: meta.startedAt ?? null,
        endedAt: meta.endedAt ?? null,
        title: meta.title || '',
        slideCount: meta.slideCount ?? 0,
        utteranceCount: meta.utteranceCount ?? 0,
        hasSummary: await isFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summary)),
        hasScript: await isFile(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.script)),
      });
    }
    return meetingList.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  }

  async function read({ id }) {
    if (!isSafeMeetingId(id)) return { isOk: false, message: '잘못된 회의 기록입니다' };
    const meetingDir = path.join(rootDir, id);
    const meta = await readMeta(meetingDir);
    if (!meta) return { isOk: false, message: '회의 기록을 찾지 못했어요' };
    return {
      isOk: true,
      meeting: { id, ...meta },
      summaryText: await readTextOrEmpty(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.summary)),
      scriptText: await readTextOrEmpty(path.join(meetingDir, ARCHIVE_FILE_NAME_MAP.script)),
      meetingDir,
    };
  }

  return { rootDir, saveScript, saveSummary, list, read };
}

module.exports = {
  createMeetingArchive, formatMeetingDirName, isSafeMeetingId, pickMeetingTitle, ARCHIVE_FILE_NAME_MAP,
};
