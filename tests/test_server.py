"""서버 단위 시험 — 병합 규칙 · 사람별 색 · 짧은 이름 · 쓰기 막기 · 초대 키(편집 · 보기)."""
import base64
import importlib.util
import json
import http.client
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wb_server", HERE / "server" / "server.py")
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)
DIST = HERE / "web" / "dist"
PNG = base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b6d8b10000000049454e44ae426082")).decode()


class Merge(unittest.TestCase):
    def test_version_then_nonce(self):
        self.assertTrue(srv.wins({"version": 3, "versionNonce": 9}, {"version": 2, "versionNonce": 1}))
        self.assertFalse(srv.wins({"version": 2, "versionNonce": 9}, {"version": 3, "versionNonce": 1}))
        self.assertTrue(srv.wins({"version": 3, "versionNonce": 1}, {"version": 3, "versionNonce": 9}))
        self.assertFalse(srv.wins({"version": 3, "versionNonce": 9}, {"version": 3, "versionNonce": 1}))
        self.assertTrue(srv.wins({"version": 1}, None))

    def test_palette_far_apart_and_no_similar_assignment(self):
        for i, a in enumerate(srv.COLORS):
            for b in srv.COLORS[i + 1:]:
                self.assertFalse(srv.similar(a, b), (a, b))
        self.assertTrue(srv.similar("#D55E00", "#E69F00"))   # 11/9 무한 되돌리기를 낸 짝

    def test_short_name(self):
        self.assertEqual(srv.short_name("홍길동"), "길동")
        self.assertEqual(srv.short_name("김철수"), "철수")
        self.assertEqual(srv.short_name("Yeonwoo"), "Ye")


class Api(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = srv.Store(Path(self.tmp.name))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.make_handler(self.store, DIST, "X-RD-User"))
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path, body=None, user="홍길동", app=True):
        h = {"Content-Type": "application/json"}
        if user:
            h["X-RD-User"] = urllib.parse.quote(user) if False else user.encode("utf-8").decode("latin-1")
        if app:
            h["X-Whiteboard"] = "1"
        req = urllib.request.Request(self.base + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req) as r:
                t = r.read()
                return r.status, (json.loads(t) if t else None)
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, None

    def test_colors_unique_and_stable(self):
        names = ["홍길동", "김철수", "이영희", "박민수"]
        colors = [self.store.color_for(n) for n in names]
        self.assertEqual(len(set(colors)), 4)
        self.assertEqual(self.store.color_for("김철수"), colors[1])
        again = srv.Store(Path(self.tmp.name))
        self.assertEqual(again.color_for("이영희"), colors[2])

    def test_flow_and_guards(self):
        self.assertEqual(self.call("GET", "/api/whiteboard/boards", user=None)[0], 401)
        self.assertEqual(self.call("POST", "/api/whiteboard/boards", {"title": "x"}, app=False)[0], 403)
        st, b = self.call("POST", "/api/whiteboard/boards", {"title": "회의"})
        self.assertEqual(st, 201)
        bid = b["id"]
        el = {"id": "e1", "type": "rectangle", "version": 2, "versionNonce": 5}
        self.assertEqual(self.call("POST", f"/api/whiteboard/boards/{bid}/elements", {"client": "c1", "elements": [el]})[1]["accepted"], 1)
        self.assertEqual(self.call("POST", f"/api/whiteboard/boards/{bid}/elements", {"client": "c2", "elements": [{**el, "version": 1}]})[1]["accepted"], 0)
        st, d = self.call("GET", f"/api/whiteboard/boards/{bid}")
        self.assertEqual(d["elements"][0]["version"], 2)
        self.assertEqual(self.call("POST", f"/api/whiteboard/boards/{bid}/files", {"client": "c1", "id": "f" * 12, "mimeType": "text/html", "dataURL": "data:text/html;base64,AAA"})[0], 400)
        self.assertEqual(self.call("POST", f"/api/whiteboard/boards/{bid}/files", {"client": "c1", "id": "f" * 12, "mimeType": "image/png", "dataURL": "data:image/png;base64," + PNG})[0], 201)
        st, me = self.call("GET", "/api/whiteboard/me")
        self.assertEqual((me["short"], me["color"]), ("길동", self.store.color_for("홍길동")))

    def test_saved_only_after_disk_write(self):
        """R1 — ack(받음)와 saved(디스크) 구분: 저장 전에는 saved 가 오르지 않고, 저장 뒤 그 seq 까지 오른다."""
        st, b = self.call("POST", "/api/whiteboard/boards", {"title": "R1"})
        board = self.store.get(b["id"])
        board.save()
        base = board.saved_seq
        st, r = self.call("POST", f"/api/whiteboard/boards/{b['id']}/elements", {"client": "c", "elements": [{"id": "k", "version": 2, "versionNonce": 1}]})
        self.assertGreater(r["seq"], base)
        self.assertEqual(board.saved_seq, base, "받기만 하고 저장 전")
        disk = json.loads((Path(self.tmp.name) / "boards" / b["id"] / "board.json").read_text())
        self.assertFalse(any(e["id"] == "k" for e in disk["elements"]))
        board.save()
        self.assertGreaterEqual(board.saved_seq, r["seq"])
        st, p = self.call("GET", f"/api/whiteboard/boards/{b['id']}/poll?client=x&since={r['seq']}&pver=-1&saved={base}&epoch={srv.EPOCH}")
        self.assertGreaterEqual(p["saved"], r["seq"])

    def test_websocket_ack_then_saved(self):
        """WebSocket 손으로: hello → elements → ack(seq) → (저장 전 saved 없음) → flush → saved ≥ seq."""
        import os, socket, struct
        st, b = self.call("POST", "/api/whiteboard/boards", {"title": "ws"})
        host, port = self.httpd.server_address
        s = socket.create_connection((host, port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET /api/whiteboard/boards/{b['id']}/ws?client=w1&since=0&epoch= HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nX-RD-User: tester\r\n\r\n").encode())
        f = s.makefile("rb")
        status = f.readline()
        self.assertIn(b"101", status)
        while f.readline() not in (b"\r\n", b""):
            pass
        def read_msg():
            while True:
                h = f.read(2); op, n = h[0] & 0x0F, h[1] & 0x7F
                if n == 126: n = struct.unpack(">H", f.read(2))[0]
                elif n == 127: n = struct.unpack(">Q", f.read(8))[0]
                data = f.read(n)
                if op == 1:
                    return json.loads(data)
        def send_msg(obj):
            data = json.dumps(obj).encode(); mask = os.urandom(4)
            hdr = bytes([0x81]) + (bytes([0x80 | len(data)]) if len(data) < 126 else bytes([0x80 | 126]) + struct.pack(">H", len(data)))
            s.sendall(hdr + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))
        msgs = [read_msg(), read_msg()]
        self.assertIn("reset", [m["t"] for m in msgs] + ["reset"])  # epoch 비어 있으니 reset 이거나 hello
        send_msg({"t": "elements", "id": 7, "elements": [{"id": "e", "version": 1, "versionNonce": 1}]})
        ack = None
        for _ in range(10):
            m = read_msg()
            if m["t"] == "ack":
                ack = m; break
            self.assertNotEqual(m["t"], "saved")
        self.assertEqual(ack["id"], 7)
        self.store.flush()
        for _ in range(10):
            m = read_msg()
            if m["t"] == "saved":
                self.assertGreaterEqual(m["seq"], ack["seq"]); break
        else:
            self.fail("saved 없음")
        s.close()

    def test_wins_tolerates_bad_versions(self):
        self.assertFalse(srv.wins({"version": "x"}, {"version": 1}))
        self.assertTrue(srv.wins({"version": "3", "versionNonce": None}, {"version": 2}))



class Invite(unittest.TestCase):
    """초대 키 — 키 없으면 403, ?k= 는 쿠키로 바뀌고 주소에서 빠진다, 보기 키는 그리지 못한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = srv.Store(Path(self.tmp.name))
        acc = srv.Access("EDITKEY123", "VIEWKEY456", site="t1", expires_at=0)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.make_handler(self.store, DIST, None, None, acc))
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def raw(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=json.dumps(body).encode() if body is not None else None, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data

    def cookie_for(self, key):
        st, h, _ = self.raw("GET", f"/?k={key}&x=1")
        self.assertEqual(st, 200, "링크로 오면 화면을 바로 낸다(되돌려 보내지 않는다)")
        return h["Set-Cookie"].split(";")[0]

    def test_no_key_denied(self):
        self.assertEqual(self.raw("GET", "/api/whiteboard/boards")[0], 403)
        self.assertEqual(self.raw("GET", "/api/whiteboard/me", {"X-Tb-Key": "wrong"})[0], 403)
        self.assertEqual(self.raw("GET", "/?k=wrong")[0], 403)
        self.assertEqual(self.raw("POST", "/api/whiteboard/login", {"Content-Type": "application/json"}, {"name": "a"})[0], 403)
        self.assertEqual(self.raw("GET", "/healthz")[0], 200)

    def test_edit_and_view(self):
        ce, cv = self.cookie_for("EDITKEY123"), self.cookie_for("VIEWKEY456")
        H = lambda ck, name: {"Cookie": f"{ck}; wb_user={name}", "X-Whiteboard": "1", "Content-Type": "application/json"}
        st, _, d = self.raw("POST", "/api/whiteboard/boards", H(ce, "ed"), {"title": "b"})
        self.assertEqual(st, 201)
        bid = json.loads(d)["id"]
        self.assertEqual(self.raw("POST", "/api/whiteboard/boards", H(cv, "vw"), {"title": "b"})[0], 403)
        el = {"id": "e1", "version": 2, "versionNonce": 1}
        self.assertEqual(self.raw("POST", f"/api/whiteboard/boards/{bid}/elements", H(cv, "vw"), {"client": "c", "elements": [el]})[0], 403)
        self.assertEqual(self.raw("POST", f"/api/whiteboard/boards/{bid}/presence", H(cv, "vw"), {"client": "c"})[0], 204)
        self.assertEqual(self.raw("POST", f"/api/whiteboard/boards/{bid}/elements", H(ce, "ed"), {"client": "c", "elements": [el]})[0], 200)
        me_e = json.loads(self.raw("GET", "/api/whiteboard/me", H(ce, "ed"))[2])
        me_v = json.loads(self.raw("GET", "/api/whiteboard/me", H(cv, "vw"))[2])
        self.assertEqual((me_e["role"], me_v["role"]), ("edit", "view"))
        self.assertEqual(me_e["invite"], {"edit": "EDITKEY123", "view": "VIEWKEY456"})
        self.assertEqual(me_v["invite"], {"view": "VIEWKEY456"}, "보기 링크로 온 사람에게 편집 키를 주지 않는다")

    def test_without_cookies(self):
        """쿠키를 막는 브라우저 — 키는 X-Tb-Key, 이름은 X-Tb-Name 머리만으로 된다."""
        h = {"X-Tb-Key": "EDITKEY123", "X-Tb-Name": "%ED%99%8D%EA%B8%B8%EB%8F%99", "X-Whiteboard": "1", "Content-Type": "application/json"}
        st, _, d = self.raw("GET", "/api/whiteboard/me", h)
        self.assertEqual((st, json.loads(d)["name"], json.loads(d)["role"]), (200, "홍길동", "edit"))
        self.assertEqual(self.raw("POST", "/api/whiteboard/boards", h, {"title": "b"})[0], 201)


if __name__ == "__main__":
    unittest.main()
