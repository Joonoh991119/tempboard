import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import { resolve } from "node:path";

// 빌드 결과는 같은 출처 정적 파일 — 서버 CSP(script-src · style-src 'self')에서 돈다.
export default defineConfig({
  base: "/",
  plugins: [
    react(),
    {
      // Excalidraw 는 글꼴을 EXCALIDRAW_ASSET_PATH 다음에 esm.sh 에서도 찾는다 — CSP 가 막으므로 같은 출처(없는 경로)로 돌린다
      name: "no-cdn-font-fallback",
      renderChunk(code) {
        return code.includes("https://esm.sh/") ? { code: code.split("https://esm.sh/").join("${window.location.origin}/__no-cdn__/"), map: null } : null;
      },
    },
    {
      name: "copy-excalidraw-fonts",
      closeBundle() {
        cpSync(resolve("node_modules/@excalidraw/excalidraw/dist/prod/fonts"), resolve("dist/fonts"), { recursive: true });
      },
    },
  ],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:8790" } },
});
