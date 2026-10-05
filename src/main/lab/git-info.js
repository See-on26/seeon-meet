const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const execFileAsync = promisify(execFile);

async function runGit({ argList, cwd, exec }) {
  try {
    const { stdout } = await exec('git', argList, { cwd });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

// 결과물마다 어느 커밋으로 돌렸는지 남긴다. production 을 어디까지 받아왔는지는 merge-base 로 본다.
async function readGitInfo({ cwd = REPO_ROOT, exec = execFileAsync } = {}) {
  const [head, branch, productionMergeBase, status] = await Promise.all([
    runGit({ argList: ['rev-parse', 'HEAD'], cwd, exec }),
    runGit({ argList: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, exec }),
    runGit({ argList: ['merge-base', 'HEAD', 'production'], cwd, exec }),
    runGit({ argList: ['status', '--porcelain'], cwd, exec }),
  ]);
  return { head, branch, productionMergeBase, isDirty: status === null ? null : status.length > 0 };
}

module.exports = { readGitInfo, REPO_ROOT };
