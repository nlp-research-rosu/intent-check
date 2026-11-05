// First n UTF-16 units, backing off one if that would cut a surrogate pair in half.
export function clip(s, n) {
  if (typeof s !== "string") return null;
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
