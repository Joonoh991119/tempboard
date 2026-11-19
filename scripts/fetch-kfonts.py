#!/usr/bin/env python3
"""한글 글꼴(OFL, Google Fonts)을 번호 조각(unicode-range)째 내려받아 web/public/kfonts 에 두고
web/src/kfonts-extra.css 를 만든다. 각 한글 글꼴은 Excalidraw 글꼴 칸 하나에 붙는다
(영문은 그 칸의 Excalidraw 글꼴, 한글은 여기 글꼴). 한 번 돌려 결과를 커밋한다.

    python3 scripts/fetch-kfonts.py
"""
import hashlib, re, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "kfonts"
CSS = ROOT / "web" / "src" / "kfonts-extra.css"
# (Google Fonts 이름, Excalidraw 글꼴 칸)
FONTS = [
    ("Nanum Pen Script", "Virgil"),
    ("Black Han Sans", "Lilita One"),
    ("Nanum Gothic Coding", "Cascadia"),
    ("Jua", "Comic Shanns"),
    ("Nanum Myeongjo", "Liberation Sans"),
]
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    lines = ["/* 한글 글꼴 더(OFL, Google Fonts) — scripts/fetch-kfonts.py 가 만든다. 고치지 말고 다시 돌린다. */"]
    for name, slot in FONTS:
        css = get("https://fonts.googleapis.com/css2?family=" + name.replace(" ", "+") + ":wght@400&display=swap").decode()
        stem = name.replace(" ", "")
        n = 0
        for block in re.findall(r"@font-face\s*\{(.*?)\}", css, re.S):
            url = re.search(r"url\((https://[^)]+\.woff2)\)", block)
            rng = re.search(r"unicode-range:\s*([^;]+);", block)
            if not url or not rng:
                continue
            ranges = rng.group(1).strip()
            # 한글 · CJK · 전각 조각만(영문 조각은 Excalidraw 글꼴이 맡는다)
            if not re.search(r"U\+(1[1-9a-f]|3[0-9a-f]|[a-f])[0-9a-f]{2,3}", ranges, re.I):
                continue
            data = get(url.group(1))
            fn = f"{stem}-400-{hashlib.sha1(data).hexdigest()[:10]}.woff2"
            (OUT / fn).write_bytes(data)
            lines.append(f"@font-face{{font-family:'{slot}';font-style:normal;font-weight:400;font-display:swap;"
                         f"src:url(/kfonts/{fn}) format('woff2');unicode-range:{ranges};}}")
            n += 1
        print(f"{name} → {slot}: {n} 조각", file=sys.stderr)
    CSS.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
