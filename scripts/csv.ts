/** RFC-style quoted CSV, including escaped quotes and embedded newlines. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field.replace(/\r$/, ''));
      field = '';
      if (char === '\n') { rows.push(row); row = []; }
    } else field += char;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift();
  if (!headers) throw new Error('Empty CSV');
  return rows.filter((r) => r.some(Boolean)).map((values) => {
    if (values.length !== headers.length) throw new Error('CSV column count changed');
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });
}
