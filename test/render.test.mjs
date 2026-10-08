import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHtml, safeJson } from "../lib/render.mjs";

test("embedded JSON cannot terminate the script block", () => {
  const out = safeJson({ m: "</script><script>alert(1)</script>", s: `a${String.fromCharCode(0x2028)}b` });
  assert.ok(!out.includes("</script>"));
  assert.ok(!out.includes(String.fromCharCode(0x2028)));
  assert.deepEqual(JSON.parse(out).m, "</script><script>alert(1)</script>"); // still round-trips
});

test("user name is HTML-escaped in every placeholder", () => {
  const html = renderHtml("<title>__USER_NAME__</title><h1>__USER_NAME__</h1>", {}, `<img src=x onerror="1">`);
  assert.ok(!html.includes("<img"));
  assert.equal((html.match(/&lt;img/g) ?? []).length, 2);
});

test("inserted content is not re-scanned for placeholders", () => {
  const html = renderHtml("A __USER_NAME__ B __DATA__", { note: "__USER_NAME__" }, "__DATA__");
  assert.ok(html.startsWith("A __DATA__ B "));
  assert.ok(html.includes('"note":"__USER_NAME__"'));
});

test("inlined library source keeps </script and $-patterns intact", () => {
  const lib = 'var a="</script><b>";var p="$&$1$`";';
  const html = renderHtml("<script>__CHARTJS__</script>", {}, "u", lib);
  assert.equal(html.match(/<\/script>/g).length, 1); // only the real closing tag
  assert.ok(html.includes('<\\/script><b>'));
  assert.ok(html.includes('"$&$1$`"')); // no special replacement-pattern expansion
});
