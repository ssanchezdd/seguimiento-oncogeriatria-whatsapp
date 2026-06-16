/* csv.js — CSV parse/serialize (Plan §7.4).
 * Supports configurable separator (",", ";") for Colombian Excel,
 * quoted fields, and UTF-8.
 */
(function () {
  function detectSep(text) {
    const firstLine = text.split(/\r?\n/)[0] || '';
    const commas = (firstLine.match(/,/g) || []).length;
    const semis = (firstLine.match(/;/g) || []).length;
    return semis > commas ? ';' : ',';
  }

  function parse(text, sep) {
    text = text.replace(/^﻿/, ''); // strip BOM
    sep = sep || detectSep(text);
    const rows = [];
    let field = '', row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === sep) {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); field = ''; row = [];
      } else if (c === '\r') {
        // ignore
      } else field += c;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    // Drop fully empty trailing rows.
    const clean = rows.filter((r) => r.some((v) => v.trim() !== ''));
    if (clean.length === 0) return { headers: [], rows: [], sep };
    const headers = clean[0].map((h) => h.trim().toLowerCase());
    const objs = clean.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, idx) => { o[h] = (r[idx] || '').trim(); });
      return o;
    });
    return { headers, rows: objs, sep };
  }

  function serialize(rows, headers, sep) {
    sep = sep || ',';
    function esc(v) {
      v = v == null ? '' : String(v);
      if (v.includes('"') || v.includes(sep) || v.includes('\n')) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    }
    const lines = [headers.map(esc).join(sep)];
    rows.forEach((r) => lines.push(headers.map((h) => esc(r[h])).join(sep)));
    return '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8
  }

  function download(filename, content) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.CSV = { parse, serialize, download, detectSep };
})();
