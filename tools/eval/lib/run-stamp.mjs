const pad2 = (value) => String(value).padStart(2, '0');

// 결과 폴더 이름에 쓰는 로컬 시각 YYYYMMDD-HHmmss.
export function formatRunStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}
