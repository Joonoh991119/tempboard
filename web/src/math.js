// LaTeX → SVG(MathJax 3, Apache-2.0). 글꼴을 패스로 넣어(fontCache none) 그림 하나로 독립 — 어디서 열어도 같은 모양.
// 처음 쓸 때만 불러온다(수식을 안 쓰면 받지 않는다).
let engine = null;

async function load() {
  if (engine) return engine;
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
    import("mathjax-full/js/mathjax.js"),
    import("mathjax-full/js/input/tex.js"),
    import("mathjax-full/js/output/svg.js"),
    import("mathjax-full/js/adaptors/liteAdaptor.js"),
    import("mathjax-full/js/handlers/html.js"),
    import("mathjax-full/js/input/tex/AllPackages.js"),
  ]);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const html = mathjax.document("", {
    InputJax: new TeX({ packages: AllPackages.filter((p) => p !== "bussproofs") }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  engine = { adaptor, html };
  return engine;
}

/** tex → {svg, width, height, error}. size = 글자 크기(px). color = 수식 색. */
export async function texToSvg(tex, { size = 28, color = "#1e1e1e", display = true } = {}) {
  const { adaptor, html } = await load();
  const node = html.convert(String(tex || ""), { display, em: size, ex: size / 2, containerWidth: 2000 });
  let svg = adaptor.innerHTML(node);
  const err = /data-mml-node="merror"/.test(svg) ? (svg.match(/<title>([^<]*)<\/title>/) || [])[1] || "수식을 읽지 못했어요" : null;
  const m = /width="([\d.]+)ex" height="([\d.]+)ex"/.exec(svg);
  const width = m ? parseFloat(m[1]) * (size / 2) : 200;
  const height = m ? parseFloat(m[2]) * (size / 2) : 60;
  svg = svg
    .replace(/width="[\d.]+ex"/, `width="${width.toFixed(1)}"`)
    .replace(/height="[\d.]+ex"/, `height="${height.toFixed(1)}"`)
    .replace(/\sstyle="[^"]*"/, "")
    .replace(/currentColor/g, color);
  if (!/xmlns=/.test(svg)) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg, width, height, error: err };
}

export function svgDataURL(svg) {
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}

export async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
