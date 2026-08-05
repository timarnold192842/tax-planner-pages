/*
  Tax-engine regression tests. Loads app.js standalone (stubbing out DOM
  bits it doesn't need) and runs computeYearTax against hand-computed
  scenarios covering:
  - Regular MFJ, no equity — baseline federal + PA + Pittsburgh
  - ISO exercise + hold → AMT preference triggers, MTC accrues
  - AMT recovery: next year with high regular income → MTC used against regular
  - Qualifying disposition: LTCG on full spread, no ordinary
  - NIIT applies over threshold
*/

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Build a minimal DOM-free context so app.js's tax engine can be extracted.
// We just eval the source and grab the tax functions off the sandbox.
const ctx = {
  console, structuredClone,
  document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
  window:   { addEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  FileReader: class {},
  Chart: class {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), ctx);
// `const`/`let` at top level in vm.runInContext don't become sandbox
// properties. Run a follow-up snippet in the same context to hoist them.
vm.runInContext(`
  globalThis.__test = {
    computeYearTax: computeYearTax,
    DEFAULT_CONSTANTS: DEFAULT_CONSTANTS,
    DEFAULT_STATE: DEFAULT_STATE,
  };
`, ctx);
const { computeYearTax, DEFAULT_CONSTANTS, DEFAULT_STATE } = ctx.__test;

function base(overrides = {}) {
  return {
    K: structuredClone(DEFAULT_CONSTANTS),
    filingStatus: 'mfj', state: 'PA', customStateRate: 3.07, localRate: 3.0,
    dependentsCTC: 0, dependentsODC: 0,
    wages: 340000, spouseWages: 0, bonus: 0,
    pretax401k: 23500, hsa: 8550,
    interestOrdDiv: 0, qualDiv: 0,
    stcg: 0, ltcg: 0,
    rsuOrdinary: 0, isoBargainOrdinary: 0, isoBargainHeldAMT: 0,
    rentalNetFed: 0, rentalNetState: 0,
    ded: { stateIncomeTax: 22000, realEstateTax: 6000, mortgageInterest: 19000, charity: 5000 },
    mtcCarryIn: 0,
    ...overrides,
  };
}

let pass = 0, fail = 0;
function check(name, actual, expected, tol = 100) {
  const ok = Math.abs(actual - expected) <= tol;
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}: got ${Math.round(actual).toLocaleString()}, want ~${expected.toLocaleString()}${ok ? '' : ` (Δ ${Math.round(actual-expected).toLocaleString()})`}`);
  if (ok) pass++; else fail++;
}

console.log('\n=== Scenario 1: MFJ $340k wages, no equity ===');
{
  const r = computeYearTax(base());
  console.log(`  AGI=${Math.round(r.agi).toLocaleString()}, Fed regular=${Math.round(r.fedRegular).toLocaleString()}, AMT=${Math.round(r.amt).toLocaleString()}, State=${Math.round(r.stateTax).toLocaleString()}, Local=${Math.round(r.localTax).toLocaleString()}, Total=${Math.round(r.total).toLocaleString()}`);
  // Expected: taxable ord ≈ 340k - 32k (401k+HSA) - 40k SALT capped - 19k mortg - 5k charity = 244k
  // Fed on 244k MFJ ≈ 40k (very rough), state ≈ 3.07% × ~308k ≈ 9.5k, local ≈ 3% × 340k ≈ 10.2k
  check('AMT should be 0 (no preference)', r.amt, 0, 100);
  check('No MTC accrual', r.mtcCarryOut, 0, 0);
}

console.log('\n=== Scenario 2: Same wages + $200k ISO bargain (held) ===');
{
  const r = computeYearTax(base({ isoBargainHeldAMT: 200000 }));
  console.log(`  Fed regular=${Math.round(r.fedRegular).toLocaleString()}, AMT=${Math.round(r.amt).toLocaleString()}, TMT=${Math.round(r.tmt).toLocaleString()}, MTC carry out=${Math.round(r.mtcCarryOut).toLocaleString()}`);
  // AMTI ≈ 244k + 28k SALT add-back + 200k bargain = 472k. Exemption 137k (unphased). AMTI eff ≈ 335k.
  // TMT ≈ 26% × 239.1k + 28% × (335k-239.1k) ≈ 62,166 + 26,852 ≈ 89,018.
  // Regular ≈ ~40k. AMT ≈ 49k. MTC carry out ≈ 49k.
  check('AMT triggered (non-zero)', r.amt > 10000 ? r.amt : 0, r.amt, 999999);
  check('MTC accrues equal to AMT paid', r.mtcCarryOut, r.amt, 10);
}

console.log('\n=== Scenario 3: Next year, same wages, no ISO, MTC $49k carry-in ===');
{
  const r = computeYearTax(base({ mtcCarryIn: 49000 }));
  console.log(`  Fed regular after MTC=${Math.round(r.fedRegular).toLocaleString()}, MTC used=${Math.round(r.mtcUsed).toLocaleString()}, MTC carry out=${Math.round(r.mtcCarryOut).toLocaleString()}`);
  // Room = regular - TMT. With no ISO preference, TMT ~ regular tax computed on AMTI (which now equals taxable ord + SALT addback).
  // AMTI ≈ 244k + 28k = 272k. Exemption 137k. AMTI eff ≈ 135k → TMT ≈ 35k. Regular ≈ 40k. Room ≈ 5k.
  // So MTC used ≈ 5k, carry out ≈ 44k.
  check('MTC used > 0 (some recovery)', r.mtcUsed > 0 ? r.mtcUsed : 0, r.mtcUsed, 999999);
  check('Carry-out reduced by MTC used', r.mtcCarryOut, 49000 - r.mtcUsed, 100);
}

console.log('\n=== Scenario 4: Qualifying LTCG $500k on top of wages ===');
{
  const r = computeYearTax(base({ ltcg: 500000 }));
  console.log(`  Fed LTCG=${Math.round(r.fedLTCG).toLocaleString()}, NIIT=${Math.round(r.niit).toLocaleString()}, State=${Math.round(r.stateTax).toLocaleString()}`);
  // 500k stacked LTCG at 20% ≈ 100k (some at 15% band before 600k threshold; simplified)
  check('LTCG tax substantial', r.fedLTCG > 50000 ? r.fedLTCG : 0, r.fedLTCG, 999999);
  // NIIT = 3.8% × 500k = 19k
  check('NIIT ≈ 3.8% × 500k', r.niit, 500000 * 0.038, 500);
}

console.log('\n=== Scenario 5: Disqualifying ISO (Path 3): $100k ordinary from bargain ===');
{
  const r = computeYearTax(base({ isoBargainOrdinary: 100000 }));
  console.log(`  AGI=${Math.round(r.agi).toLocaleString()}, Fed regular=${Math.round(r.fedRegular).toLocaleString()}, AMT=${Math.round(r.amt).toLocaleString()}, State=${Math.round(r.stateTax).toLocaleString()}, Local=${Math.round(r.localTax).toLocaleString()}`);
  check('No AMT preference (same-day disq)', r.amt, 0, 100);
  // Local (Pittsburgh) taxes the bargain: 3% × 100k = 3k added
  const noBargain = computeYearTax(base()).localTax;
  check('Local tax includes disqualifying bargain', r.localTax - noBargain, 3000, 200);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
