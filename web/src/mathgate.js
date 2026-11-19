// 수식 창 — 미리보기 그림은 그것을 만든 입력(tex · 크기 · 색)의 판과 묶는다.
// 지금 입력과 같은 판일 때만 넣는다(새 식을 쓰고 조판 전에 넣으면 옛 그림이 새 식과 함께 들어가는 것을 막는다).
export const mathKey = (tex, size, color) => `${tex}\u0000${size}\u0000${color}`;
export function canInsert(prev, tex, size, color, busy, err) {
  return !!prev && prev.key === mathKey(tex, size, color) && !busy && !err;
}
