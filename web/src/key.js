// 초대 키 — 주소의 ?k= 를 탭 저장소로 옮기고 주소에서 지운다. 모든 API 요청에 머리(X-Tb-Key)로, WebSocket 에는 ?k= 로 붙인다.
// 쿠키를 막는 브라우저(카카오톡 같은 앱 안 브라우저 · 사파리 추적 방지)에서도 링크만으로 들어오게.
const SLOT = "tb-key";
function grab() {
  let k = "";
  try {
    const u = new URL(location.href);
    k = u.searchParams.get("k") || "";
    if (k) {
      u.searchParams.delete("k");
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
    }
  } catch (_) { /* */ }
  const store = [() => sessionStorage, () => localStorage];
  if (k) { store.forEach((s) => { try { s().setItem(SLOT, k); } catch (_) { /* 막힘 */ } }); return k; }
  for (const s of store) { try { const v = s().getItem(SLOT); if (v) return v; } catch (_) { /* */ } }
  return "";
}
export const KEY = grab();

// 이름 — 쿠키가 막혀도 남게 탭 · 로컬 저장소에 두고 머리로 보낸다
export function getName() {
  for (const s of [() => sessionStorage, () => localStorage]) { try { const v = s().getItem("tb-name"); if (v) return v; } catch (_) { /* */ } }
  return memName;
}
let memName = "";
export function setName(n) {
  memName = n;
  for (const s of [() => sessionStorage, () => localStorage]) { try { s().setItem("tb-name", n); } catch (_) { /* */ } }
}
