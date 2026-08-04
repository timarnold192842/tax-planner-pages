/* ================================================================
   E*TRADE CSV parser — standalone module.
   Works in both the browser (attaches to globalThis) and Node
   (via module.exports). Zero DOM dependencies.
================================================================ */

(function () {
  const uid = () => Math.random().toString(36).slice(2, 9);

  function detectDelimiter(text) {
    const clean = text.replace(/^\uFEFF/, '');
    const lines = clean.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
    const candidates = [',', '\t', ';', '|'];
    const counts = candidates.map(d => {
      const perLine = lines.map(l => (l.match(new RegExp('\\' + d, 'g')) || []).length);
      perLine.sort((a, b) => a - b);
      return perLine[Math.floor(perLine.length / 2)] || 0;
    });
    let best = 0, bestIdx = 0;
    counts.forEach((c, i) => { if (c > best) { best = c; bestIdx = i; } });
    return best > 0 ? candidates[bestIdx] : ',';
  }

  function parseCSV(text, delim) {
    const clean = text.replace(/^\uFEFF/, '');
    const d = delim || detectDelimiter(clean);
    const lines = clean.split(/\r?\n/);
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const cells = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQ = false;
          else cur += c;
        } else {
          if (c === d) { cells.push(cur); cur = ''; }
          else if (c === '"') inQ = true;
          else cur += c;
        }
      }
      cells.push(cur);
      rows.push(cells);
    }
    rows._delim = d;
    return rows;
  }

  function numOrZero(v) {
    if (v == null) return 0;
    const s = String(v).replace(/[$,\s]/g, '');
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  function monthIndex(name) {
    return ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
      .findIndex(x => name.toLowerCase().startsWith(x));
  }

  function normDate(v) {
    if (v == null || v === '') return '';
    let s = String(v).trim();
    if (!s) return '';
    s = s.replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?Z?$/, '');
    // dd-MMM-yyyy or dd-MMM-yy (E*TRADE uses this on grant summary rows: "08-MAR-2024")
    let m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-](\d{2,4})$/);
    if (m) {
      const mi = monthIndex(m[2]);
      let y = m[3]; if (y.length === 2) y = (+y > 50 ? '19' : '20') + y;
      if (mi >= 0) return `${y}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      let mo = m[1], d = m[2], y = m[3];
      if (y.length === 2) y = (+y > 50 ? '19' : '20') + y;
      if (+mo > 12 && +y > 12) return '';
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m) {
      const mi = monthIndex(m[1]);
      if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    const t = Date.parse(s);
    if (!isNaN(t)) {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return '';
  }

  /**
   * Look on a row for a per-vest quantity value using the header positions.
   * Scans columns to the right of Vest Date for a "qty"-flavored column with
   * a plausible positive integer (rejects dollar amounts and >2× total granted).
   */
  function extractVestQty(row, cVestDate, header, totalShares) {
    if (cVestDate < 0) return 0;
    const isQtyHeader = h => /(^|\s)(qty|qty\.|quantity|granted qty|granted qty\.|vesting qty|vesting qty\.|vested qty|vested qty\.|released qty|shares)(\s|$|,|\.)/i.test(' ' + (h || '') + ' ');
    // Prefer columns immediately after Vest Date, walking right
    for (let j = cVestDate + 1; j <= Math.min(cVestDate + 10, row.length - 1); j++) {
      const hName = header[j] || '';
      if (!isQtyHeader(hName)) continue;
      const raw = (row[j] || '').trim();
      if (!raw) continue;
      if (raw.includes('$')) continue;      // dollar amount
      const v = numOrZero(raw);
      if (v <= 0) continue;
      if (totalShares > 0 && v > totalShares * 2) continue; // reject dollar-esque outliers
      return v;
    }
    return 0;
  }

  /**
   * Parse one E*TRADE CSV. Returns { grants, diag }.
   * Strategy: only use Record Type == "Vest Schedule" rows to build the vest
   * schedule (they include the FULL past+future schedule). Fall back to Event
   * rows with Event Type = "Shares vested" when Vest Schedule rows aren't
   * available (older exports).
   */
  function importETradeOne(text, filename) {
    const rows = parseCSV(text);
    const delim = rows._delim || ',';
    const delimName = delim === '\t' ? 'TAB' : delim === ',' ? 'comma' : delim === ';' ? 'semicolon' : delim === '|' ? 'pipe' : delim;
    const diag = {
      filename, headerRow: -1, kind: 'unknown', columns: {}, warn: [], grants: 0,
      headerCells: [], sampleRow: [], delimiter: delimName,
      recordTypes: new Set(), eventTypes: new Set(),
    };
    if (!rows.length) return { grants: [], diag: { ...diag, err: 'Empty file' } };

    let headerIdx = -1, headerRaw = null;
    for (let i = 0; i < Math.min(80, rows.length); i++) {
      const r = rows[i].map(c => (c || '').trim());
      const lower = r.map(c => c.toLowerCase());
      if ((lower.some(c => c === 'grant number' || c === 'grant #' || c.includes('grant number')))
          && (lower.some(c => c.includes('grant date') || c.includes('grant type') || c.includes('award type')))) {
        headerIdx = i; headerRaw = r; break;
      }
    }
    if (headerIdx < 0) {
      diag.headerCells = (rows[0] || []).slice(0, 20);
      return { grants: [], diag: { ...diag, err: 'No E*TRADE header row detected.' } };
    }
    const header = headerRaw.map(c => c.toLowerCase().trim());
    diag.headerRow = headerIdx + 1;
    diag.headerCells = headerRaw;

    const findCol = (candidates) => {
      for (const c of candidates) { const i = header.findIndex(h => h === c); if (i >= 0) return i; }
      for (const c of candidates) { const i = header.findIndex(h => h.includes(c)); if (i >= 0) return i; }
      return -1;
    };

    const cNumber   = findCol(['grant number', 'grant #', 'grant id']);
    const cType     = findCol(['award type', 'grant type', 'plan type', 'type']);
    const cGrantDt  = findCol(['grant date', 'award date']);
    const cShares   = findCol(['granted qty.', 'granted qty', 'total grant', 'total granted', 'granted', 'shares granted', 'grant quantity']);
    const cStrike   = findCol(['exercise price', 'grant price', 'strike price', 'strike']);
    const cExp      = findCol(['expiration date', 'expiration', 'expire date']);
    const cVestSt   = findCol(['vest start', 'vest from', 'vesting start date']);
    const cVestMo   = findCol(['vest period', 'vesting term', 'vest term']);
    const cVestedNow= findCol(['exercisable qty.', 'exercisable qty', 'exercisable', 'sellable qty.', 'sellable qty', 'sellable']);
    const cVestDate = findCol(['vest date', 'vesting date']);
    const cRecType  = findCol(['record type']);
    const cEventType= findCol(['event type']);
    const cEventDate= findCol(['date']); // event date column (per-event)
    // Per-event quantity column (used on Event rows, distinct from Vest Schedule)
    const cEventQty = (() => {
      const strict = ['qty. or amount', 'qty or amount', 'qty', 'qty.'];
      for (const s of strict) {
        const i = header.findIndex(h => h === s);
        if (i >= 0) return i;
      }
      return -1;
    })();

    diag.columns = {
      number: cNumber, type: cType, grantDate: cGrantDt, shares: cShares, strike: cStrike,
      expiration: cExp, vestStart: cVestSt, vestPeriod: cVestMo, vested: cVestedNow,
      vestDate: cVestDate, recordType: cRecType, eventType: cEventType,
      eventDate: cEventDate, eventQty: cEventQty,
    };

    if (cRecType >= 0)              diag.kind = 'E*TRADE per-vest export';
    else if (cStrike >= 0 && cExp >= 0) diag.kind = 'Stock Options (summary)';
    else if (cVestedNow >= 0 && cStrike < 0) diag.kind = 'Restricted Stock (summary)';
    else diag.kind = 'Generic';

    const cell = (r, i) => (i >= 0 && r[i] != null) ? String(r[i]).trim() : '';

    const byNum = new Map();
    let lastNum = null;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.length) continue;

      let num = cell(r, cNumber);
      if (!num) num = lastNum;
      if (!num) continue;

      if (!diag.sampleRow.length) diag.sampleRow = r.slice(0, headerRaw.length);

      let g = byNum.get(num);
      if (!g) {
        const rawType = cell(r, cType).toUpperCase();
        const typeNorm =
            rawType.includes('RSU') || rawType.includes('RESTRICTED') ? 'RSU'
          : rawType.includes('ISO') || rawType.includes('INCENTIVE') ? 'ISO'
          : rawType.includes('NSO') || rawType.includes('NON-QUAL') || rawType.includes('NONQUAL') || rawType.includes('NQSO') ? 'NSO'
          : (cStrike >= 0 ? 'ISO' : 'RSU');
        g = {
          id: uid(),
          type: typeNorm,
          label: `${typeNorm} ${num}`,
          grantDate: '',
          shares: 0,
          strike: 0,
          fmvAtGrant: 0,
          vestStart: '',
          cadence: typeNorm === 'RSU' ? 'quarterly' : 'monthly',
          vestMonths: 0,
          cliffMonths: 0,
          exercisableNow: 0,
          expDate: '',
          vestSchedule: [],
          _hasVestScheduleRows: false,
          _fallbackEvents: [],
        };
        byNum.set(num, g);
      }
      lastNum = num;

      const recType = cell(r, cRecType).toLowerCase();
      const evt     = cell(r, cEventType).toLowerCase();
      if (recType) diag.recordTypes.add(recType);
      if (evt)     diag.eventTypes.add(evt);

      // Grant summary field extraction: first non-empty per field, from any row.
      if (!g.grantDate)     g.grantDate = normDate(cell(r, cGrantDt));
      if (!g.expDate)       g.expDate   = normDate(cell(r, cExp));
      if (!g.vestStart)     g.vestStart = normDate(cell(r, cVestSt));
      if (!g.shares)        { const v = numOrZero(cell(r, cShares)); if (v > 0) g.shares = v; }
      if (!g.strike)        { const v = numOrZero(cell(r, cStrike)); if (v > 0) g.strike = v; }
      if (!g.exercisableNow){ const v = numOrZero(cell(r, cVestedNow)); if (v > 0) g.exercisableNow = v; }
      if (!g.vestMonths)    {
        // NOTE: don't read "Vest Period" — on E*TRADE Restricted exports it's
        // the vest sequence number (1..N), not the vest period in months.
        // Only accept from a column named "vesting term" or "vest term".
        const cTerm = header.findIndex(h => h === 'vesting term' || h === 'vest term');
        if (cTerm >= 0) { const v = numOrZero(cell(r, cTerm)); if (v > 0) g.vestMonths = v; }
      }

      // Vest event extraction — two paths:
      // (a) "Vest Schedule" rows have a Vest Date and a per-vest qty nearby.
      // (b) "Event" rows with Event Type == "Shares vested" are historical.
      if (recType === 'vest schedule') {
        const vestDate = normDate(cell(r, cVestDate));
        if (vestDate) {
          const q = extractVestQty(r, cVestDate, header, g.shares);
          if (q > 0) {
            g.vestSchedule.push({ date: vestDate, shares: q });
            g._hasVestScheduleRows = true;
          }
        }
      } else if (recType === 'event' && evt.includes('vested')) {
        // Fallback: use Date + Qty
        const evDate = normDate(cell(r, cEventDate));
        const evQty = cEventQty >= 0 ? numOrZero(cell(r, cEventQty)) : 0;
        if (evDate && evQty > 0 && (!g.shares || evQty <= g.shares * 2)) {
          g._fallbackEvents.push({ date: evDate, shares: evQty });
        }
      }
    }

    // Post-process: prefer Vest Schedule; else use fallback events.
    byNum.forEach(g => {
      const source = g._hasVestScheduleRows ? g.vestSchedule : g._fallbackEvents;
      // Dedupe by date, sum shares (unlikely to have duplicates in Vest Schedule)
      const byDate = new Map();
      source.forEach(v => {
        const cur = byDate.get(v.date);
        if (!cur || v.shares > cur.shares) byDate.set(v.date, { date: v.date, shares: v.shares });
      });
      g.vestSchedule = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      delete g._hasVestScheduleRows;
      delete g._fallbackEvents;

      if (g.vestSchedule.length) {
        const sum = g.vestSchedule.reduce((s, v) => s + v.shares, 0);
        if (!g.shares) g.shares = sum;
        g.vestStart = g.vestSchedule[0].date;
        if (g.vestSchedule.length > 1) {
          const first = new Date(g.vestSchedule[0].date + 'T00:00:00');
          const last  = new Date(g.vestSchedule[g.vestSchedule.length - 1].date + 'T00:00:00');
          const totalMonths = Math.round((last - first) / (30.4375 * 86400e3));
          const gapMonths = Math.round(totalMonths / (g.vestSchedule.length - 1));
          g.cadence = gapMonths >= 10 ? 'annual' : gapMonths >= 2 ? 'quarterly' : 'monthly';
          // Total vest window in months = span + one final gap (so a monthly
          // grant with 48 vests over 47 months of span reports as 48 months).
          g.vestMonths = totalMonths + gapMonths;
          if (g.grantDate) {
            const grant = new Date(g.grantDate + 'T00:00:00');
            const preGap = Math.round((first - grant) / (30.4375 * 86400e3));
            const sortedShares = [...g.vestSchedule].map(v => v.shares).sort((a, b) => a - b);
            const median = sortedShares[Math.floor(sortedShares.length / 2)];
            const firstIsCliff = median > 0 && g.vestSchedule[0].shares > median * 2;
            if (firstIsCliff) g.cliffMonths = preGap;
            else if (preGap > gapMonths * 2 && preGap > 3) g.cliffMonths = preGap;
          }
        } else {
          // Single-vest grant: entire grant vests on one date.
          g.cadence = 'cliff';
          g.vestMonths = 0;
          if (g.grantDate) {
            const grant = new Date(g.grantDate + 'T00:00:00');
            const only  = new Date(g.vestSchedule[0].date + 'T00:00:00');
            g.cliffMonths = Math.round((only - grant) / (30.4375 * 86400e3));
          }
        }
      }
      if (!g.fmvAtGrant && g.strike) g.fmvAtGrant = g.strike;
    });

    diag.recordTypes = [...diag.recordTypes];
    diag.eventTypes = [...diag.eventTypes];
    diag.grants = byNum.size;
    return { grants: [...byNum.values()], diag };
  }

  function importETradeMulti(files, done) {
    const perFile = [];
    let remaining = files.length;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        perFile.push(importETradeOne(reader.result, file.name));
        if (--remaining === 0) done(perFile);
      };
      reader.readAsText(file);
    });
  }

  const api = { detectDelimiter, parseCSV, normDate, numOrZero, monthIndex,
                extractVestQty, importETradeOne, importETradeMulti };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(typeof globalThis !== 'undefined' ? globalThis : window, api);
})();
