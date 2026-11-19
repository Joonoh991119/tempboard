// node --test tools/board/whiteboard/tests/mathgate.test.mjs — R3: 옛 미리보기로 새 식을 넣지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mathKey, canInsert } from "../src/mathgate.js";

test("R3 — 미리보기 판이 지금 입력과 같을 때만 넣는다", () => {
  const prev = { svg: "<svg/>", key: mathKey("x", 32, "#000") };
  assert.equal(canInsert(prev, "x", 32, "#000", false, ""), true);
  assert.equal(canInsert(prev, "y", 32, "#000", false, ""), false, "식을 바꿨는데 조판 전");
  assert.equal(canInsert(prev, "x", 40, "#000", false, ""), false, "크기만 바꿈");
  assert.equal(canInsert(prev, "x", 32, "#D55E00", false, ""), false, "색만 바꿈");
  assert.equal(canInsert(prev, "x", 32, "#000", true, ""), false, "조판 중");
  assert.equal(canInsert(prev, "x", 32, "#000", false, "오류"), false, "오류");
  assert.equal(canInsert(null, "x", 32, "#000", false, ""), false, "미리보기 없음");
});
