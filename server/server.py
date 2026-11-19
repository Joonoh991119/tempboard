#!/usr/bin/env python3
"""tempboard 화이트보드 서버(표준 라이브러리만).

    python3 server/server.py --data ./data --port 8790 [--edit-key K] [--view-key V]
    → http://127.0.0.1:8790/?k=K

보통은 직접 띄우지 않고 `bin/tempboard start` 가 띄운다(임시 터널 · 만료 · 초대 키를 같이 맞춘다).

접근: --edit-key 를 주면 모든 요청이 초대 키를 요구한다. 링크의 `?k=<키>` 로 처음 들어오면 쿠키로 바꿔 두고
주소에서 키를 지운다. 편집 키는 그리기 · 보드 만들기, 보기 키는 읽기 · 커서만. 키를 하나도 주지 않으면 로컬 전용(누구나 편집).
사람 이름은 첫 화면에서 받는다(쿠키 `wb_user`). 앞단 프록시가 사용자를 정하면 `--trust-header X-User`.

동기화 규칙(Excalidraw 와 같다): 요소마다 version 이 큰 쪽, 같으면 versionNonce 가 작은 쪽이 이긴다.
지운 요소는 isDeleted 로 남긴다(다른 사람 화면에서도 지워지게). 실행취소는 각자 화면의 자기 작업만 되돌린다.
"""
import argparse
import hmac
import os
import base64
import hashlib
import socket
import struct
import collections
import json
import queue
import re
import secrets
import threading
import time
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BOARD_ID = re.compile(r"^[a-z0-9]{8,32}$")
FILE_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
MAX_BODY = 12 * 1024 * 1024        # 이미지 한 장(data URL) 상한 근처
MAX_FILE = 10 * 1024 * 1024
MAX_ELEMENTS_PER_POST = 2000
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}
# 사람 색 — 색상(hue)이 서로 30° 이상 떨어지게 고른다(화면의 '비슷한 색' 판정 18° 보다 넓게). 앞 넷은 시각화 규칙 2.0 의 색
EPOCH = secrets.token_hex(4)   # 서버를 켤 때마다 바뀐다 — 화면은 이것이 바뀌면 전체를 다시 맞춘다
COLORS = ["#D55E00", "#0072B2", "#009E73", "#CC79A7", "#F0E442", "#7B61FF", "#66A61E", "#E31A1C"]


def _hsl(hexc):
    n = int(hexc.lstrip("#"), 16)
    r, g, b = (n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255
    mx, mn = max(r, g, b), min(r, g, b)
    l, d = (mx + mn) / 2, mx - mn
    if d == 0:
        return 0.0, 0.0, l
    s = d / (1 - abs(2 * l - 1))
    h = 60 * (((g - b) / d) % 6) if mx == r else 60 * ((b - r) / d + 2) if mx == g else 60 * ((r - g) / d + 4)
    return h % 360, s, l


def similar(a, b):
    """화면(Board.jsx sameColor)과 같은 판정 — 같은 hex 이거나 둘 다 채도 있는 색이고 색상 18° 안."""
    if a.lower() == b.lower():
        return True
    (h1, s1, l1), (h2, s2, l2) = _hsl(a), _hsl(b)
    if min(s1, s2) < 0.35 or min(l1, l2) < 0.18 or max(l1, l2) > 0.85:
        return False
    dh = abs(h1 - h2)
    return min(dh, 360 - dh) <= 18


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WSConn:
    """WebSocket 한 연결(RFC 6455, 표준 라이브러리만). 보내기는 큐 + 전용 스레드 — 느린 화면 하나가 다른 사람을 막지 않는다."""

    def __init__(self, handler):
        self.h = handler
        self.q = queue.Queue(maxsize=2000)
        self.alive = True
        self.writer = threading.Thread(target=self._write_loop, daemon=True)
        self.writer.start()

    def _frame(self, opcode, payload: bytes):
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        return head + payload

    def send(self, obj):
        if not self.alive:
            return False
        try:
            self.q.put_nowait(self._frame(0x1, json.dumps(obj, ensure_ascii=False).encode("utf-8")))
            return True
        except queue.Full:   # 너무 밀린 화면 — 끊으면 다시 붙어 처음부터 맞춘다(락 안에서 불려도 막히지 않게 따로 닫는다)
            threading.Thread(target=self.close, daemon=True).start()
            return False

    def _write_loop(self):
        while self.alive:
            try:
                data = self.q.get(timeout=20)
            except queue.Empty:
                data = self._frame(0x9, b"hb")   # 20초마다 ping — 앞단(터널)이 조용한 연결을 끊지 않게
            try:
                self.h.wfile.write(data)
                self.h.wfile.flush()
            except OSError:
                self.alive = False
                break

    def _read_exact(self, n):
        """TCP 는 n 바이트를 한 번에 주지 않을 수 있다 — 다 찰 때까지 읽는다. 끊기면 None."""
        buf = bytearray()
        while len(buf) < n:
            chunk = self.h.rfile.read(n - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        return bytes(buf)

    def recv(self):
        """(opcode, payload) — 조각난 메시지는 이어 붙인다(누적도 MAX_BODY 안). 끊기거나 규약 위반이면 (8, b'')."""
        buf, first_op = bytearray(), None
        while True:
            hdr = self._read_exact(2)
            if not hdr:
                return 8, b""
            fin, op = hdr[0] & 0x80, hdr[0] & 0x0F
            masked, n = hdr[1] & 0x80, hdr[1] & 0x7F
            if n in (126, 127):
                ext = self._read_exact(2 if n == 126 else 8)
                if not ext:
                    return 8, b""
                n = struct.unpack(">H" if len(ext) == 2 else ">Q", ext)[0]
            if n > MAX_BODY or len(buf) + n > MAX_BODY:
                return 8, b""
            mask = self._read_exact(4) if masked else None
            if masked and not mask:
                return 8, b""
            raw = self._read_exact(n) if n else b""
            if raw is None:
                return 8, b""
            data = bytearray(raw)
            if mask:
                for i in range(n):
                    data[i] ^= mask[i & 3]
            if op in (0x8, 0x9, 0xA):   # 제어 프레임은 조각 사이에도 온다
                if op == 0x9:
                    try:
                        self.q.put_nowait(self._frame(0xA, bytes(data)))
                    except queue.Full:
                        pass
                    continue
                if op == 0xA:
                    continue
                return 8, b""
            if op != 0:
                if first_op is not None:
                    return 8, b""   # 앞 메시지가 끝나기 전에 새 메시지 — 규약 위반
                first_op = op
            elif first_op is None:
                return 8, b""       # 시작 없는 이어짐 조각
            buf.extend(data)
            if fin:
                return first_op, bytes(buf)

    def close(self):
        if self.alive:
            self.alive = False
            try:
                self.h.wfile.write(self._frame(0x8, b""))
                self.h.wfile.flush()
            except OSError:
                pass
            try:
                self.h.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def wins(new, old):
    """Excalidraw 규칙 — version 큰 쪽, 같으면 versionNonce 작은 쪽."""
    if old is None:
        return True
    try:
        nv, ov = int(new.get("version") or 0), int(old.get("version") or 0)
        if nv != ov:
            return nv > ov
        return int(new.get("versionNonce") or 0) < int(old.get("versionNonce") or 0)
    except (TypeError, ValueError):   # 비교할 수 없는 요소는 받지 않는다(연결을 죽이지 않게)
        return False


class Board:
    def __init__(self, root: Path, bid: str):
        self.root, self.id = root, bid
        self.lock = threading.RLock()
        self.subs = []          # (queue, client_id) — SSE
        self.sockets = {}       # client_id → WSConn
        self.seq = 0            # 롱폴링용 사건 번호(그림 · 파일 · 이름만 — 커서는 따로)
        self.log = collections.deque(maxlen=20000)  # (seq, from_client, event, data)
        self.pver = 0           # 커서 · 접속 판 — 바뀔 때마다 1 씩. 기록에 쌓지 않아 그림 기록을 밀어내지 않는다
        self.cond = threading.Condition(self.lock)
        self.presence = {}      # client_id → dict
        self.meta, self.elements = {}, {}
        p = root / "board.json"
        if p.is_file():
            d = json.loads(p.read_text(encoding="utf-8"))
            self.meta = d.get("meta", {})
            self.elements = {e["id"]: e for e in d.get("elements", []) if isinstance(e, dict) and e.get("id")}
        self.dirty = False
        self.saved_seq = 0      # 디스크에 들어간 마지막 사건 번호 — ack(받음)와 따로 'saved'(저장됨)로 알린다
        self.save_lock = threading.Lock()

    def _announce_saved(self, upto):
        with self.lock:
            if upto <= self.saved_seq:
                return
            self.saved_seq = upto
            msg = {"t": "saved", "seq": upto}
            for c in list(self.sockets.values()):
                c.send(msg)
            self.cond.notify_all()   # 저장 확인을 기다리는 롱폴링도 깨운다

    def save(self):
        """락 안에서는 목록만 복사하고, 직렬화 · 디스크 쓰기는 락 밖 — 저장하는 동안 펜이 멈추지 않게.
        쓰기가 끝난 뒤에만 그 시점 사건 번호까지 'saved' 를 알린다(화면은 그때까지 재전송 목록을 지우지 않는다)."""
        with self.save_lock:
            with self.lock:
                upto = self.seq
                if not self.dirty:
                    meta = None
                else:
                    meta, els = dict(self.meta), list(self.elements.values())
                    self.dirty = False
            if meta is not None:
                try:
                    self.root.mkdir(parents=True, exist_ok=True)
                    tmp = self.root / "board.json.tmp"
                    with open(tmp, "w", encoding="utf-8") as fh:
                        fh.write(json.dumps({"meta": meta, "elements": els}, ensure_ascii=False))
                        fh.flush()
                        os.fsync(fh.fileno())
                    tmp.replace(self.root / "board.json")
                except OSError:
                    with self.lock:
                        self.dirty = True
                    return
            self._announce_saved(upto)

    def merge(self, elements, client):
        took = []
        with self.lock:
            for e in elements[:MAX_ELEMENTS_PER_POST]:
                if not isinstance(e, dict) or not isinstance(e.get("id"), str) or len(e["id"]) > 64:
                    continue
                if wins(e, self.elements.get(e["id"])):
                    self.elements[e["id"]] = e
                    took.append(e)
            if took:
                self.dirty = True
                self.meta["updated_at"] = now()
                self.publish("elements", {"from": client, "elements": took}, skip=client)   # 락 안 — 사건 번호와 보내는 순서가 같다
        return took

    def publish(self, event, data, skip=None):
        msg = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")
        with self.lock:
            if event == "presence":
                self.pver += 1
                wsmsg, wskip = {"t": "presence", "pver": self.pver, "data": data}, None
            else:
                self.seq += 1
                self.log.append((self.seq, skip, event, data))
                wsmsg, wskip = {"t": "ev", "seq": self.seq, "event": event, "data": data}, skip
            self.cond.notify_all()
            for cid, c in list(self.sockets.items()):   # 락 안에서 큐에만 넣는다 — 막히지 않고, 순서가 사건 번호와 같다
                if cid != wskip:
                    c.send(wsmsg)
            for q, cid in list(self.subs):
                if cid != skip:
                    try:
                        q.put_nowait(msg)
                    except queue.Full:
                        pass

    def poll(self, since, client, pver=-1, epoch="", timeout=20.0, saved=-1):
        """롱폴링 — since 뒤 그림 사건(내가 보낸 것 빼고)과, 커서 판(pver)이 바뀌었으면 접속자 목록.
        서버가 다시 켜졌거나(epoch 다름) 기록이 밀렸거나 since 가 앞서 있으면 reset(전체를 다시 받는다 — 지우지 않고 합친다)."""
        deadline = time.time() + timeout
        with self.cond:
            while True:
                if epoch != EPOCH or since > self.seq or (self.log and since < self.log[0][0] - 1):
                    return {"epoch": EPOCH, "seq": self.seq, "pver": self.pver, "saved": self.saved_seq, "reset": True, "events": [], "presence": self.presence_list()}
                evs = [{"event": e, "data": d} for (n, frm, e, d) in self.log if n > since and frm != client]
                if evs or pver != self.pver or (saved >= 0 and self.saved_seq > saved):
                    out = {"epoch": EPOCH, "seq": self.seq, "pver": self.pver, "saved": self.saved_seq, "events": evs}
                    if pver != self.pver:
                        out["presence"] = self.presence_list()
                    return out
                since = max(since, self.seq)   # 내 사건만 있었으면 건너뛰고 기다린다
                left = deadline - time.time()
                if left <= 0:
                    return {"epoch": EPOCH, "seq": since, "pver": self.pver, "saved": self.saved_seq, "events": []}
                self.cond.wait(left)
                if self.log and self.log[-1][0] > since:
                    self.cond.wait(0.04)   # 깨어났으면 잇달아 오는 변경을 40ms 만 더 모아 한 번에

    def presence_list(self):
        cut = time.time() - 30
        with self.lock:
            for k in [k for k, v in self.presence.items() if v.get("_t", 0) < cut and k not in self.sockets]:   # WebSocket 이 붙어 있으면 가만히 있어도 접속 중
                self.presence.pop(k, None)
            return [{k: v for k, v in p.items() if k != "_t"} for p in self.presence.values()]


def short_name(name):
    """커서 옆 글자 — 한글 세 글자 이름은 뒤 두 글자(홍길동 → 길동), 그 밖은 앞 두 글자."""
    n = str(name).strip()
    if re.fullmatch(r"[가-힣]{3,4}", n):
        return n[-2:]
    return n[:2]


class Store:
    def __init__(self, data: Path):
        self.data = data
        (data / "boards").mkdir(parents=True, exist_ok=True)
        self.boards, self.lock = {}, threading.Lock()
        self.colors_path = data / "colors.json"
        self.colors = json.loads(self.colors_path.read_text(encoding="utf-8")) if self.colors_path.is_file() else {}

    def color_for(self, name):
        """사람마다 겹치지 않는 고정 색 — 처음 들어온 순서대로 팔레트에서 하나씩. 같은 색을 두 사람이 갖지 않는다."""
        with self.lock:
            if name not in self.colors:
                used = list(self.colors.values())
                free = [c for c in COLORS if not any(similar(c, u) for u in used)]
                if not free:
                    raise ValueError("색이 모자라다 — COLORS 를 늘린다")
                self.colors[name] = free[0]
                self.colors_path.write_text(json.dumps(self.colors, ensure_ascii=False, indent=1), encoding="utf-8")
            return self.colors[name]

    def get(self, bid):
        if not BOARD_ID.match(bid or ""):
            return None
        with self.lock:
            if bid not in self.boards:
                root = self.data / "boards" / bid
                if not (root / "board.json").is_file():
                    return None
                self.boards[bid] = Board(root, bid)
            return self.boards[bid]

    def create(self, title, user):
        bid = secrets.token_hex(6)
        b = Board(self.data / "boards" / bid, bid)
        b.meta = {"id": bid, "title": title[:80] or "새 보드", "created_by": user["name"], "created_at": now(), "updated_at": now()}
        b.dirty = True
        b.save()
        with self.lock:
            self.boards[bid] = b
        return b

    def list(self):
        out = []
        for p in sorted((self.data / "boards").glob("*/board.json")):
            b = self.get(p.parent.name)
            if b:
                with b.lock:
                    n = sum(1 for e in b.elements.values() if not e.get("isDeleted"))
                out.append({**b.meta, "elements": n, "online": len(b.presence_list())})
        out.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
        return out

    def flush(self):
        with self.lock:
            boards = list(self.boards.values())
        for b in boards:
            b.save()


class Access:
    """초대 키 — 편집(edit) · 보기(view). 키가 없으면 열린 로컬 모드(모두 edit)."""

    def __init__(self, edit_key=None, view_key=None, site="local", expires_at=0.0):
        self.edit_key, self.view_key = edit_key or None, view_key or None
        self.cookie = "tb_" + re.sub(r"[^A-Za-z0-9]", "", site)[:24]
        self.expires_at = float(expires_at or 0)
        self.keys = {k: v for k, v in (("edit", self.edit_key), ("view", self.view_key)) if v}

    @property
    def open(self):
        return not self.edit_key

    def role_of(self, key):
        if self.open:
            return "edit"
        if key and hmac.compare_digest(str(key), self.edit_key):
            return "edit"
        if key and self.view_key and hmac.compare_digest(str(key), self.view_key):
            return "view"
        return None


DENIED = """<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tempboard</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 16px;color:#333">
<h1 style="font-size:20px">초대 링크가 필요해요</h1><p>이 화이트보드는 받은 초대 링크(주소 끝 <code>?k=…</code>)로만 열려요.
링크가 끝났다면(만료 · 종료) 보드를 연 사람에게 새 링크를 받으세요.</p>
<p style="color:#777">This whiteboard opens only from its invite link. Ask the host for a fresh one.</p></body></html>""".encode("utf-8")


def make_handler(store: Store, dist: Path, trust_header: str | None, test_user: str | None = None, access: Access | None = None):
    access = access or Access()
    class H(BaseHTTPRequestHandler):
        server_version = "tempboard/0.1"
        protocol_version = "HTTP/1.1"   # SSE 를 chunked 로 흘린다 — 앞단 프록시(cloudflared 등)가 끝까지 모아 두지 않게

        def log_message(self, fmt, *args):  # 조용히
            pass

        # ---------- 초대 키 ----------
        def role(self):
            if access.open:
                return "edit"
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            return access.role_of(c[access.cookie].value if access.cookie in c else None)

        def https(self):
            return self.headers.get("X-Forwarded-Proto", "").lower() == "https" or "https" in self.headers.get("Cf-Visitor", "")

        def admit(self, u, q):
            """링크의 ?k= 를 쿠키로 바꾸고 키 없는 주소로 보낸다(#b=… 는 브라우저가 그대로 붙인다). 처리했으면 True."""
            if access.open or "k" not in q:
                return False
            key = q["k"][0]
            rest = urllib.parse.urlencode([(k, v) for k, vs in q.items() if k != "k" for v in vs])
            loc = (u.path or "/") + (("?" + rest) if rest else "")
            if not access.role_of(key):
                self.send(403, DENIED, "text/html; charset=utf-8")
                return True
            age = max(60, int(access.expires_at - time.time())) if access.expires_at else 30 * 86400
            ck = f"{access.cookie}={key}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}" + ("; Secure" if self.https() else "")
            self.send(302, b"", extra={"Location": loc, "Set-Cookie": ck, "Referrer-Policy": "no-referrer"})
            return True

        # ---------- 공통 ----------
        def user(self):
            if test_user:   # 시험 전용(127.0.0.1 에서만 켠다) — 모든 요청을 이 사람으로
                return {"id": test_user, "name": test_user}
            if trust_header and self.headers.get(trust_header):
                raw = self.headers.get(trust_header)
                try:  # HTTP 머리는 latin-1 — UTF-8 로 보낸 한글 이름을 되돌리고, %-인코딩도 받는다
                    raw = raw.encode("latin-1").decode("utf-8")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
                name = urllib.parse.unquote(raw).strip()[:40]
                return {"id": name, "name": name} if name else None
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            if "wb_user" in c:
                name = urllib.parse.unquote(c["wb_user"].value)[:40]
                if name:
                    return {"id": name, "name": name}
            return None

        def send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("too large")
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")

        def guard(self):
            """쓰기 요청은 같은 출처 · 앱 머리 · 로그인 사용자만(CSRF 막기)."""
            if self.headers.get("X-Whiteboard") != "1":
                self.send(403, {"error": "missing X-Whiteboard header"})
                return None
            u = self.user()
            if not u:
                self.send(401, {"error": "login required"})
            return u

        # ---------- GET ----------
        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            path, q = u.path, urllib.parse.parse_qs(u.query)
            if self.admit(u, q):
                return
            if path == "/healthz":
                return self.send(200, {"ok": True})
            role = self.role()
            if not role:
                if path.startswith("/api/"):
                    return self.send(403, {"error": "invite link required"})
                return self.send(403, DENIED, "text/html; charset=utf-8")
            if not path.startswith("/api/"):
                return self.static(path.lstrip("/") or "index.html")
            if path == "/api/whiteboard/me":
                usr = self.user()
                if not usr:
                    return self.send(401, {"error": "login required", "role": role})
                color = store.color_for(usr["name"])
                invite = {k: v for k, v in access.keys.items() if role == "edit" or k == "view"}   # 보기 링크로 온 사람에게 편집 키를 주지 않는다
                return self.send(200, {**usr, "short": short_name(usr["name"]), "color": color, "reserved": dict(store.colors),
                                       "role": role, "expires_at": access.expires_at or None, "invite": invite})
            if not self.user():
                return self.send(401, {"error": "login required"})
            if path == "/api/whiteboard/boards":
                return self.send(200, store.list())
            m = re.match(r"^/api/whiteboard/boards/([a-z0-9]+)(/.*)?$", path)
            if not m:
                return self.send(404, {"error": "not found"})
            b = store.get(m.group(1))
            if not b:
                return self.send(404, {"error": "no board"})
            sub = m.group(2) or ""
            if sub == "":
                with b.lock:
                    els = list(b.elements.values())
                files = sorted(p.name for p in (b.root / "files").glob("*")) if (b.root / "files").is_dir() else []
                return self.send(200, {"meta": b.meta, "elements": els, "files": files, "seq": b.seq, "pver": b.pver, "epoch": EPOCH})
            if sub == "/poll":
                try:
                    since = int((q.get("since") or ["0"])[0])
                except ValueError:
                    since = 0
                try:
                    pver = int((q.get("pver") or ["-1"])[0])
                    saved = int((q.get("saved") or ["-1"])[0])
                except ValueError:
                    pver, saved = -1, -1
                return self.send(200, b.poll(since, (q.get("client") or [""])[0][:40], pver, (q.get("epoch") or [""])[0][:16], saved=saved))
            if sub == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
                try:
                    since = int((q.get("since") or ["0"])[0])
                except ValueError:
                    since = 0
                return self.ws(b, (q.get("client") or [""])[0][:40], since, (q.get("epoch") or [""])[0][:16])
            if sub == "/events":
                return self.events(b, (q.get("client") or [""])[0][:40])
            fm = re.match(r"^/files/([A-Za-z0-9_-]+)$", sub)
            if fm and FILE_ID.match(fm.group(1)):
                p = b.root / "files" / fm.group(1)
                if not p.is_file():
                    return self.send(404, {"error": "no file"})
                return self.send(200, p.read_bytes(), extra={"Cache-Control": "private, max-age=86400"})
            return self.send(404, {"error": "not found"})

        do_HEAD = do_GET

        def static(self, rel):
            if ".." in rel.split("/"):
                return self.send(404, b"", "text/plain")
            p = (dist / rel).resolve()
            if not str(p).startswith(str(dist.resolve())) or not p.is_file():
                p = dist / "index.html" if "." not in rel.split("/")[-1] else None
                if p is None or not p.is_file():
                    return self.send(404, b"not found", "text/plain")
            return self.send(200, p.read_bytes(), MIME.get(p.suffix, "application/octet-stream"),
                             extra={"Cache-Control": "public, max-age=3600" if "/assets/" in str(p) else "no-cache"})

        def presence_update(self, b, client, usr, data):
            p = {"client": client, "user": usr["name"], "short": short_name(usr["name"]), "pointer": data.get("pointer"), "button": data.get("button", "up"),
                 "selected": data.get("selected") or {}, "color": store.color_for(usr["name"]), "_t": time.time()}
            with b.lock:
                b.presence[client] = p
            b.publish("presence", b.presence_list())

        def ws(self, b, client, since, epoch):
            """WebSocket — 처음에 놓친 그림 사건을 다시 주고(없으면 reset), 그 뒤로는 사건 · 접속자를 바로 민다.
            화면은 그림 묶음마다 ack 를 받을 때까지 들고 있다가, 끊겼다 다시 붙으면 다시 보낸다."""
            usr = self.user()
            key = self.headers.get("Sec-WebSocket-Key")
            if not usr or not key or not client:
                return self.send(401 if not usr else 400, {"error": "websocket"})
            accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            self.connection.settimeout(60.0)   # 화면은 25초마다 ping — 60초 조용하면 끊긴 것으로 보고 정리(유령 연결 막기)
            conn = WSConn(self)
            with b.lock:
                old = b.sockets.get(client)
                b.sockets[client] = conn
                if epoch != EPOCH or since > b.seq or (b.log and since < b.log[0][0] - 1):
                    first = {"t": "reset", "epoch": EPOCH, "seq": b.seq, "saved": b.saved_seq, "elements": list(b.elements.values())}   # 다시 받으러 오지 않게 실어 준다
                else:
                    evs = [{"seq": n, "event": e, "data": d} for (n, frm, e, d) in b.log if n > since and frm != client]
                    first = {"t": "hello", "epoch": EPOCH, "seq": b.seq, "saved": b.saved_seq, "events": evs}
                pres = {"t": "presence", "pver": b.pver, "data": b.presence_list()}
                conn.send(first)   # 락 안 — hello/reset 보다 실시간 사건이 먼저 가지 않게
                conn.send(pres)
            if old is not None and old is not conn:
                old.close()
            self.presence_update(b, client, usr, {"pointer": None})
            try:
                while conn.alive:
                    op, payload = conn.recv()
                    if op == 0x8:
                        break
                    if op != 0x1:
                        continue
                    try:
                        msg = json.loads(payload.decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        continue
                    t = msg.get("t")
                    if t == "elements" and isinstance(msg.get("elements"), list):
                        if self.role() != "edit":
                            continue   # 보기 링크 — 그림은 받지 않는다
                        b.merge(msg["elements"], client)
                        with b.lock:
                            seq_now = b.seq
                        conn.send({"t": "ack", "id": msg.get("id"), "seq": seq_now})
                    elif t == "presence":
                        self.presence_update(b, client, usr, msg)
                    elif t == "ping":
                        conn.send({"t": "pong"})
            except (OSError, ValueError, struct.error, socket.timeout):
                pass
            finally:
                with b.lock:
                    if b.sockets.get(client) is conn:
                        b.sockets.pop(client, None)
                        b.presence.pop(client, None)
                conn.close()
                b.publish("presence", b.presence_list())

        def events(self, b, client):
            q = queue.Queue(maxsize=500)
            with b.lock:
                b.subs.append((q, client))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            def chunk(data: bytes):
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()
            try:
                chunk(b": " + b" " * 2048 + b"\n\n")   # 앞단 버퍼를 한 번 밀어낸다
                chunk(f"event: presence\ndata: {json.dumps(b.presence_list(), ensure_ascii=False)}\n\n".encode())
                while True:
                    try:
                        msg = q.get(timeout=15)
                    except queue.Empty:
                        msg = b": ping\n\n"
                    chunk(msg)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                with b.lock:
                    b.subs = [s for s in b.subs if s[0] is not q]
                    b.presence.pop(client, None)
                b.publish("presence", b.presence_list())

        # ---------- POST ----------
        def do_POST(self):
            path = urllib.parse.urlsplit(self.path).path
            role = self.role()
            if not role:
                return self.send(403, {"error": "invite link required"})
            if path == "/api/whiteboard/login":  # 첫 화면의 이름 — 앞단이 사용자를 정하면 --trust-header
                try:
                    name = str(self.body().get("name", "")).strip()[:40]
                except Exception:
                    name = ""
                if not name:
                    return self.send(400, {"error": "name"})
                return self.send(200, {"id": name, "name": name},
                                 extra={"Set-Cookie": f"wb_user={urllib.parse.quote(name)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000" + ("; Secure" if self.https() else "")})
            usr = self.guard()
            if not usr:
                return
            if role != "edit" and not path.endswith("/presence"):
                return self.send(403, {"error": "view-only link"})
            try:
                data = self.body()
            except Exception:
                return self.send(400, {"error": "bad json or too large"})
            if path == "/api/whiteboard/boards":
                b = store.create(str(data.get("title", "")).strip(), usr)
                return self.send(201, b.meta)
            m = re.match(r"^/api/whiteboard/boards/([a-z0-9]+)/(elements|presence|files|title)$", path)
            b = store.get(m.group(1)) if m else None
            if not b:
                return self.send(404, {"error": "no board"})
            kind = m.group(2)
            client = str(data.get("client", ""))[:40]
            if kind == "elements":
                els = data.get("elements")
                if not isinstance(els, list):
                    return self.send(400, {"error": "elements"})
                took = b.merge(els, client)
                with b.lock:
                    seq_now = b.seq
                return self.send(200, {"accepted": len(took), "seq": seq_now})
            if kind == "presence":
                self.presence_update(b, client, usr, data)
                return self.send(204, b"")
            if kind == "files":
                fid, url = str(data.get("id", "")), str(data.get("dataURL", ""))
                if not FILE_ID.match(fid) or not re.match(r"^data:image/(png|jpeg|gif|webp|svg\+xml);base64,", url) or len(url) > MAX_FILE:
                    return self.send(400, {"error": "file"})
                d = b.root / "files"
                d.mkdir(parents=True, exist_ok=True)
                if not (d / fid).exists():
                    rec = {"id": fid, "mimeType": str(data.get("mimeType", ""))[:40], "dataURL": url, "created": int(time.time() * 1000), "by": usr["name"]}
                    (d / fid).write_text(json.dumps(rec), encoding="utf-8")
                    b.publish("file", {"id": fid}, skip=client)
                return self.send(201, {"id": fid})
            if kind == "title":
                with b.lock:
                    b.meta["title"] = str(data.get("title", "")).strip()[:80] or b.meta.get("title")
                    b.dirty = True
                b.publish("meta", b.meta)
                return self.send(200, b.meta)
            return self.send(404, {"error": "not found"})


    return H


def build(data, dist=None, host="127.0.0.1", port=0, trust_header=None, test_user=None, access=None, save_interval=0.5):
    """서버 하나를 만들고 저장 스레드를 붙여 돌려준다(serve_forever 는 부르는 쪽이). → (httpd, store)"""
    store = Store(Path(data))
    if test_user and host not in ("127.0.0.1", "localhost"):
        raise SystemExit("--test-user 는 127.0.0.1 에서만")
    srv = ThreadingHTTPServer((host, port), make_handler(store, Path(dist or ROOT / "web" / "dist"), trust_header, test_user, access))
    srv.daemon_threads = True

    def flusher():
        while True:
            time.sleep(save_interval)   # 저장 확인(saved)까지의 틈을 짧게
            store.flush()
    threading.Thread(target=flusher, daemon=True).start()
    return srv, store


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="./tempboard-data")
    ap.add_argument("--dist", default=str(ROOT / "web" / "dist"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--edit-key", default=None, help="편집 초대 키. 주면 키 없는 요청은 막힌다")
    ap.add_argument("--view-key", default=None, help="보기 전용 초대 키(선택)")
    ap.add_argument("--trust-header", default=None, help="앞단이 넣는 사용자 머리(예: X-User). 없으면 첫 화면에서 이름을 받는다")
    ap.add_argument("--save-interval", type=float, default=0.5, help="디스크 저장 간격(초)")
    ap.add_argument("--test-user", default=None, help="시험 전용 — 모든 요청을 이 사람으로(127.0.0.1 에서만)")
    a = ap.parse_args()
    if a.host not in ("127.0.0.1", "localhost") and not a.edit_key:
        raise SystemExit("127.0.0.1 밖으로 열 때는 --edit-key 가 필요하다")
    srv, store = build(a.data, a.dist, a.host, a.port, a.trust_header, a.test_user,
                       Access(a.edit_key, a.view_key, site=str(a.port)), a.save_interval)
    k = f"?k={a.edit_key}" if a.edit_key else ""
    print(f"화이트보드: http://{a.host}:{srv.server_address[1]}/{k}  (자료 {a.data})")
    try:
        srv.serve_forever()
    finally:
        store.flush()


if __name__ == "__main__":
    main()
