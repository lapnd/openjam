// Pure formatting for the page probe (src/page-probe.js): turn console
// arguments into the one-line text the CDP lane produces from RemoteObjects,
// and capture a stack without the probe's own frames. No DOM, no globals
// beyond Error — unit-tested directly.
const MAX_ARG_CHARS = 1000;
const MAX_DEPTH = 3;

function clip(s) {
  if (s.length <= MAX_ARG_CHARS) return s;
  let cut = s.slice(0, MAX_ARG_CHARS);
  // Don't split a surrogate pair: drop a dangling lead surrogate at the boundary.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "…";
}

function serializeOne(value, depth, seen) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return value;
  if (type === "number" || type === "boolean" || type === "bigint" || type === "symbol") return String(value);
  if (type === "undefined") return "undefined";
  if (type === "function") return "function " + (value.name || "") + "()";
  if (value instanceof Error) return errorText(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[…]" : "{…}";
  seen.add(value);
  try {
    if (Array.isArray(value)) return "[" + value.map((v) => serializeOne(v, depth + 1, seen)).join(",") + "]";
    if (value instanceof Date) return value.toISOString();
    if (typeof Node !== "undefined" && value instanceof Node) return "<" + String(value.nodeName).toLowerCase() + ">";
    const keys = Object.keys(value);
    const body = keys.map((k) => JSON.stringify(k) + ":" + serializeOne(value[k], depth + 1, seen)).join(",");
    const label = value.constructor && value.constructor.name && value.constructor.name !== "Object" ? value.constructor.name + " " : "";
    return label + "{" + body + "}";
  } catch {
    return "[object]";
  } finally {
    seen.delete(value);
  }
}

// Strings stay raw; everything else JSON-ish, depth-capped, cycle-safe,
// clipped per argument. Joined with spaces like console output.
export function serializeArgs(args) {
  const seen = new Set(); // one per call: serializeOne removes each value on the way out
  return Array.from(args, (a) => clip(serializeOne(a, 0, seen))).join(" ");
}

// An error as text, message included. V8's `stack` leads with "Name: message";
// Firefox's and Safari's hold only frames ("fn@url:line:col"), so on those the
// message would be lost if the stack stood in for the whole error.
export function errorText(err) {
  const stack = err && err.stack ? String(err.stack) : "";
  const head = String(err);
  return !stack ? head : stack.includes(head) ? stack : head + "\n" + stack;
}

// Stack text -> "name — url:line:col" frames, matching the CDP lane's
// formatStackTrace output. Reads V8's "at fn (url:l:c)" frames and
// Firefox/Safari's "fn@url:l:c" ones. Drops the first `drop` frames.
export function parseStack(raw, drop = 0) {
  const lines = String(raw || "").split("\n").map((l) => l.trim());
  const v8 = lines.some((l) => l.startsWith("at "));
  // V8 leads with an "Error" header line, which the `at ` filter drops.
  const frames = (v8 ? lines.filter((l) => l.startsWith("at ")) : lines.filter(Boolean)).slice(drop);
  return frames.map((l) => {
    if (v8) {
      const frame = l.replace(/^at\s+/, "");
      const m = /^(.*?)\s+\((.*)\)$/.exec(frame);
      return m ? m[1] + " — " + m[2] : "(anonymous) — " + frame;
    }
    const at = l.indexOf("@");
    return (at > 0 ? l.slice(0, at) : "(anonymous)") + " — " + l.slice(at + 1);
  });
}

// The caller's stack, without this function's own frame plus `skip` more (the
// probe passes 1 for its console wrapper).
export function captureStack(skip = 0) {
  return parseStack(new Error().stack, 1 + skip);
}
