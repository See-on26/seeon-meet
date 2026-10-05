const fs = require('fs');

// 재생 화면이 보내는 viewer 소리 녹음 조각을 받은 순서대로 파일에 이어 붙인다. 긴 영상도 메모리에 모으지 않는다.
// 쓰기 실패는 던지지 않고 모아 두었다가 close() 로 알린다. byteCount 는 실제로 쓴 바이트 수다.
function createOutputWriter({ filePath, fsApi = fs.promises }) {
  let byteCount = 0;
  let lastError = null;
  const keepError = (error) => { lastError = error; };
  let chain = fsApi.writeFile(filePath, Buffer.alloc(0)).catch(keepError);
  return {
    append(buffer) {
      const bytes = Buffer.from(buffer);
      chain = chain
        .then(() => fsApi.appendFile(filePath, bytes))
        .then(() => { byteCount += bytes.length; })
        .catch(keepError);
      return chain;
    },
    async close() {
      await chain;
      return { byteCount, error: lastError };
    },
  };
}

module.exports = { createOutputWriter };
