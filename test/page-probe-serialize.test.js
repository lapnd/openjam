import { test, expect } from "bun:test";
import { serializeArgs, captureStack, errorText, parseStack } from "../src/page-probe/serialize.js";

test("formats console arguments like the CDP lane: strings raw, objects compact", () => {
  expect(serializeArgs(["counter is now", 3])).toBe("counter is now 3");
  expect(serializeArgs([{ b: [1, 2], s: "x" }])).toBe('{"b":[1,2],"s":x}');
  expect(serializeArgs([null, undefined, true])).toBe("null undefined true");
  expect(serializeArgs([function fooBar() {}])).toBe("function fooBar()");
});

test("cycles, depth and size are bounded", () => {
  const a = { name: "a" };
  a.self = a;
  expect(serializeArgs([a])).toContain("[Circular]");
  expect(serializeArgs([{ l1: { l2: { l3: { l4: 1 } } } }])).toBe('{"l1":{"l2":{"l3":{…}}}}');
  const big = "x".repeat(5000);
  const out = serializeArgs([big]);
  expect(out.length).toBe(1001);
  expect(out.endsWith("…")).toBe(true);
  // A clip that lands between the two halves of an astral character (emoji)
  // would leave a lone surrogate that turns into U+FFFD in the stored JSON.
  // Disconfirming: revert clip() to a plain slice(0, 1000).
  const emoji = "x".repeat(999) + "😀".repeat(10);
  const clipped = serializeArgs([emoji]);
  expect(clipped.endsWith("x…")).toBe(true);
  expect(clipped.length).toBe(1000);
  expect(clipped.isWellFormed()).toBe(true);
});

test("errors serialize to their stack, class instances keep their name", () => {
  class Thing {
    constructor() {
      this.v = 1;
    }
  }
  expect(serializeArgs([new Thing()])).toBe('Thing {"v":1}');
  expect(serializeArgs([new Error("boom")])).toMatch(/^Error: boom/);
});

test("captureStack returns name — location frames and drops the probe's own frames", () => {
  function outerFrame() {
    return captureStack(0);
  }
  const frames = outerFrame();
  expect(frames.length).toBeGreaterThan(0);
  // Function naming differs per engine (bun reports <anonymous> here, Chrome
  // "outerFrame"); the contract is the shape and that our own frame is gone.
  expect(frames[0]).toMatch(/^.+ — .*page-probe-serialize\.test\.js:\d+:\d+$/);
  expect(frames.some((f) => f.includes("src/page-probe/serialize.js"))).toBe(false);
});

// Firefox (and Safari) stacks hold frames only, no "Error: message" header. A
// stack standing in for the whole error would drop the one line people read.
// Disconfirming: make errorText return err.stack unconditionally.
test("errorText keeps the message when the engine's stack has no header (Firefox)", () => {
  const firefoxErr = { name: "Error", message: "boom", stack: "onClick@http://x.test/:37:13\n@http://x.test/app.js:1:1", toString: () => "Error: boom" };
  expect(errorText(firefoxErr)).toBe("Error: boom\nonClick@http://x.test/:37:13\n@http://x.test/app.js:1:1");
  // V8 already leads with it: not repeated
  const v8Err = { stack: "Error: boom\n    at onClick (http://x.test/:37:13)", toString: () => "Error: boom" };
  expect(errorText(v8Err)).toBe(v8Err.stack);
  // no stack at all
  expect(errorText({ toString: () => "TypeError: nope" })).toBe("TypeError: nope");
  expect(serializeArgs([Object.assign(new Error("real"), { stack: "f@u:1:2" })])).toBe("Error: real\nf@u:1:2");
});

test("parseStack reads both V8 and Firefox frame formats into name — location", () => {
  const v8 = "Error\n    at inner (http://x.test/a.js:3:9)\n    at http://x.test/a.js:7:1";
  expect(parseStack(v8)).toEqual(["inner — http://x.test/a.js:3:9", "(anonymous) — http://x.test/a.js:7:1"]);
  const firefox = "inner@http://x.test/a.js:3:9\n@http://x.test/a.js:7:1\n";
  expect(parseStack(firefox)).toEqual(["inner — http://x.test/a.js:3:9", "(anonymous) — http://x.test/a.js:7:1"]);
  // drop skips leading frames in either format
  expect(parseStack(firefox, 1)).toEqual(["(anonymous) — http://x.test/a.js:7:1"]);
  expect(parseStack(v8, 1)).toEqual(["(anonymous) — http://x.test/a.js:7:1"]);
  expect(parseStack("")).toEqual([]);
});
