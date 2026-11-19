// 보드 연결 — WebSocket 이 기본. 붙지 않거나(처음이든 쓰는 중이든) 연달아 끊기면 같은 규약의 HTTP(롱폴링 + POST)로 넘어간다.
// 그림 묶음은 세 단계로 들고 있다: 보냄 → ack(서버가 받음, 사건 번호 seq) → saved(그 seq 까지 디스크에 들어감).
// saved 를 받기 전에는 지우지 않는다 — 서버가 저장 전에 꺼져도 다시 붙으면 다시 보낸다(서버 병합은 같은 것을 두 번 받아도 같다).
import { api } from "./api.js";

const CHUNK = 400;          // 서버 한 번 상한(2000)보다 작게 — 잘려 사라지는 요소가 없게
const WS_FAILS_TO_HTTP = 3; // 연달아 이만큼 못 붙으면 HTTP 로(처음 연결 여부와 상관없이)

export function connect({ id, client, sync, onEvent, onPresence, onReset, onStatus, deps = {} }) {
  const WS = deps.WebSocket || globalThis.WebSocket;
  const net = deps.api || api;
  const loc = deps.location || globalThis.location;
  let ws = null, mode = "ws", alive = true, wsFails = 0, nextId = 1;
  const unacked = new Map();   // 묶음 id → 요소들(아직 ack 전)
  const unsaved = new Map();   // 묶음 id → { els, seq }(ack 받았고 저장 확인 전)
  let pollCtrl = null, hb = null, lastPresence = null;
  let resetting = null, held = [];   // 전체를 다시 맞추는 동안 온 사건은 모았다가 뒤에 적용
  sync.saved = sync.saved || 0;

  const status = (s) => onStatus && onStatus(s);
  const markSaved = (upto) => {
    if (typeof upto !== "number") return;
    sync.saved = Math.max(sync.saved, upto);
    for (const [mid, b] of unsaved) if (b.seq <= sync.saved) unsaved.delete(mid);
  };
  const outstanding = () => [...unacked.entries(), ...[...unsaved.entries()].map(([mid, b]) => [mid, b.els])];
  const applyEvents = (evs) => evs.forEach((ev) => { onEvent(ev.event, ev.data); if (ev.seq) sync.seq = Math.max(sync.seq, ev.seq); });
  const startReset = (msg) => {
    sync.epoch = msg.epoch; sync.seq = msg.seq; held = [];
    // 새 판(서버 재시작)의 사건 번호는 옛 번호와 무관 — 저장 확인을 기다리던 것도 다시 보낼 목록으로
    for (const [mid, b] of unsaved) unacked.set(mid, b.els);
    unsaved.clear();
    sync.saved = msg.saved || 0;
    resetting = (async () => {
      try { await onReset(msg.elements); }
      finally {
        const q = held; held = []; resetting = null;
        applyEvents(q);
        resendAll();
      }
    })();
  };

  function resendAll() {
    for (const [mid, els] of outstanding()) send(mid, els);
  }
  function send(mid, els) {
    if (mode === "ws") { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "elements", id: mid, elements: els })); }
    else postElements(mid, els);
  }

  // ---------------- WebSocket
  function openWs() {
    if (!alive || mode === "http") return;
    const proto = loc.protocol === "https:" ? "wss" : "ws";
    const q = `client=${encodeURIComponent(client)}&since=${sync.seq}&epoch=${encodeURIComponent(sync.epoch || "")}`;
    let opened = false;
    try { ws = new WS(`${proto}://${loc.host}/api/whiteboard/boards/${id}/ws?${q}`); } catch (_) { return failed(); }
    const giveUp = setTimeout(() => { if (!opened) { try { ws.close(); } catch (_) { /* */ } } }, 6000);
    ws.onopen = () => {
      opened = true; wsFails = 0; clearTimeout(giveUp); status("");
      resendAll();
      if (lastPresence) ws.send(JSON.stringify({ t: "presence", ...lastPresence }));
      clearInterval(hb); hb = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 25000);
    };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch (_) { return; }
      if (msg.t === "ev") {
        if (resetting) { held.push(msg); return; }
        onEvent(msg.event, msg.data); sync.seq = Math.max(sync.seq, msg.seq);
      } else if (msg.t === "hello") {
        sync.epoch = msg.epoch; applyEvents(msg.events || []); sync.seq = Math.max(sync.seq, msg.seq); markSaved(msg.saved);
      } else if (msg.t === "reset") {
        startReset(msg);
      } else if (msg.t === "presence") {
        sync.pver = msg.pver; onPresence(msg.data);
      } else if (msg.t === "ack") {
        const els = unacked.get(msg.id);
        if (els) { unacked.delete(msg.id); if (msg.seq > sync.saved) unsaved.set(msg.id, { els, seq: msg.seq }); }
      } else if (msg.t === "saved") {
        markSaved(msg.seq);
      }
    };
    ws.onclose = () => {
      clearTimeout(giveUp); clearInterval(hb);
      if (!alive) return;
      failed();
    };
    ws.onerror = () => { /* onclose 가 뒤따른다 */ };
  }
  function failed() {
    wsFails += 1;
    status("다시 연결 중…");
    if (wsFails >= WS_FAILS_TO_HTTP) return fallback();   // 앞단이 업그레이드를 계속 막으면 새로고침 없이 HTTP 로
    setTimeout(openWs, Math.min(5000, 400 * wsFails));
  }

  // ---------------- HTTP(예비)
  function fallback() {
    if (mode === "http" || !alive) return;
    mode = "http";
    pollCtrl = new AbortController();
    resendAll();
    (async () => {
      let fails = 0;
      while (alive) {
        try {
          const r = await net.poll(id, client, sync.seq, sync.pver, sync.epoch, pollCtrl.signal, sync.saved);
          if (!alive) break;
          if (r.presence) { sync.pver = r.pver; onPresence(r.presence); }
          if (r.reset) { startReset({ epoch: r.epoch, seq: r.seq, saved: r.saved }); await resetting; continue; }
          applyEvents(r.events);
          sync.seq = Math.max(sync.seq, r.seq); sync.epoch = r.epoch || sync.epoch;
          markSaved(r.saved);
          status(""); fails = 0;
        } catch (e) {
          if (!alive || e.name === "AbortError") break;
          fails += 1; status("다시 연결 중…");
          await new Promise((res) => setTimeout(res, Math.min(5000, 600 * fails)));
        }
      }
    })();
    hb = setInterval(() => lastPresence && net.presence(id, client, lastPresence).catch(() => {}), 15000);
  }
  function postElements(mid, els) {
    net.push(id, client, els).then((r) => {
      if (!unacked.has(mid)) return;
      unacked.delete(mid);
      const seq = r && typeof r.seq === "number" ? r.seq : Infinity;
      if (seq > sync.saved) unsaved.set(mid, { els, seq });
    }, () => setTimeout(() => alive && unacked.has(mid) && postElements(mid, els), 1500));
  }

  openWs();
  return {
    sendElements(els) {
      for (let i = 0; i < els.length; i += CHUNK) {
        const part = els.slice(i, i + CHUNK), mid = nextId++;
        unacked.set(mid, part);   // 지금 못 보내면 다시 붙을 때 보낸다
        send(mid, part);
      }
    },
    sendPresence(p) {
      lastPresence = p;
      if (mode === "ws") { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "presence", ...p })); }
      else net.presence(id, client, p).catch(() => {});
    },
    pending: () => unacked.size + unsaved.size,
    mode: () => (mode === "http" ? "http" : ws && ws.readyState === 1 ? "ws" : "connecting"),
    close() {
      alive = false; clearInterval(hb);
      if (ws) { ws.onclose = null; try { ws.close(); } catch (_) { /* */ } }
      if (pollCtrl) pollCtrl.abort();
    },
  };
}
