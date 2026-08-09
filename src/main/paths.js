const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'out');
const FRAMES_DIR = path.join(OUT_DIR, 'frames');
const ROI_LOG = path.join(OUT_DIR, 'roi-log.jsonl');

const DEIXIS_FRAMES_DIR = path.join(OUT_DIR, 'deixis-frames');
const DEIXIS_NARRATED_DIR = path.join(DEIXIS_FRAMES_DIR, '나레이션 생성');
const DEIXIS_SKIPPED_DIR = path.join(DEIXIS_FRAMES_DIR, '나레이션 미생성');

const SLIDES_DIR = path.join(OUT_DIR, 'slides');

const SUMMARIES_DIR = path.join(OUT_DIR, 'summaries');

function resolveSlideDir({ sessionId, major }) {
  const slideDirName = `slide-${major}`;
  return sessionId
    ? path.join(SLIDES_DIR, sessionId, slideDirName)
    : path.join(SLIDES_DIR, slideDirName);
}

module.exports = {
  OUT_DIR, FRAMES_DIR, ROI_LOG,
  DEIXIS_FRAMES_DIR, DEIXIS_NARRATED_DIR, DEIXIS_SKIPPED_DIR,
  SLIDES_DIR, SUMMARIES_DIR, resolveSlideDir,
};
