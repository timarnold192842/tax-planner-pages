const fs = require('node:fs');
const path = require('node:path');
const { importETradeOne } = require('./parser.js');

const FIX = path.join(__dirname, 'test-fixtures');
const optText = fs.readFileSync(path.join(FIX, 'options.csv'), 'utf8');
const restText = fs.readFileSync(path.join(FIX, 'restricted.csv'), 'utf8');

function fmt(g) {
  const vs = g.vestSchedule || [];
  const first = vs[0]?.date || '—';
  const last  = vs[vs.length-1]?.date || '—';
  return `${g.type}  ${g.label.padEnd(18)}  shares=${String(g.shares).padStart(6)}  ` +
         `strike=${String(g.strike).padStart(6)}  grantDate=${g.grantDate}  exp=${g.expDate}  ` +
         `vests=${String(vs.length).padStart(2)}  ${first}→${last}  ` +
         `cadence=${g.cadence}  months=${g.vestMonths}  cliff=${g.cliffMonths}`;
}

console.log('\n=== Options ===');
const opt = importETradeOne(optText, 'options.csv');
console.log(`Kind: ${opt.diag.kind} · Header row ${opt.diag.headerRow}`);
console.log(`Record types: ${opt.diag.recordTypes.join(', ')}`);
console.log(`Event types: ${opt.diag.eventTypes.join(', ')}`);
console.log(`Column mapping:`);
for (const [k, v] of Object.entries(opt.diag.columns)) {
  console.log(`  ${k.padEnd(12)}: col ${String(v).padStart(3)} = ${opt.diag.headerCells[v] || '—'}`);
}
opt.grants.forEach(g => console.log('  ' + fmt(g)));

console.log('\n=== Restricted ===');
const rst = importETradeOne(restText, 'restricted.csv');
console.log(`Kind: ${rst.diag.kind} · Header row ${rst.diag.headerRow}`);
console.log(`Record types: ${rst.diag.recordTypes.join(', ')}`);
console.log(`Event types: ${rst.diag.eventTypes.join(', ')}`);
console.log(`Column mapping:`);
for (const [k, v] of Object.entries(rst.diag.columns)) {
  console.log(`  ${k.padEnd(12)}: col ${String(v).padStart(3)} = ${rst.diag.headerCells[v] || '—'}`);
}
rst.grants.forEach(g => console.log('  ' + fmt(g)));

// Assertions
console.log('\n=== Assertions ===');
const expectations = {
  // Options
  'ISO I1705000':  { months: 48, cliff: 0,  vests: 48, cadence: 'monthly' },
  'ISO I1703120':  { months: 24, cliff: 0,  vests: 24, cadence: 'monthly' },
  'ISO I1700632':  { months: 37, cliff: 11, vests: 37, cadence: 'monthly' },
  'ISO I1702023':  { months: 0,  cliff: 11, vests: 1,  cadence: 'cliff' },
  // Restricted
  'RSU R181231':   { months: 0,  cliff: 1,  vests: 1,  cadence: 'cliff' }, // grant 2025-04-23 → vest 2025-05-12 = ~1mo cliff
  'RSU R175995':   { months: 24, cliff: 0,  vests: 8,  cadence: 'quarterly' },
  'RSU R174856':   { months: 0,  cliff: 11, vests: 1,  cadence: 'cliff' },
  'RSU R180005':   { months: 48, cliff: 0,  vests: 16, cadence: 'quarterly' },
  'RSU R173728':   { months: 48, cliff: 0,  vests: 16, cadence: 'quarterly' },
  'RSU R177886':   { months: 48, cliff: 0,  vests: 16, cadence: 'quarterly' },
  'RSU R183639':   { months: 48, cliff: 0,  vests: 16, cadence: 'quarterly' },
};
const all = [...opt.grants, ...rst.grants];
let pass = 0, fail = 0;
for (const [label, exp] of Object.entries(expectations)) {
  const g = all.find(x => x.label === label);
  if (!g) { console.log(`  ✗ ${label}: MISSING`); fail++; continue; }
  const actual = { vests: g.vestSchedule.length, cadence: g.cadence, months: g.vestMonths, cliff: g.cliffMonths };
  const monthsOk = Math.abs(actual.months - exp.months) <= 2;
  const cliffOk  = Math.abs(actual.cliff - exp.cliff) <= 1;
  const ok = actual.vests === exp.vests && actual.cadence === exp.cadence && monthsOk && cliffOk;
  const mark = ok ? '✓' : '✗';
  if (ok) pass++; else fail++;
  console.log(`  ${mark} ${label}: vests=${actual.vests}(want ${exp.vests}) cadence=${actual.cadence}(want ${exp.cadence}) months=${actual.months}(want ${exp.months}) cliff=${actual.cliff}(want ${exp.cliff})`);
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
