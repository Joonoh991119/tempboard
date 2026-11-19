import "./asset-path.js";
import "./key.js";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./kfonts.css";
import "./app.css";
import { api } from "./api.js";
import Board from "./Board.jsx";
import { left, copyInvite } from "./invite.js";

function useHash() {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const f = () => setH(location.hash);
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return h;
}

function Login({ onDone }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="wb-page">
      <form className="wb-login" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.login(name.trim()); onDone(await api.me()); } catch (x) { setErr(x.message); }
      }}>
        <h1>화이트보드</h1>
        <p>다른 사람 화면에 커서와 함께 보일 이름을 써 주세요. 같은 이름으로 다시 들어오면 같은 색이 이어져요.</p>
        <input autoFocus maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" aria-label="이름" />
        <button className="wb-primary" disabled={!name.trim()}>들어가기</button>
        {err && <p className="wb-err">{err}</p>}
      </form>
    </div>
  );
}

function ago(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(t).toLocaleDateString("ko-KR");
}

function List({ me }) {
  const [boards, setBoards] = useState(null);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const load = () => api.boards().then(setBoards, (e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);
  return (
    <div className="wb-page">
      <header className="wb-top">
        <h1>화이트보드</h1>
        {me.expires_at && <span className="wb-me" title={new Date(me.expires_at * 1000).toLocaleString()}>{left(me.expires_at)}</span>}
        {me.role === "edit" && me.invite && me.invite.edit && <button type="button" className="wb-btn" onClick={async () => setCopied(await copyInvite(me, "edit"))}>초대 링크 복사</button>}
        <span className="wb-me">{me.name}{me.role === "view" ? " · 보기 전용" : ""}</span>
      </header>
      {copied && <p className="wb-hint">복사했어요 — 이 링크를 받은 사람은 같이 그릴 수 있어요.</p>}
      {me.role === "edit" && <form className="wb-new" onSubmit={async (e) => {
        e.preventDefault();
        try { const b = await api.create(title.trim() || "새 보드"); location.hash = `#b=${b.id}`; } catch (x) { setErr(x.message); }
      }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="새 보드 이름(예: 회의 메모)" aria-label="새 보드 이름" />
        <button className="wb-primary">새 보드 만들기</button>
      </form>}
      {err && <p className="wb-err">{err}</p>}
      <p className="wb-hint">보드를 열면 같은 보드에 들어온 사람의 커서와 그림이 바로 보여요. 이미지는 복사해서 붙여 넣으면(⌘V · Ctrl+V) 올라가요.</p>
      <ul className="wb-list">
        {boards === null && <li className="wb-muted">불러오는 중…</li>}
        {boards && boards.length === 0 && <li className="wb-muted">아직 보드가 없어요. 위에서 하나 만들어 보세요.</li>}
        {boards && boards.map((b) => (
          <li key={b.id}>
            <a href={`#b=${b.id}`} className="wb-card">
              <strong>{b.title}</strong>
              <span>{b.created_by} · {ago(b.updated_at)} 고침 · 요소 {b.elements}개</span>
              {b.online > 0 && <span className="wb-online">● {b.online}명 접속 중</span>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function App() {
  const [me, setMe] = useState(undefined);
  const hash = useHash();
  useEffect(() => { api.me().then(setMe, (e) => setMe(e.status === 403 ? false : null)); }, []);
  if (me === undefined) return <div className="wb-page wb-muted">불러오는 중…</div>;
  if (me === false) return <div className="wb-page"><h1>초대 링크가 필요해요</h1><p className="wb-muted">링크가 끝났다면 보드를 연 사람에게 새 링크를 받으세요.</p></div>;
  if (me === null) return <Login onDone={setMe} />;
  const m = hash.match(/^#b=([a-z0-9]+)/);
  return m ? <Board key={m[1]} id={m[1]} me={me} /> : <List me={me} />;
}

createRoot(document.getElementById("root")).render(<App />);
