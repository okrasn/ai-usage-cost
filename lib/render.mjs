const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

// JSON that is safe inside an inline <script>: no literal "</script>" or "<!--",
// and no raw U+2028/U+2029 line terminators.
export function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(LINE_SEP, "\\u2028")
    .replaceAll(PARA_SEP, "\\u2029");
}

// Library source inlined into a <script>: a literal "</script" inside it would end the block.
const inlineScript = src => src.replace(/<\/script/gi, "<\\/script");

// Single pass, so inserted content is never re-scanned for placeholders.
export function renderHtml(template, payload, chartJs = "") {
  return template.replace(/__DATA__|__CHARTJS__/g, token => (token === "__DATA__" ? safeJson(payload) : inlineScript(chartJs)));
}
