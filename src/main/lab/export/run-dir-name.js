const path = require('path');

const MAX_VIDEO_NAME_LENGTH = 60;
const pad2 = (value) => String(value).padStart(2, '0');

function formatRunStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

// 폴더 이름에 못 쓰는 글자와 공백은 _ 로 바꾼다. 한글은 그대로 둔다.
function sanitizeVideoName(videoPath) {
  const baseName = path.basename(String(videoPath || ''), path.extname(String(videoPath || '')));
  const cleaned = baseName.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, MAX_VIDEO_NAME_LENGTH);
  return cleaned || 'video';
}

function buildRunDirName({ startedAtMs, videoPath }) {
  return `${formatRunStamp(new Date(startedAtMs))}-${sanitizeVideoName(videoPath)}`;
}

module.exports = { buildRunDirName, sanitizeVideoName, formatRunStamp };
