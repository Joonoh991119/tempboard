import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Excalidraw, MainMenu, CaptureUpdateAction, reconcileElements, restoreElements,
  convertToExcalidrawElements, viewportCoordsToSceneCoords, FONT_FAMILY, exportToBlob,
} from "@excalidraw/excalidraw";
import { selectedTexts, selectedStyle, restyleText } from "./textstyle.js";
import { api } from "./api.js";
import { texToSvg, svgDataURL, sha1 } from "./math.js";
import { connect } from "./transport.js";
import { mathKey, canInsert } from "./mathgate.js";
import { copyInvite, left } from "./invite.js";

const PUSH_MS = 80;        // 바뀐 요소를 묶어 보내는 간격
const PUSH_DRAW_MS = 160;  // 펜으로 긋는 중에는 조금 넓게(점이 많은 선을 너무 자주 보내지 않게)
const POINTER_MS = 70;     // 커서 위치를 보내는 간격

// 도구 — 이것만 쓴다(도형 · 화살표 · 채우기 · 레이어는 뺐다)
// 펜 · 글 색 — 누구나 아무 색이나 고른다(사람 색은 커서 · 이름표에만). 노랑은 흰 바탕에서 안 보여 뺐다.
// 검정 · 회색은 테마와 상관없이 같은 값으로 저장한다 — 어두운 화면은 그림판 전체를 뒤집어 그리므로(Excalidraw 의 invert 필터) 검정은 어두운 화면에서 밝게 보인다.
const PALETTE = [
  ["#1e1e1e", "검정"], ["#868e96", "회색"], ["#E31A1C", "빨강"], ["#D55E00", "주황"],
  ["#009E73", "초록"], ["#0072B2", "파랑"], ["#7B61FF", "보라"], ["#CC79A7", "분홍"],
];
// '더 보기' 색 — 진하기 둘씩(밝은 화면 · 어두운 화면 모두에서 보이는 것만). 그 밖은 '직접 고르기'.
const MORE_COLORS = [
  "#7f1d1d", "#b91c1c", "#f87171", "#9a3412", "#ea580c", "#fb923c",
  "#854d0e", "#ca8a04", "#eab308", "#14532d", "#16a34a", "#4ade80",
  "#134e4a", "#0d9488", "#2dd4bf", "#1e3a8a", "#2563eb", "#60a5fa",
  "#312e81", "#4f46e5", "#a78bfa", "#831843", "#db2777", "#f472b6",
  "#78350f", "#a16207", "#57534e", "#374151", "#6b7280", "#9ca3af",
];
const DARK_FILTER = "invert(93%) hue-rotate(180deg)";   // Excalidraw 가 어두운 화면에서 그림판에 거는 필터 — 색 단추도 실제로 그려지는 색으로 보이게
const TOOLS = [
  { id: "selection", label: "선택·옮기기", key: "V", icon: "M5 3l6 16 2.5-6.5L20 10z" },
  { id: "freedraw", label: "펜", key: "P", icon: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" },
  { id: "eraser", label: "지우개", key: "E", icon: "M7 20h11M4 15l8-8 6 6-5 5H8z" },
  { id: "text", label: "글", key: "T", icon: "M5 5h14M12 5v14M9 19h6" },
  { id: "math", label: "수식", key: "M", icon: "M6 5h12l-7 7 7 7H6" },
  { id: "laser", label: "레이저", key: "K", icon: "M12 12m-2 0a2 2 0 104 0 2 2 0 10-4 0M4 20l6-6M14 4l2 3M20 10l-3 1M17 4l-2 3" },
  { id: "hand", label: "화면 이동", key: "H", icon: "M8 12V6a1.5 1.5 0 013 0v5V4.5a1.5 1.5 0 013 0V11V6a1.5 1.5 0 013 0v7a6 6 0 01-6 6h-1a6 6 0 01-5-3l-2-4a1.5 1.5 0 012.5-1.5z" },
];
// 글꼴 — Excalidraw 글꼴 칸마다 한글 글꼴을 붙였다(kfonts.css · kfonts-extra.css). 영문은 그 칸의 Excalidraw 글꼴.
const FONTS = [
  { id: "meet", label: "고딕", css: "Nunito", family: FONT_FAMILY.Nunito, hint: "Noto Sans KR · Nunito" },
  { id: "cute", label: "손글씨", css: "Excalifont", family: FONT_FAMILY.Excalifont, hint: "Gaegu · Excalifont" },
  { id: "pen", label: "펜글씨", css: "Virgil", family: FONT_FAMILY.Virgil, hint: "나눔손글씨 펜 · Virgil" },
  { id: "round", label: "동글", css: "Comic Shanns", family: FONT_FAMILY["Comic Shanns"], hint: "주아 · Comic Shanns" },
  { id: "bold", label: "굵은 제목", css: "Lilita One", family: FONT_FAMILY["Lilita One"], hint: "검은고딕 · Lilita One" },
  { id: "serif", label: "명조", css: "Liberation Sans", family: FONT_FAMILY["Liberation Sans"], hint: "나눔명조 · Liberation Sans" },
  { id: "code", label: "코드", css: "Cascadia", family: FONT_FAMILY.Cascadia, hint: "나눔고딕코딩 · Cascadia" },
  { id: "math", label: "수식(TeX)", css: "Times New Roman", family: null, hint: "LaTeX 를 MathJax TeX 글꼴로 조판" },
];
const SIZES = [12, 16, 20, 24, 28, 36, 48, 64, 96];
const stepSize = (s, d) => {
  const i = SIZES.findIndex((x) => x >= (s || 24));
  const at = i < 0 ? SIZES.length - 1 : i;
  return SIZES[Math.max(0, Math.min(SIZES.length - 1, SIZES[at] === s || d < 0 ? at + d : at + d - 1))];
};
const bump = (e) => ({ ...e, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) });
// 칠 수 있는 단축키 — 나머지 한 글자 단축키(도형 · 화살표 등)는 막는다
const ALLOWED_KEYS = new Set(["v", "p", "e", "t", "k", "h", "m", "1", "7", "8", "0", "escape", "delete", "backspace", "enter", " ",
  "arrowup", "arrowdown", "arrowleft", "arrowright", "shift", "control", "meta", "alt", "tab"]);

const norm = (c) => String(c || "").toLowerCase();

// 색이 '같다' — 같은 hex 이거나, 둘 다 채도가 있는 색이고 색상(hue)이 18° 안이면 같은 색으로 본다(서버 similar() 와 같다)
function hsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}
export function sameColor(a, b) {
  if (norm(a) === norm(b)) return true;
  const x = hsl(a), y = hsl(b);
  if (!x || !y || x.s < 0.35 || y.s < 0.35 || x.l < 0.18 || y.l < 0.18 || x.l > 0.85 || y.l > 0.85) return false;
  const dh = Math.abs(x.h - y.h);
  return Math.min(dh, 360 - dh) <= 18;
}

// Excalidraw 는 커서 · 레이저 색을 사람 id 의 해시로 정한다(hsl(해시 % 37 × 10°, 100%, 83%)) — 넘긴 색은 쓰지 않는다.
// 그래서 해시 색상이 그 사람 고정 색의 색상과 가장 가까워지는 id 를 골라 넘긴다(같은 사람은 늘 같은 id).
function excalHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h << 5) - h + id.charCodeAt(i);
  return (Math.abs(h) % 37) * 10;
}
const hueIdCache = new Map();
function idForColor(user, hex) {
  const key = user + hex;
  if (hueIdCache.has(key)) return hueIdCache.get(key);
  const target = (hsl(hex) || { h: 0 }).h;
  let best = user, bestD = 999;
  for (let n = 0; n < 400 && bestD > 0; n++) {
    const id = `${user}~${n}`, d = Math.abs(excalHue(id) - target), dd = Math.min(d, 360 - d);
    if (dd < bestD) { best = id; bestD = dd; }
  }
  hueIdCache.set(key, best);
  return best;
}

// 서버와 같은 병합 규칙(version 큰 쪽, 같으면 versionNonce 작은 쪽) — 내 것이 이기면 true
export function localWins(mine, server) {
  if (!server) return true;
  if (mine.version !== server.version) return mine.version > server.version;
  return mine.versionNonce < server.versionNonce;
}

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* 저장소 막힘 */ } },
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Icon({ d }) {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

// ---------------------------------------------------------------- 수식 넣기 창
function MathDialog({ initial, color, onCancel, onInsert }) {
  const [tex, setTex] = useState(initial?.latex || "x_{t+1} = A\\,x_t + b");
  const [size, setSize] = useState(initial?.size || 32);
  const [prev, setPrev] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  // 미리보기는 만든 입력(tex · 크기 · 색)과 묶는다 — 지금 입력과 같은 판일 때만 넣을 수 있다(옛 그림이 새 식과 들어가지 않게)
  const key = mathKey(tex, size, color);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await texToSvg(tex, { size, color });
        if (!alive) return;
        setPrev({ ...r, key }); setErr(r.error || "");
      } catch (e) { if (alive) { setPrev(null); setErr(String(e.message || e)); } }
      if (alive) setBusy(false);
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [tex, size, color, key]);
  const ready = canInsert(prev, tex, size, color, busy, err);
  const doInsert = () => { if (ready) onInsert(tex, size, prev); };
  const examples = ["\\frac{dS}{dt} = -\\beta S I", "\\hat\\theta = \\arg\\max_\\theta \\, p(y\\mid\\theta)", "\\sum_{i=1}^{n} x_i", "R_0 = \\beta / \\gamma"];
  return (
    <div className="wb-modal" role="dialog" aria-label="수식 넣기" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); e.stopPropagation(); }}>
      <div className="wb-modal-box">
        <h2>{initial ? "수식 고치기" : "수식 넣기"}</h2>
        <p className="wb-muted">LaTeX 로 쓰면 바로 조판해 보여 줘요. 넣은 수식을 고치려면 선택하고 다시 '수식' 을 누르세요.</p>
        <textarea autoFocus rows={3} value={tex} onChange={(e) => setTex(e.target.value)} aria-label="LaTeX" spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doInsert(); } }} />
        <div className="wb-examples">{examples.map((x) => <button key={x} type="button" onClick={() => setTex(x)}>{x}</button>)}</div>
        <label className="wb-slider">크기 <input type="range" min="18" max="80" value={size} onChange={(e) => setSize(+e.target.value)} /> <span>{size}</span></label>
        <div className="wb-preview" aria-live="polite">
          {busy && !prev ? <span className="wb-muted">조판 중…</span> : prev && <img alt="수식 미리보기" className={prev.key === key ? "" : "wb-stale"} src={svgDataURL(prev.svg)} />}
        </div>
        {err && <p className="wb-err">{err}</p>}
        <div className="wb-modal-actions">
          <button type="button" className="wb-btn" onClick={onCancel}>취소</button>
          <button type="button" className="wb-primary" disabled={!ready} onClick={doInsert}>{initial ? "바꾸기" : "넣기"} (⌘/Ctrl+Enter)</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 보드
export default function Board({ id, me }) {
  const client = useMemo(() => Math.random().toString(36).slice(2, 10), []);
  const [excal, setExcalRaw] = useState(null);
  const setExcal = useCallback((a) => { setExcalRaw(a); window.__wbapi = a; }, []);
  const [theme, setTheme] = useState(() => store.get("wb-theme", "light"));
  const [tool, setTool] = useState("freedraw");
  const [width, setWidth] = useState(() => { const w = +store.get("wb-width2", 1.5); return w >= 0.5 && w <= 8 ? w : 1.5; });
  const [font, setFont] = useState(() => { const f = store.get("wb-font", "meet"); return FONTS.some((x) => x.id === f && x.family) ? f : "meet"; });
  const [fontSize, setFontSize] = useState(() => +store.get("wb-fontsize", 24));
  const [ink, setInk] = useState(() => { const c = store.get("wb-ink", ""); return /^#[0-9a-f]{6}$/i.test(c) ? c : "#1e1e1e"; });   // 기본은 검정(사람 색은 노랑일 수 있어 흰 바탕에서 안 보인다)
  const [math, setMath] = useState(null);        // 수식 창 { initial }
  const [textSel, setTextSel] = useState(false);   // 글이 하나라도 선택돼 있나 — 글꼴 · 크기 칸을 보이고 바로 바꾼다
  const [moreInk, setMoreInk] = useState(false);   // 색 더 보기 창
  const [mathSel, setMathSel] = useState(false); // 수식 하나가 선택돼 있나 — 버튼이 '수식 고침' 으로
  const [editing, setEditing] = useState(false);   // 글 상자를 쓰는 중인가(글꼴 · 크기 칸을 그대로 둔다)
  const [fontPop, setFontPop] = useState(false);   // 글꼴 고르기 창
  const [menu, setMenu] = useState(false);         // 폰 메뉴
  const [sheet, setSheet] = useState(null);        // 폰 글 쓰기 창 { x, y, editId }
  const [sheetText, setSheetText] = useState("");
  const sheetRef = useRef(null);
  const tap = useRef(null);                        // 폰: 글 도구로 누른 자리 · 두 번 누른 글
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const dockRef = useRef(null);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const coarse = useMemo(() => window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0 && !window.matchMedia("(pointer: fine)").matches, []);
  const [meta, setMeta] = useState(null);
  const [initial, setInitial] = useState(null);
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState("연결 중…");
  const sent = useRef(new Map());        // 요소 id → 서버와 맞춘 version
  const pending = useRef(new Map());     // 보낼 요소
  const uploaded = useRef(new Set());    // 서버에 있는 파일 id
  const fetching = useRef(new Set());
  const timer = useRef(null);
  const lastPtr = useRef(0);
  const sync = useRef({ seq: 0, pver: -1, epoch: "" });
  const drawing = useRef(false);


  // 처음 불러오기 — 실패하면 잠시 뒤 다시(빈 화면으로 두지 않는다)
  useEffect(() => {
    let alive = true, tries = 0;
    const load = () => api.board(id).then(async (d) => {
      if (!alive) return;
      setMeta(d.meta);
      sync.current = { seq: d.seq || 0, pver: -1, epoch: d.epoch || "" };
      d.files.forEach((f) => uploaded.current.add(f));
      const els = restoreElements(d.elements, null);
      els.forEach((e) => sent.current.set(e.id, e.version));
      const need = [...new Set(els.filter((e) => e.type === "image" && e.fileId && !e.isDeleted).map((e) => e.fileId))];
      const files = (await Promise.all(need.map((fid) => api.getFile(id, fid).catch(() => null)))).filter(Boolean);
      setStatus("");
      setInitial({
        elements: els, files, scrollToContent: true,
        appState: { currentItemStrokeColor: ink, currentItemStrokeWidth: width, currentItemFontFamily: FONTS.find((f) => f.id === font)?.family || FONT_FAMILY.Nunito,
          currentItemFontSize: fontSize, currentItemRoughness: 0, currentItemBackgroundColor: "transparent", activeTool: { type: "freedraw", customType: null, locked: true, lastActiveTool: null } },
      });
    }, (e) => {
      if (!alive) return;
      tries += 1;
      setStatus(`불러오는 중… (${e.message}, 다시 시도 ${tries})`);
      setTimeout(load, Math.min(8000, 1000 * tries));
    });
    load();
    return () => { alive = false; };
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fetchMissingFiles = useCallback(async (api_, elements) => {
    const have = api_.getFiles();
    const need = [...new Set(elements.filter((e) => e.type === "image" && e.fileId && !have[e.fileId] && !fetching.current.has(e.fileId)).map((e) => e.fileId))];
    if (!need.length) return;
    need.forEach((f) => fetching.current.add(f));
    const files = (await Promise.all(need.map((fid) => api.getFile(id, fid).catch(() => null)))).filter(Boolean);
    need.forEach((f) => fetching.current.delete(f));
    if (files.length) { files.forEach((f) => uploaded.current.add(f.id)); api_.addFiles(files); }
  }, [id]);

  // 실시간 — WebSocket(안 되면 조용히 HTTP 로). 남의 변경은 내 실행취소 기록 밖으로, 서버가 다시 켜지면 지우지 않고 합친다.
  const link = useRef(null);
  useEffect(() => {
    if (!excal) return;
    const onElements = (elements) => {
      if (!elements || !elements.length) return;
      const merged = reconcileElements(excal.getSceneElementsIncludingDeleted(), elements, excal.getAppState());
      elements.forEach((e) => { if ((sent.current.get(e.id) ?? -1) <= e.version) sent.current.set(e.id, e.version); });
      excal.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
      fetchMissingFiles(excal, elements);
    };
    const onPresence = (list) => {
      setUsers(list);
      const collaborators = new Map();
      list.filter((p) => p.client !== client).forEach((p) => collaborators.set(p.client, {
        username: p.short || p.user, pointer: p.pointer || undefined, button: p.button, selectedElementIds: p.selected || {},
        color: { background: p.color + "33", stroke: p.color }, id: idForColor(p.user, p.color), socketId: p.client,
      }));
      excal.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
    };
    const onEvent = (event, data) => {
      if (event === "elements") onElements(data.elements);
      else if (event === "file") { uploaded.current.add(data.id); fetchMissingFiles(excal, excal.getSceneElements()); }
      else if (event === "meta") setMeta(data);
    };
    const onReset = async (given) => {   // 서버가 다시 켜졌거나 기록이 밀렸다 — 전체를 받아 합치고, 서버에 없는 내 요소는 다시 보낸다
      const d = given ? { elements: given } : await api.board(id);
      onElements(d.elements);
      // 서버에 없거나, 서버 것보다 내 것이 이기는(더 새) 요소 — 수정 · 삭제 모두 — 를 다시 보낸다(서버가 저장 전에 꺼졌던 경우)
      const server = new Map(d.elements.map((e) => [e.id, e]));
      const mine = excal.getSceneElementsIncludingDeleted().filter((e) => localWins(e, server.get(e.id)));
      if (mine.length && link.current) link.current.sendElements(mine);
      if (!given) { sync.current.seq = d.seq || 0; sync.current.epoch = d.epoch || sync.current.epoch; }
    };
    link.current = connect({ id, client, sync: sync.current, onEvent, onPresence, onReset, onStatus: setStatus });
    window.__wblink = link.current;
    return () => { link.current && link.current.close(); link.current = null; };
  }, [excal, id, client, fetchMissingFiles]);

  // 보내기 — 묶어서 transport 로(ack 전까지 들고 있다가 다시 붙으면 다시 보낸다)
  const flush = useCallback(() => {
    timer.current = null;
    const batch = [...pending.current.values()];
    pending.current.clear();
    if (batch.length && link.current) link.current.sendElements(batch);
  }, []);

  const onChange = useCallback((elements, appState, files) => {
    if (!excal) return;
    // 도구 상태를 도구막대와 맞춘다(단축키로 바꿨을 때)
    const t = appState.activeTool?.type;
    if (t && t !== tool && TOOLS.some((x) => x.id === t)) setTool(t);
    drawing.current = !!appState.newElement && appState.newElement.type === "freedraw";
    const selIds = Object.keys(appState.selectedElementIds || {}).filter((k) => appState.selectedElementIds[k]);
    const ms = selIds.length === 1 && elements.some((e) => e.id === selIds[0] && e.type === "image" && e.customData && e.customData.latex);
    if (ms !== mathSel) setMathSel(ms);
    const ed = !!appState.editingTextElement;
    if (ed !== editing) setEditing(ed);
    const texts = selectedTexts(elements, appState.selectedElementIds || {});
    const ts = texts.length > 0;
    if (ts) {
      const current = selectedStyle(texts, FONTS);
      setFont(current.font); setFontSize(current.fontSize);
    }
    if (ts !== textSel) setTextSel(ts);
    for (const e of elements) {
      if ((sent.current.get(e.id) ?? -1) !== e.version) {
        pending.current.set(e.id, e);
        sent.current.set(e.id, e.version);
      }
    }
    for (const f of Object.values(files || {})) {
      if (!uploaded.current.has(f.id) && f.dataURL) {
        uploaded.current.add(f.id);
        api.putFile(id, client, f).catch((e) => { uploaded.current.delete(f.id); setStatus(`이미지 올리기 실패: ${e.message}`); });
      }
    }
    if (pending.current.size && !timer.current) timer.current = setTimeout(flush, drawing.current ? PUSH_DRAW_MS : PUSH_MS);
  }, [excal, tool, me, id, client, flush, mathSel, textSel, editing]);

  const onPointerUpdate = useCallback(({ pointer, button }) => {
    const now = Date.now();
    if (now - lastPtr.current < POINTER_MS) return;
    lastPtr.current = now;
    const sel = excal ? excal.getAppState().selectedElementIds : {};
    link.current && link.current.sendPresence({ pointer, button, selected: sel });
  }, [excal]);

  // ---------------- 도구막대 동작
  const pick = useCallback((t) => {
    if (!excal) return;
    if (t === "math") { openMath(); return; }   // eslint-disable-line no-use-before-define
    excal.setActiveTool({ type: t, locked: t === "freedraw" || t === "eraser" || t === "laser" });
    setTool(t);
  }, [excal]);   // eslint-disable-line react-hooks/exhaustive-deps

  const selectedIds = () => Object.keys(excal.getAppState().selectedElementIds || {}).filter((k) => excal.getAppState().selectedElementIds[k]);

  const applyToSelection = useCallback((patch, pred) => {
    if (!excal) return;
    const ids = new Set(selectedIds());
    if (!ids.size) return;
    const els = excal.getSceneElementsIncludingDeleted().map((e) => (ids.has(e.id) && (!pred || pred(e)) ? { ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : e));
    excal.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, [excal]);   // eslint-disable-line react-hooks/exhaustive-deps

  const setStroke = (w) => {
    setWidth(w); store.set("wb-width2", w);
    excal?.updateScene({ appState: { currentItemStrokeWidth: w }, captureUpdate: CaptureUpdateAction.NEVER });
    applyToSelection({ strokeWidth: w }, (e) => e.type === "freedraw");
  };
  const setInkColor = (c) => {
    setInk(c); store.set("wb-ink", c);
    excal?.updateScene({ appState: { currentItemStrokeColor: c }, captureUpdate: CaptureUpdateAction.NEVER });
    if (sheet) return;   // 글 쓰기 창의 색 — 넣을 때 쓴다
    applyToSelection({ strokeColor: c }, (e) => e.type !== "image");
  };
  // 선택한 글을 새 글꼴 · 크기로 다시 잰다(글꼴만 바꾸면 상자 크기가 옛 글꼴대로 남는다)
  const restyleSelectedText = (patch) => {
    if (!excal || sheet) return false;
    const st = excal.getAppState();
    const sel = { ...(st.selectedElementIds || {}) };
    if (st.editingTextElement) sel[st.editingTextElement.id] = true;   // 쓰는 중인 글도 바로 바꾼다
    const els = restyleText(excal.getSceneElementsIncludingDeleted(), sel, patch, restoreElements);
    if (!els) return false;
    excal.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    return true;
  };
  const setFontChoice = (f) => {
    setFontPop(false);
    if (f === "math") { openMath(); return; }   // eslint-disable-line no-use-before-define
    setFont(f); store.set("wb-font", f);
    const fam = FONTS.find((x) => x.id === f).family;
    excal?.updateScene({ appState: { currentItemFontFamily: fam }, captureUpdate: CaptureUpdateAction.NEVER });
    if (restyleSelectedText({ fontFamily: fam })) return;   // 고른 글이 있으면 그 글을 바꾸고 도구는 그대로
    if (tool !== "text" && !sheet) pick("text");
  };
  const setTextSize = (s) => {
    if (!s) return;
    setFontSize(s); store.set("wb-fontsize", s);
    excal?.updateScene({ appState: { currentItemFontSize: s }, captureUpdate: CaptureUpdateAction.NEVER });
    restyleSelectedText({ fontSize: s });
  };
  // 도구막대를 눌러도 초점은 그림판에 — 그래야 붙여넣기(⌘V) · 단축키가 그대로 듣는다
  const refocus = () => {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && !a.closest(".wb-dock")) return;
    const c = document.querySelector(".excalidraw");
    if (c && !c.contains(document.activeElement)) { c.setAttribute("tabindex", "-1"); c.focus({ preventScroll: true }); }
  };
  const toggleTheme = () => { const t = theme === "dark" ? "light" : "dark"; setTheme(t); store.set("wb-theme", t); };
  const key = (k, shift = false) => {   // Excalidraw 실행취소 · 다시 실행은 키보드로만 열려 있다
    const ev = new KeyboardEvent("keydown", { key: shift ? k.toUpperCase() : k, code: "Key" + k.toUpperCase(), bubbles: true, cancelable: true, shiftKey: shift, ctrlKey: !isMac, metaKey: isMac });
    document.dispatchEvent(ev);
  };
  const deleteSelected = () => {
    if (!excal) return;
    const ids = new Set(selectedIds());
    if (!ids.size) { excal.setToast({ message: "지울 것을 먼저 선택하세요(선택 도구로 끌어서 영역 선택)", duration: 2500 }); return; }
    const els = excal.getSceneElementsIncludingDeleted().map((e) => (ids.has(e.id) || (e.containerId && ids.has(e.containerId)) ? { ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : e));
    excal.updateScene({ elements: els, appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };

  const savePng = async () => {
    if (!excal) return;
    const els = excal.getSceneElements();
    if (!els.length) { excal.setToast({ message: "저장할 그림이 없어요", duration: 2000 }); return; }
    const blob = await exportToBlob({ elements: els, files: excal.getFiles(), appState: { ...excal.getAppState(), exportBackground: true }, mimeType: "image/png" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${(meta && meta.title) || "board"}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // ---------------- 폰: 글은 아래 창에서 쓴다
  // Excalidraw 의 글 상자는 누른 뒤 타이머로 초점을 줘서, 폰(특히 iOS)에서는 자판이 안 뜨고 빈 상자만 남는다.
  // 폰에서는 늘 붙어 있는 입력칸에 누르는 그 순간 초점을 줘서 자판이 바로 뜨게 한다.
  const hitText = (sx, sy) => excal.getSceneElements().filter((e) => e.type === "text" && !e.containerId)
    .reverse().find((e) => sx >= e.x - 10 && sx <= e.x + e.width + 10 && sy >= e.y - 10 && sy <= e.y + e.height + 10);
  const openSheet = (cx, cy, hit) => {
    const st = excal.getAppState();
    const sc = viewportCoordsToSceneCoords({ clientX: cx, clientY: cy }, st);
    const el = hit === undefined ? hitText(sc.x, sc.y) : hit;
    if (sheetRef.current) sheetRef.current.focus({ preventScroll: true });   // 누른 그 순간 — 자판이 뜬다
    setSheetText(el ? (el.originalText ?? el.text) : "");
    if (el) { const f = FONTS.find((x) => x.family === el.fontFamily); if (f) setFont(f.id); setFontSize(el.fontSize); if (el.strokeColor) setInk(el.strokeColor); }
    setSheet({ x: sc.x, y: sc.y, editId: el ? el.id : null });
  };
  const closeSheet = () => { setSheet(null); setSheetText(""); if (sheetRef.current) sheetRef.current.blur(); };
  const commitSheet = () => {
    if (!excal || !sheet) return;
    const text = sheetText.replace(/\s+$/, "");
    const fam = (FONTS.find((x) => x.id === font) || FONTS[0]).family || FONT_FAMILY.Nunito;
    const size = fontSize || 24;
    let els = excal.getSceneElementsIncludingDeleted();
    let select = {};
    if (sheet.editId) {
      if (!text) els = els.map((e) => (e.id === sheet.editId ? bump({ ...e, isDeleted: true }) : e));
      else {
        const input = els.map((e) => (e.id === sheet.editId ? { ...e, text, originalText: text, fontFamily: fam, fontSize: size, strokeColor: ink } : e));
        const m = new Map(restoreElements(input, null, { repairBindings: true, refreshDimensions: true }).map((e) => [e.id, e]));
        els = els.map((e) => (e.id === sheet.editId ? bump({ ...e, ...m.get(e.id) }) : e));
        select = { [sheet.editId]: true };
      }
    } else if (text) {
      const [el] = convertToExcalidrawElements([{ type: "text", x: sheet.x, y: sheet.y - size * 0.6, text, fontSize: size, fontFamily: fam, strokeColor: ink, roughness: 0 }]);
      els = [...els, el];
      select = { [el.id]: true };
    }
    excal.updateScene({ elements: els, appState: { selectedElementIds: select }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    excal.setActiveTool({ type: "selection" }); setTool("selection");
    closeSheet();
  };
  useEffect(() => {
    if (!excal || !coarse || me.role === "view") return;
    const onCanvas = (e) => e.target instanceof HTMLCanvasElement && e.target.closest(".excalidraw");
    const down = (e) => {
      if (!onCanvas(e) || !e.isPrimary) return;
      const t = excal.getAppState().activeTool.type;
      if (t === "text") {   // 글 도구: Excalidraw 가 글 상자를 만들지 않게 막고, 손을 뗄 때 창을 연다
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        tap.current = { x: e.clientX, y: e.clientY, touch: e.pointerType === "touch", hit: undefined };
        return;
      }
      if (t === "selection") {   // 같은 글을 빨리 두 번 누르면 고치기
        const now = Date.now(), L = lastTap.current;
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
        if (now - L.t < 400 && Math.hypot(e.clientX - L.x, e.clientY - L.y) < 24) {
          const sc = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, excal.getAppState());
          const hit = hitText(sc.x, sc.y);
          if (hit) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); tap.current = { x: e.clientX, y: e.clientY, touch: e.pointerType === "touch", hit }; lastTap.current = { t: 0, x: 0, y: 0 }; }
        }
      }
    };
    const stopTouch = (e) => {   // Excalidraw 의 두 번 누르기(글 상자 열기)도 막는다
      if (tap.current && onCanvas(e)) { e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    const finish = (e) => {
      const t = tap.current; if (!t) return;
      tap.current = null;
      e.stopPropagation();
      if (Math.hypot((e.clientX ?? e.changedTouches?.[0]?.clientX ?? t.x) - t.x, (e.clientY ?? e.changedTouches?.[0]?.clientY ?? t.y) - t.y) > 16) return;
      openSheet(t.x, t.y, t.hit);
    };
    const up = (e) => { if (tap.current && !tap.current.touch) finish(e); else if (tap.current) e.stopPropagation(); };
    const end = (e) => { if (tap.current && tap.current.touch) { if (e.cancelable) e.preventDefault(); finish(e); } };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("touchstart", stopTouch, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("touchend", end, { capture: true, passive: false });
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("touchstart", stopTouch, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("touchend", end, { capture: true, passive: false });
    };
  }, [excal, coarse, me.role]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = window.matchMedia("(max-width: 760px)");
    const f = () => setMobile(q.matches);
    q.addEventListener ? q.addEventListener("change", f) : q.addListener(f);
    return () => (q.removeEventListener ? q.removeEventListener("change", f) : q.removeListener(f));
  }, []);
  // 떠 있는 창(색 · 글꼴)을 도구막대 바로 위에 — 폰에서는 도구막대가 두 줄이라 높이를 잰다
  useEffect(() => {
    const d = dockRef.current; if (!d || !("ResizeObserver" in window)) return;
    const ro = new ResizeObserver(() => d.parentElement && d.parentElement.style.setProperty("--dock-h", `${d.offsetHeight}px`));
    ro.observe(d);
    return () => ro.disconnect();
  });

  // ---------------- 수식
  const openMath = useCallback(() => {
    if (!excal) return;
    const ids = selectedIds();
    const sel = ids.length === 1 ? excal.getSceneElements().find((e) => e.id === ids[0]) : null;
    setMath({ initial: sel && sel.type === "image" && sel.customData?.latex ? { ...sel.customData, id: sel.id, x: sel.x, y: sel.y } : null });
  }, [excal]);   // eslint-disable-line react-hooks/exhaustive-deps

  const insertMath = useCallback(async (tex, size, r) => {
    if (!excal) return;
    const svg = r.svg;
    const fid = (await sha1(svg)).slice(0, 40);
    excal.addFiles([{ id: fid, mimeType: "image/svg+xml", dataURL: svgDataURL(svg), created: Date.now() }]);
    const st = excal.getAppState();
    const old = math?.initial;
    const c = old ? { x: old.x, y: old.y } : viewportCoordsToSceneCoords({ clientX: window.innerWidth / 2 - r.width / 2, clientY: window.innerHeight / 2 - r.height / 2 }, st);
    const [el] = convertToExcalidrawElements([{ type: "image", fileId: fid, x: c.x, y: c.y, width: r.width, height: r.height, status: "saved", customData: { latex: tex, size } }]);
    let els = excal.getSceneElementsIncludingDeleted();
    if (old) els = els.map((e) => (e.id === old.id ? { ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : e));
    excal.updateScene({ elements: [...els, el], appState: { selectedElementIds: { [el.id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setMath(null);
    setTimeout(refocus, 0);
    excal.setActiveTool({ type: "selection" });
    setTool("selection");
  }, [excal, math]);

  // 수식을 두 번 누르면 고치기 창(그림 자르기 대신)
  useEffect(() => {
    const onDbl = (e) => {
      if (!excal || !e.target || e.target.tagName !== "CANVAS") return;
      const st = excal.getAppState();
      const ids = Object.keys(st.selectedElementIds || {}).filter((k) => st.selectedElementIds[k]);
      const el = ids.length === 1 ? excal.getSceneElements().find((x) => x.id === ids[0]) : null;
      if (el && el.type === "image" && el.customData && el.customData.latex) { e.preventDefault(); e.stopPropagation(); openMath(); }
    };
    window.addEventListener("dblclick", onDbl, true);
    return () => window.removeEventListener("dblclick", onDbl, true);
  }, [excal, openMath]);

  // 도형 · 화살표 등 막은 도구의 한 글자 단축키를 막는다(글 쓰는 중에는 그대로)
  useEffect(() => {
    const onKey = (e) => {
      const tgt = e.target;
      if (tgt && (tgt.tagName === "TEXTAREA" || tgt.tagName === "INPUT" || tgt.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 한글 입력기가 켜져 있으면 e.key 가 'ㅅ' 처럼 온다 — 자판 위치(e.code)로 본다
      const k = /^Key[A-Z]$/.test(e.code || "") ? e.code.slice(3).toLowerCase() : String(e.key || "").toLowerCase();
      if (k === "m") { e.preventDefault(); e.stopPropagation(); openMath(); return; }
      if (k.length === 1 && !ALLOWED_KEYS.has(k)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openMath]);

  const invite = useCallback(async (kind) => {
    if (!excal) return;
    if (!(me.invite && me.invite[kind])) { excal.setToast({ message: "이 보드는 초대 키 없이 열려 있어요(로컬 모드)", duration: 3000 }); return; }
    await copyInvite(me, kind, id);
    excal.setToast({ message: kind === "edit" ? "초대 링크를 복사했어요 — 받은 사람은 같이 그릴 수 있어요" : "보기 전용 링크를 복사했어요", duration: 3000 });
  }, [excal, me, id]);

  if (!initial) return <div className="wb-page wb-muted">{status}</div>;
  const others = users.filter((u) => u.client !== client);
  const showInk = tool === "freedraw" || tool === "text" || tool === "selection" || !!sheet;
  const viewOnly = me.role === "view";
  const showText = tool === "text" || textSel || editing || !!sheet;
  const curFont = FONTS.find((f) => f.id === font);
  const keep = (e) => { if (!(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault(); };   // 눌러도 초점(쓰던 글)을 뺏지 않는다
  const fontButton = (
    <button type="button" className="wb-seg wb-fontbtn" title="글꼴" aria-haspopup="true" aria-expanded={fontPop} onClick={() => setFontPop((v) => !v)}>
      <span style={{ fontFamily: curFont ? `"${curFont.css}"` : undefined }}>{curFont ? curFont.label : "글꼴 섞임"}</span> ▾
    </button>
  );
  const sizeControl = (
    <div className="wb-size" role="group" aria-label="글자 크기">
      <button type="button" className="wb-seg" aria-label="글자 작게" onClick={() => setTextSize(stepSize(fontSize, -1))}>가−</button>
      <b title="글자 크기">{fontSize ?? "섞임"}</b>
      <button type="button" className="wb-seg" aria-label="글자 크게" onClick={() => setTextSize(stepSize(fontSize, 1))}>가+</button>
    </div>
  );
  const inks = (
    <div className="wb-group wb-inks" aria-label="색">
      {PALETTE.map(([c, label]) => (
        <button key={c} type="button" className={`wb-swatch ${norm(ink) === norm(c) ? "on" : ""}`} title={label} aria-label={`색 ${label}`} onClick={() => setInkColor(c)}>
          <i style={{ background: c, filter: theme === "dark" ? DARK_FILTER : undefined }} />
        </button>
      ))}
      <button type="button" className={`wb-swatch wb-more ${PALETTE.some(([c]) => norm(c) === norm(ink)) ? "" : "on"}`} title="색 더 보기" aria-label="색 더 보기" aria-expanded={moreInk}
        onClick={() => setMoreInk((v) => !v)}>
        <i style={PALETTE.some(([c]) => norm(c) === norm(ink)) ? undefined : { background: ink, filter: theme === "dark" ? DARK_FILTER : undefined }}>{PALETTE.some(([c]) => norm(c) === norm(ink)) ? "+" : ""}</i>
      </button>
    </div>
  );
  return (
    <div className={`wb-board wb-theme-${theme}${mobile ? " wb-mobile" : ""}${sheet ? " wb-sheeting" : ""}`}>
      <Excalidraw
        excalidrawAPI={setExcal}
        initialData={initial}
        langCode="ko-KR"
        theme={theme}
        handleKeyboardGlobally
        isCollaborating
        viewModeEnabled={viewOnly}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        name={meta ? meta.title : "보드"}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: true, export: { saveFileToDisk: true }, toggleTheme: false, changeViewBackgroundColor: false } }}
        renderTopRightUI={() => (
          <div className="wb-people" aria-label="접속한 사람">
            {status && <span className="wb-status">{status}</span>}
            {me.expires_at && <span className="wb-status" title={new Date(me.expires_at * 1000).toLocaleString()}>{left(me.expires_at)}</span>}
            {viewOnly && <span className="wb-status">보기 전용</span>}
            <span className="wb-chip wb-chip-me" style={{ borderColor: me.color }} title="나 · 커서 색">{me.short || me.name}</span>
            {others.map((u) => <span key={u.client} className="wb-chip" style={{ borderColor: u.color }} title={u.user}>{u.short || u.user}</span>)}
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => { location.hash = ""; }}>← 보드 목록</MainMenu.Item>
          {!viewOnly && <MainMenu.Item onSelect={() => invite("edit")}>초대 링크 복사(같이 그리기)</MainMenu.Item>}
          {me.invite && me.invite.view && <MainMenu.Item onSelect={() => invite("view")}>보기 전용 링크 복사</MainMenu.Item>}
          {!viewOnly && <MainMenu.Item onSelect={async () => {
            const t = window.prompt ? window.prompt("보드 이름", meta ? meta.title : "") : null;
            if (t) setMeta(await api.rename(id, t));
          }}>보드 이름 바꾸기</MainMenu.Item>}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          {!viewOnly && <MainMenu.DefaultItems.ClearCanvas />}
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>

      {mobile && (
        <div className="wb-mtop" onMouseDown={keep}>
          <button type="button" className="wb-mbtn" aria-label="메뉴" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><Icon d="M4 7h16M4 12h16M4 17h16" /></button>
          {!viewOnly && <>
            <button type="button" className="wb-mbtn" aria-label="실행취소" onClick={() => key("z")}><Icon d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" /></button>
            <button type="button" className="wb-mbtn" aria-label="다시 실행" onClick={() => key("z", true)}><Icon d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" /></button>
            <button type="button" className="wb-mbtn" aria-label="선택한 것 지우기" onClick={deleteSelected}><Icon d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" /></button>
          </>}
          <span className="wb-mfill" />
          {status && <span className="wb-mchip">{status}</span>}
          {me.expires_at && <span className="wb-mchip">{left(me.expires_at)}</span>}
          {viewOnly && <span className="wb-mchip">보기 전용</span>}
          <span className="wb-mchip" title={[me.short || me.name, ...others.map((u) => u.short || u.user)].join(", ")}>
            <i className="wb-mdot" style={{ background: me.color }} />{others.length ? `${others.length + 1}명` : (me.short || me.name)}
          </span>
        </div>
      )}
      {mobile && menu && (
        <div className="wb-msheet-back" onClick={() => setMenu(false)}>
          <div className="wb-mmenu" role="menu" onClick={(e) => e.stopPropagation()}>
            <p className="wb-mmenu-who">{[me.short || me.name, ...others.map((u) => u.short || u.user)].join(" · ")}</p>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); location.hash = ""; }}>← 보드 목록</button>
            {!viewOnly && <button type="button" role="menuitem" onClick={() => { setMenu(false); invite("edit"); }}>초대 링크 복사(같이 그리기)</button>}
            {me.invite && me.invite.view && <button type="button" role="menuitem" onClick={() => { setMenu(false); invite("view"); }}>보기 전용 링크 복사</button>}
            <button type="button" role="menuitem" onClick={() => { setMenu(false); savePng(); }}>그림(PNG)으로 저장</button>
            {!viewOnly && <button type="button" role="menuitem" onClick={async () => {
              setMenu(false);
              const t = window.prompt ? window.prompt("보드 이름", meta ? meta.title : "") : null;
              if (t) setMeta(await api.rename(id, t));
            }}>보드 이름 바꾸기</button>}
            <button type="button" role="menuitem" onClick={() => { setMenu(false); toggleTheme(); }}>{theme === "dark" ? "밝은 화면" : "어두운 화면"}</button>
          </div>
        </div>
      )}

      {!viewOnly && <div className="wb-dock" role="toolbar" aria-label="도구" ref={dockRef}
        onMouseDown={keep}
        onClick={() => setTimeout(refocus, 0)}>
        <div className="wb-group wb-tools">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" className={`wb-tool ${tool === t.id ? "on" : ""}`} aria-pressed={tool === t.id} title={`${t.label} (${t.key})`} onClick={() => pick(t.id)}>
              <Icon d={t.icon} /><span>{t.id === "math" && mathSel ? "수식 고침" : (mobile && t.id === "selection" ? "선택" : mobile && t.id === "hand" ? "이동" : t.label)}</span>
            </button>
          ))}
        </div>
        {showInk && !sheet && inks}
        {tool === "freedraw" && (
          <label className="wb-group wb-slider" title="펜 굵기">
            <span>굵기</span>
            <input type="range" min="0.5" max="8" step="0.5" value={width} onChange={(e) => setStroke(+e.target.value)} aria-label="펜 굵기" />
            <i className="wb-dot" style={{ width: Math.max(3, width * 4), height: Math.max(3, width * 4), background: ink }} />
          </label>
        )}
        {showText && !sheet && <div className="wb-group wb-textctl" aria-label="글꼴 · 크기">{fontButton}{sizeControl}</div>}
        {tool === "text" && coarse && !sheet && <div className="wb-group wb-hint">글을 넣을 자리를 누르세요</div>}
        {tool === "laser" && <div className="wb-group wb-hint">끌면 잠깐 빛나는 선이 모두에게 보여요</div>}
        <div className="wb-group wb-desk">
          <button type="button" className="wb-tool" title="실행취소(내 작업만)" onClick={() => key("z")}><Icon d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" /><span>취소</span></button>
          <button type="button" className="wb-tool" title="다시 실행" onClick={() => key("z", true)}><Icon d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" /><span>다시</span></button>
          <button type="button" className="wb-tool" title="선택한 것 지우기" onClick={deleteSelected}><Icon d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" /><span>선택 삭제</span></button>
        </div>
        <div className="wb-group wb-desk">
          <button type="button" className="wb-tool" title={theme === "dark" ? "밝은 화면" : "어두운 화면"} onClick={toggleTheme}>
            <Icon d={theme === "dark" ? "M12 4V2M12 22v-2M4 12H2M22 12h-2M5 5L4 4M20 20l-1-1M5 19l-1 1M20 4l-1 1M12 8a4 4 0 100 8 4 4 0 000-8z" : "M20 14A8 8 0 1110 4a6 6 0 0010 10z"} />
            <span>{theme === "dark" ? "밝게" : "어둡게"}</span>
          </button>
          <button type="button" className="wb-tool" title="이 보드로 바로 들어오는 링크를 복사해요" onClick={() => invite("edit")}><Icon d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /><span>초대</span></button>
        </div>
      </div>}

      {/* 폰 글 쓰기 창 — 늘 붙어 있어야 누르는 순간 초점(자판)을 줄 수 있다 */}
      {coarse && !viewOnly && (
        <div className={`wb-sheet ${sheet ? "open" : ""}`} aria-hidden={!sheet} onMouseDown={keep}>
          <textarea ref={sheetRef} value={sheetText} rows={3} placeholder="여기에 글을 쓰세요" aria-label="글"
            tabIndex={sheet ? 0 : -1}
            style={{ fontFamily: curFont && curFont.family ? `"${curFont.css}", system-ui, sans-serif` : undefined, color: theme === "dark" ? undefined : ink }}
            onChange={(e) => setSheetText(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitSheet(); } if (e.key === "Escape") closeSheet(); }} />
          <div className="wb-sheet-row">
            {fontButton}{sizeControl}
          </div>
          <div className="wb-sheet-row wb-sheet-inks">{inks}</div>
          <div className="wb-sheet-row wb-sheet-actions">
            <button type="button" className="wb-btn" onClick={closeSheet}>취소</button>
            <button type="button" className="wb-primary" onClick={commitSheet}>{sheet && sheet.editId ? (sheetText.trim() ? "고치기" : "지우기") : "넣기"}</button>
          </div>
        </div>
      )}

      {fontPop && (
        <div className={`wb-pop wb-font-pop${sheet ? " wb-pop-top" : ""}`} role="listbox" aria-label="글꼴" onMouseDown={keep}>
          {FONTS.filter((f) => !sheet || f.family).map((f) => (
            <button key={f.id} type="button" role="option" aria-selected={font === f.id} className={`wb-font-item ${font === f.id ? "on" : ""}`}
              title={f.hint} onClick={() => setFontChoice(f.id)}>
              <span className="wb-font-name" style={{ fontFamily: `"${f.css}", serif`, fontStyle: f.id === "math" ? "italic" : undefined }}>{f.id === "math" ? "x² + y²" : `${f.label} 가나다 Abc`}</span>
              <small>{f.hint}</small>
            </button>
          ))}
        </div>
      )}
      {moreInk && (
        <div className={`wb-pop wb-more-pop${sheet ? " wb-pop-top" : ""}`} role="dialog" aria-label="색 더 보기" onMouseDown={keep}>
          <div className="wb-more-grid">
            {MORE_COLORS.map((c, i) => (
              <button key={c + i} type="button" className={`wb-swatch ${norm(ink) === norm(c) ? "on" : ""}`} aria-label={`색 ${c}`} title={c} onClick={() => { setInkColor(c); setMoreInk(false); }}>
                <i style={{ background: c, filter: theme === "dark" ? DARK_FILTER : undefined }} />
              </button>
            ))}
          </div>
          <label className="wb-more-custom">직접 고르기
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(ink) ? ink : "#1e1e1e"} onChange={(e) => setInkColor(e.target.value)} aria-label="색 직접 고르기" />
          </label>
        </div>
      )}
      {math && <MathDialog initial={math.initial} color={ink} onCancel={() => { setMath(null); setTimeout(refocus, 0); }} onInsert={insertMath} />}
    </div>
  );
}
