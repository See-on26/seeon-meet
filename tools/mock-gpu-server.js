const http = require('http');

const MOCK_FACT_SHEET = {
  title: '2분기 매출 요약',
  summary: '2분기 매출과 성장률을 요약한 슬라이드',
  factList: [
    { text: '2분기 매출 120억 원', importance: 3 },
    { text: '전년 동기 대비 15% 성장', importance: 2 },
  ],
};
const MOCK_GROUNDING_CAPTION = '주황색 매출 항목, 120억 가리킴';
const GROUNDING_PROMPT_MARKER = '가리키는';

const PAGE_TRANSITION_PROMPT_MARKER = '화면 유형을 분류';
const MOCK_PAGE_TRANSITION = {
  screenType: 'ppt', pageNumber: null, pageTopic: '2분기 매출 요약',
  narration: '2분기 매출 요약, 매출 추이 표', describedElementList: ['매출 추이 표'],
};

const SLIDE_RECAPTION_PROMPT_MARKER = '요약본의 재료';
const MOCK_SLIDE_RECAPTION = {
  title: '2분기 매출 요약',
  bodyText: '분기별 매출 추이를 담은 표가 있다. 2분기 매출은 120억 원이고 전년 동기 대비 15% 성장했다.',
  annotationText: '2분기 행에 밑줄이 그어졌다.',
};

const MOCK_TRANSCRIPT_LIST = [
  '자 그럼 회의를 시작하겠습니다',
  '여기 이 부분을 보시면 매출이 크게 늘었습니다',
  '오른쪽 그래프를 주목해 주세요',
  '다들 자료는 확인하셨나요',
  '세 번째 항목이 이번 분기 핵심입니다',
  '이거 관련해서 질문 있으실까요',
];
let mockTranscriptIndex = 0;

function createBeepWav() {
  const sampleRate = 16000;
  const sampleCount = Math.floor(sampleRate * 0.4);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), 44 + i * 2);
  }
  return buffer;
}

function createMockMp3() {
  const id3Header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat([id3Header, frameHeader, Buffer.alloc(400)]);
}

function collectBody(request) {
  return new Promise((resolve) => {
    const chunkList = [];
    request.on('data', (chunk) => chunkList.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunkList)));
  });
}

function computeMockEmbedding(jpegBuffer) {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < jpegBuffer.length; i += 1) histogram[jpegBuffer[i]] += 1;
  const norm = Math.sqrt(histogram.reduce((sum, value) => sum + value * value, 0)) || 1;
  return histogram.map((value) => value / norm);
}

async function startMockServerList({ vlmPort = 8801, asrPort = 8802, ttsPort = 8803, embedPort = 8804 } = {}) {
  const vlmServer = http.createServer(async (request, response) => {
    const body = await collectBody(request);

    let content;

    if (body.includes(SLIDE_RECAPTION_PROMPT_MARKER)) content = JSON.stringify(MOCK_SLIDE_RECAPTION);
    else if (body.includes(GROUNDING_PROMPT_MARKER)) content = MOCK_GROUNDING_CAPTION;
    else if (body.includes(PAGE_TRANSITION_PROMPT_MARKER)) content = JSON.stringify(MOCK_PAGE_TRANSITION);
    else content = JSON.stringify(MOCK_FACT_SHEET);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const asrServer = http.createServer(async (request, response) => {
    await collectBody(request);
    const text = MOCK_TRANSCRIPT_LIST[mockTranscriptIndex % MOCK_TRANSCRIPT_LIST.length];
    mockTranscriptIndex += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      text,
      segmentList: [{ startSec: 0, endSec: 5, text }],
    }));
  });
  const beepWav = createBeepWav();
  const ttsServer = http.createServer(async (request, response) => {
    await collectBody(request);

    if (request.url.startsWith('/tts-long')) {
      response.writeHead(200, { 'content-type': 'audio/mpeg' });
      response.end(createMockMp3());
      return;
    }
    response.writeHead(200, { 'content-type': 'audio/wav' });
    response.end(beepWav);
  });

  const embedServer = http.createServer(async (request, response) => {
    const body = await collectBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ embedding: computeMockEmbedding(body) }));
  });

  const serverList = [
    [vlmServer, vlmPort], [asrServer, asrPort], [ttsServer, ttsPort], [embedServer, embedPort],
  ];
  await Promise.all(serverList.map(([server, port]) =>
    new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))));

  return {
    close: () => Promise.all(serverList.map(([server]) =>
      new Promise((resolve) => server.close(resolve)))).then(() => undefined),
  };
}

module.exports = { startMockServerList, createBeepWav };

if (require.main === module) {
  startMockServerList({}).then(() => {
    console.log('[mock] vlm:8801 asr:8802 tts:8803 embed:8804 대기 중');
  });
}
