const fs = require('fs');

// 세션 jsonl(out/pipeline-<실행>.jsonl)에서 그 세션의 레코드만 읽는다. 깨진 줄은 세고 건너뛴다.
async function readSessionRecordList({ recordPath, sessionId, readFile = fs.promises.readFile }) {
  const text = await readFile(recordPath, 'utf8');
  const recordList = [];
  let brokenLineCount = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.sessionId === sessionId) recordList.push(record);
    } catch {
      brokenLineCount += 1;
    }
  }
  return { recordList, brokenLineCount };
}

const filterRecordKind = (recordList, kind) => recordList.filter((record) => record.kind === kind);

module.exports = { readSessionRecordList, filterRecordKind };
