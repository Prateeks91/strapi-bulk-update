/**
 * Robust RFC-4180 compliant CSV parser for Strapi Bulk Updater.
 *
 * Guarantees correct parsing for:
 * 1. Multiline strings & HTML content with embedded line breaks (\n, \r\n, \r) inside quotes.
 * 2. Commas embedded inside double-quoted cells without shifting subsequent columns.
 * 3. Escaped double quotes ("" -> ").
 * 4. Leading/trailing whitespace outside quotes.
 * 5. UTF-8 Byte Order Mark (BOM).
 * 6. Excel formula injection unescaping ('=, '+, '-, '@).
 */

export function parseCsvRows(csvText: string): string[][] {
  if (!csvText) return [];

  // Strip UTF-8 BOM if present
  let text = csvText;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let cellIsQuoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote: "" -> "
          currentCell += '"';
          i++; // skip second quote
        } else {
          // Closing quote
          inQuotes = false;
        }
      } else {
        // Any character inside quotes (including \r, \n, commas, HTML tags) is preserved verbatim
        currentCell += char;
      }
    } else {
      if (char === '"' && !cellIsQuoted && currentCell.trim() === '') {
        // Opening quote (discards leading whitespace before opening quote)
        inQuotes = true;
        cellIsQuoted = true;
        currentCell = '';
      } else if (char === ',') {
        currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
        currentCell = '';
        cellIsQuoted = false;
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++; // Skip \n in \r\n sequence
        }
        currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
        if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
        cellIsQuoted = false;
      } else if (char === '\n') {
        currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
        if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
        cellIsQuoted = false;
      } else {
        // If cell was already quoted and closed, ignore trailing whitespace between closing quote and comma
        if (!(cellIsQuoted && !inQuotes && (char === ' ' || char === '\t'))) {
          currentCell += char;
        }
      }
    }
  }

  if (currentCell !== '' || cellIsQuoted || currentRow.length > 0) {
    currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
    if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

export function parseCsv(csvText: string): Array<Record<string, string>> {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  const records: Array<Record<string, string>> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      let val = row[idx] !== undefined ? row[idx] : '';
      // Unescape leading single quote if added for Excel formula safety ('=, '+, '-, '@)
      if (typeof val === 'string' && /^'[=+@-]/.test(val)) {
        val = val.substring(1);
      }
      record[h] = val;
    });
    records.push(record);
  }

  return records;
}
