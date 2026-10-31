// 설치본 resources 의 .env 에 넣을 줄을 고른다. 앱이 실행 중에 읽는 SEEON_ 설정 줄만 남기고
// 주석·빈 줄·다른 키(외부 AI 서비스 키 등)·개발 PC 전용 값은 모두 버린다. 주석으로 적어 둔 접속 정보도 설치본에 들어가지 않는다.
const APP_ENV_KEY_PREFIX = 'SEEON_';
// 개발 PC 에서만 맞는 값. 설치본에 들어가면 Windows 에 없는 맥 경로를 가리키거나 터널을 꺼 버린다.
const DEV_ONLY_ENV_KEY_LIST = ['SEEON_GPU_SSH_KEY', 'SEEON_GPU_TUNNEL'];
// 앱은 외부 AI 서비스(Bedrock·OpenAI·Gemini 등)를 쓰지 않으므로 그 설정은 SEEON_ 으로 시작해도 넣지 않는다.
const UNUSED_APP_ENV_KEY_PREFIX_LIST = ['SEEON_BEDROCK_'];

const ENV_ENTRY_PATTERN = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/s;
const QUOTE_LIST = ['"', "'", '`'];

function readEnvKey(line) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : null;
}

function isPackagedEnvKey(key) {
  if (!key.startsWith(APP_ENV_KEY_PREFIX) || DEV_ONLY_ENV_KEY_LIST.includes(key)) return false;
  return !UNUSED_APP_ENV_KEY_PREFIX_LIST.some((prefix) => key.startsWith(prefix));
}

// 값 뒤 주석을 앱(Node 의 .env 읽기)과 같은 방식으로 뗀다. 따옴표 값은 닫는 따옴표까지, 따옴표 없는 값은 첫 # 앞까지가 값이다.
// 같은 줄에서 따옴표가 닫히지 않는 여러 줄 값은 첫 줄만 넣으면 값이 깨지므로 넣지 않는다(null).
function stripInlineComment(line) {
  const [, head, value] = line.match(ENV_ENTRY_PATTERN);
  if (QUOTE_LIST.includes(value[0])) {
    const closeIndex = value.indexOf(value[0], 1);
    return closeIndex < 0 ? null : head + value.slice(0, closeIndex + 1);
  }
  const hashIndex = value.indexOf('#');
  return (head + (hashIndex < 0 ? value : value.slice(0, hashIndex))).trimEnd();
}

// 설치본에 넣을 꼴로 바꾼 줄. 넣지 않을 줄이면 null.
function toPackagedEnvLine(line) {
  const key = readEnvKey(line);
  return key !== null && isPackagedEnvKey(key) ? stripInlineComment(line) : null;
}

// 앱(Node 의 .env 읽기)처럼 CR 은 모두 지우고 LF 로만 줄을 나눈다.
function splitEnvLine(text) {
  return text.replace(/\r/g, '').split('\n');
}

function sanitizeEnvText(text) {
  return splitEnvLine(text).map(toPackagedEnvLine).filter((line) => line !== null).join('\n');
}

// 설치본에 그대로 넣을 수 없는 줄 수(빈 줄은 세지 않는다). 줄 내용은 돌려주지 않는다.
function countUnpackagedEnvLine(text) {
  return splitEnvLine(text).filter((line) => line.trim() && toPackagedEnvLine(line) !== line.trimEnd()).length;
}

module.exports = { readEnvKey, sanitizeEnvText, countUnpackagedEnvLine, DEV_ONLY_ENV_KEY_LIST };
