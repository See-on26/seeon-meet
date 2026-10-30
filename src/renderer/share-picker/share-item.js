// 선택 창 항목을 화면 읽기 프로그램이 읽을 이름. 화면인지 창인지를 앞에 붙인다.
export function describeShareItem({ item, t }) {
  return t(item.kind === 'screen' ? 'sharePicker.screenItem' : 'sharePicker.windowItem', { name: item.name });
}
