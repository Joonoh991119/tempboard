// 남은 시간 · 초대 링크 복사 — 목록과 보드가 같이 쓴다
export function left(expires) {
  if (!expires) return "";
  const s = expires - Date.now() / 1000;
  if (s <= 0) return "곧 닫혀요";
  if (s < 3600) return `${Math.ceil(s / 60)}분 뒤 닫혀요`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}시간 뒤 닫혀요`;
  return `${Math.round(s / 86400)}일 뒤 닫혀요`;
}

export async function copyInvite(me, kind, boardId) {
  const key = me.invite && me.invite[kind];
  const url = key ? `${location.origin}/?k=${encodeURIComponent(key)}${boardId ? `#b=${boardId}` : ""}` : `${location.origin}/${boardId ? `#b=${boardId}` : ""}`;
  try { await navigator.clipboard.writeText(url); return url; } catch (_) { window.prompt && window.prompt("이 링크를 복사해 보내세요", url); return url; }
}
