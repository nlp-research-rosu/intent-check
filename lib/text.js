// String helpers for anything that leaves the machine. Postgres jsonb rejects \u0000 and lone
// surrogates, so every sent string is made well-formed, and clipping never splits a pair.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function wellFormed(s) {
  return String(s).replace(/\u0000/g, "").replace(LONE, "�");
}

// First n UTF-16 units, backing off one if that would cut a surrogate pair in half.
export function clip(s, n) {
  if (typeof s !== "string") return null;
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

// Make every string in a JSON-able value well-formed (in place for objects/arrays).
export function deepWellFormed(v) {
  if (typeof v === "string") return wellFormed(v);
  if (Array.isArray(v)) return v.map(deepWellFormed);
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) v[k] = deepWellFormed(v[k]);
  }
  return v;
}
