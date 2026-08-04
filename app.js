/* ============================================================
   Multi-Year Tax Optimizer
   Step 1: state, navigation, base tax engine, rentals CRUD,
   grants CRUD, E*TRADE import, expenses.
   Strategy simulator + optimizer + charts land in step 2.
============================================================ */

/* ---------- Tax constants (2025 published; OBBBA-aware) ---------- */
const DEFAULT_CONSTANTS = {
  stdDed: { mfj: 31500, single: 15750, mfs: 15750, hoh: 23625 },
  brackets: {
    mfj:    [[23850,0.10],[96950,0.12],[206700,0.22],[394600,0.24],[501050,0.32],[751600,0.35],[Infinity,0.37]],
    single: [[11925,0.10],[48475,0.12],[103350,0.22],[197300,0.24],[250525,0.32],[626350,0.35],[Infinity,0.37]],
    mfs:    [[11925,0.10],[48475,0.12],[103350,0.22],[197300,0.24],[250525,0.32],[375800,0.35],[Infinity,0.37]],
    hoh:    [[17000,0.10],[64850,0.12],[103350,0.22],[197300,0.24],[250500,0.32],[626350,0.35],[Infinity,0.37]],
  },
  ltcg: {
    mfj:    [[96700,0],[600050,0.15],[Infinity,0.20]],
    single: [[48350,0],[533400,0.15],[Infinity,0.20]],
    mfs:    [[48350,0],[300000,0.15],[Infinity,0.20]],
    hoh:    [[64750,0],[566700,0.15],[Infinity,0.20]],
  },
  amt: {
    exemptionMFJ: 137000, exemptionSingle: 88100, exemptionMFS: 68500, exemptionHOH: 88100,
    phaseoutMFJ: 1252700, phaseoutSingle: 626350, phaseoutMFS: 626350, phaseoutHOH: 626350,
    breakpoint: 239100,
    rateLow: 0.26, rateHigh: 0.28,
  },
  saltCapMFJ: 40000, saltCapSingle: 40000, saltCapMFS: 20000, saltCapHOH: 40000,
  niitRate: 0.038, niitMFJ: 250000, niitSingle: 200000, niitMFS: 125000, niitHOH: 200000,
  addlMedRate: 0.009, addlMedMFJ: 250000, addlMedSingle: 200000, addlMedMFS: 125000, addlMedHOH: 200000,
  ctcPerChild: 2200, ctcOtherDep: 500,
  ctcPhaseoutMFJ: 400000, ctcPhaseoutOther: 200000,
  stateRates: { PA: 0.0307, OH: 0.035, NY: 0.0685, CA: 0.093, TX: 0, FL: 0, CUSTOM: 0 },
};

/* ---------- Default state ---------- */
const DEFAULT_STATE = {
  profile: {
    startYear: 2026, horizonYears: 10,
    filingStatus: 'mfj',
    dependentsCTC: 1, dependentsODC: 0,
    state: 'PA', customStateRate: 3.07, localRate: 3.0,
    cashOnHand: 50000, minCash: 25000,
    livingExpenses: 150000, expenseInflation: 3.0,
  },
  income: {
    wages: 340000, spouseWages: 0, bonus: 0, wageGrowth: 3.0,
    pretax401k: 23500, hsa: 8550,
    interestOrdDiv: 1200, qualDiv: 0,
  },
  ded: {
    stateIncomeTax: 22000, realEstateTax: 6000,
    mortgageInterest: 19000, charity: 5000,
  },
  rental: {
    properties: [],
    palCarryFed: 0, palCarryState: 0,
  },
  equity: {
    ticker: 'AUR', currentFMV: 7.24, fmvGrowth: 8.0, sharesHeld: 0,
    grants: [],
  },
  expenses: [], // { id, date: 'YYYY-MM-DD', label, amount }
  strategy: {
    scenario: 'base',
    maxAMT: 0,
    wealthIncludesEquity: 'true',
    isoExercisePct: 0,     // % of vested ISO shares to exercise each year
    isoHoldPct: 100,       // of exercised, % held (rest same-day-sold)
    rsuSellPct: 40,        // % of RSU vests sold same-day (rest kept)
    heldSellPct: 0,        // % of long-held shares sold each year
    isoPriority: 'expiring',
    stc: 'strike',
    forceExpireMonths: 12, // force exercise if <N months to exp
    fundFromRSU: 'true',
  },
  stress: {
    shockPct: 50,
    shockYear: 1,
    postShockGrowth: 3.0,
    wageRecessionYears: 0,
  },
  K: structuredClone(DEFAULT_CONSTANTS),
};

/* ---------- Utilities ---------- */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2, 9);
const fmt$ = n => (n == null || isNaN(n)) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
const fmtN = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
const fmtPct = n => (n == null || isNaN(n)) ? '—' : (n * 100).toFixed(1) + '%';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function deepGet(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function deepSet(obj, path, val) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = val;
}
function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
      target[k] = deepMerge(target[k] ?? {}, source[k]);
    } else {
      target[k] = source[k];
    }
  }
  return target;
}

/* ---------- Persistence ---------- */
const STORAGE_KEY = 'tax-optimizer-v1';
let S = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return deepMerge(structuredClone(DEFAULT_STATE), parsed);
  } catch { return structuredClone(DEFAULT_STATE); }
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch {}
}
function setStatus(msg, ms=1200) {
  const el = $('#status'); if (!el) return;
  el.textContent = msg;
  if (ms) setTimeout(() => { if (el.textContent === msg) el.textContent = 'Ready.'; }, ms);
}

/* ---------- Tax engine ---------- */
function applyBrackets(income, brackets) {
  let tax = 0, lastCut = 0;
  for (const [cut, rate] of brackets) {
    if (income <= lastCut) break;
    const chunk = Math.min(income, cut) - lastCut;
    tax += chunk * rate;
    lastCut = cut;
    if (income <= cut) break;
  }
  return tax;
}
function ordinaryTax(taxableOrd, status, K) { return applyBrackets(taxableOrd, K.brackets[status]); }
function ltcgTax(taxableOrd, ltcg, status, K) {
  // stack LTCG on top of ordinary
  const stacked = taxableOrd + Math.max(0, ltcg);
  const brackets = K.ltcg[status];
  let tax = 0, lastCut = Math.min(taxableOrd, brackets[brackets.length-1][0]);
  for (const [cut, rate] of brackets) {
    if (stacked <= lastCut) break;
    if (cut <= taxableOrd) continue;
    const chunk = Math.min(stacked, cut) - Math.max(lastCut, taxableOrd);
    if (chunk > 0) tax += chunk * rate;
    lastCut = cut;
    if (stacked <= cut) break;
  }
  return tax;
}

/**
 * Simplified federal + AMT + state + local + payroll tax computation.
 * @param {object} y annual snapshot: { wages, isoBargain, rsuOrdinary, stcg, ltcg, interestOrdDiv, qualDiv, rentalNetFed, rentalNetState, pretax401k, hsa, ded:{...}, filingStatus, dependentsCTC, dependentsODC, K, state, customStateRate, localRate, mtcCarryforward }
 * @returns {object} breakdown
 */
function computeYearTax(y) {
  const K = y.K;
  const status = y.filingStatus;
  const stdDed = K.stdDed[status];
  const saltCap = ({mfj: K.saltCapMFJ, single: K.saltCapSingle, mfs: K.saltCapMFS, hoh: K.saltCapHOH})[status];

  // Wages / earned income
  const wagesGross = (y.wages || 0) + (y.spouseWages || 0) + (y.bonus || 0);
  const wagesAfterPretax = Math.max(0, wagesGross - (y.pretax401k || 0) - (y.hsa || 0));

  // Ordinary income (before deductions)
  const ordinary =
    wagesAfterPretax +
    (y.rsuOrdinary || 0) +          // RSU vests + disqualifying-disposition ISO
    (y.isoBargainOrdinary || 0) +   // ISOs that became disqualifying same-day sells
    (y.interestOrdDiv || 0) +
    (y.stcg || 0) +
    (y.rentalNetFed || 0);          // can be negative

  // Itemized deduction pool
  const saltRaw = (y.ded.stateIncomeTax || 0) + (y.ded.realEstateTax || 0);
  const salt = Math.min(saltCap, saltRaw);
  const itemized = salt + (y.ded.mortgageInterest || 0) + (y.ded.charity || 0);
  const deduction = Math.max(stdDed, itemized);

  const taxableOrd = Math.max(0, ordinary - deduction);

  // Federal ordinary + LTCG (LTCG stacked, incl qual div)
  const ltcgAmt = (y.ltcg || 0) + (y.qualDiv || 0);
  const fedOrdTax = ordinaryTax(taxableOrd, status, K);
  const fedLTCG = ltcgTax(taxableOrd, ltcgAmt, status, K);

  // CTC (very simplified — full amount, phase out above threshold)
  const agi = ordinary + Math.max(0, ltcgAmt);
  const ctcPhaseoutStart = status === 'mfj' ? K.ctcPhaseoutMFJ : K.ctcPhaseoutOther;
  const ctcFull = (y.dependentsCTC || 0) * K.ctcPerChild + (y.dependentsODC || 0) * K.ctcOtherDep;
  const ctcReduction = Math.max(0, Math.ceil((agi - ctcPhaseoutStart) / 1000) * 50);
  const ctc = Math.max(0, ctcFull - ctcReduction);

  const fedRegular = Math.max(0, fedOrdTax + fedLTCG - ctc);

  /* ---- AMT ---- */
  // AMTI = taxable ordinary + itemized SALT add-back (bargain element is included in AMT-only income) + AMT-only bargain
  const amtBargain = (y.isoBargainHeldAMT || 0);
  const amti = taxableOrd + salt + amtBargain + Math.max(0, ltcgAmt); // LTCG still taxed at cap rate in AMT
  const exempt = ({mfj: K.amt.exemptionMFJ, single: K.amt.exemptionSingle,
                   mfs: K.amt.exemptionMFS, hoh: K.amt.exemptionHOH})[status];
  const phaseoutStart = ({mfj: K.amt.phaseoutMFJ, single: K.amt.phaseoutSingle,
                          mfs: K.amt.phaseoutMFS, hoh: K.amt.phaseoutHOH})[status];
  const phaseout = Math.max(0, (amti - phaseoutStart) * 0.25);
  const amtiEffective = Math.max(0, amti - Math.max(0, exempt - phaseout));
  const amtOnOrd = Math.max(0, amtiEffective - Math.max(0, ltcgAmt));
  const amtOrdTax = (amtOnOrd <= K.amt.breakpoint)
      ? amtOnOrd * K.amt.rateLow
      : K.amt.breakpoint * K.amt.rateLow + (amtOnOrd - K.amt.breakpoint) * K.amt.rateHigh;
  const amtLTCG = ltcgTax(amtOnOrd, ltcgAmt, status, K);
  const tmt = amtOrdTax + amtLTCG;
  const amt = Math.max(0, tmt - (fedOrdTax + fedLTCG));

  /* ---- NIIT / additional Medicare ---- */
  const niitThresh = ({mfj: K.niitMFJ, single: K.niitSingle, mfs: K.niitMFS, hoh: K.niitHOH})[status];
  const investIncome = (y.interestOrdDiv || 0) + ltcgAmt + (y.stcg || 0) + Math.max(0, y.rentalNetFed || 0);
  const niit = Math.max(0, Math.min(investIncome, agi - niitThresh)) * K.niitRate;

  const addlMedThresh = ({mfj: K.addlMedMFJ, single: K.addlMedSingle, mfs: K.addlMedMFS, hoh: K.addlMedHOH})[status];
  const addlMed = Math.max(0, wagesGross - addlMedThresh) * K.addlMedRate;

  /* ---- State + Local ---- */
  const stateRate = y.state === 'CUSTOM' ? (y.customStateRate || 0) / 100 : (K.stateRates[y.state] || 0);
  const stateBase =
    wagesGross - (y.pretax401k || 0) * 0    // PA taxes 401(k) contributions; keep simple: no shelter
    + (y.rsuOrdinary || 0) + (y.isoBargainOrdinary || 0)
    + (y.interestOrdDiv || 0) + (y.stcg || 0) + (y.ltcg || 0) + (y.qualDiv || 0)
    + (y.rentalNetState || 0);
  const stateTax = Math.max(0, stateBase) * stateRate;

  const localRate = (y.localRate || 0) / 100;
  const localBase = wagesGross + (y.rsuOrdinary || 0) + (y.isoBargainOrdinary || 0);
  const localTax = Math.max(0, localBase) * localRate;

  const totalFed = fedRegular + amt + niit + addlMed;
  const total = totalFed + stateTax + localTax;

  return {
    ordinary, deduction, itemized, salt, saltRaw,
    taxableOrd, agi,
    fedOrdTax, fedLTCG, ctc, fedRegular,
    amti, amtiEffective, tmt, amt,
    niit, addlMed,
    stateTax, localTax,
    totalFed, total,
  };
}

/* ---------- Rendering: navigation ---------- */
function setupNav() {
  $$('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const page = el.dataset.page;
      $$('.nav-item').forEach(n => n.classList.toggle('active', n === el));
      $$('.page').forEach(p => p.classList.toggle('active', p.dataset.page === page));
    });
  });
}

/* ---------- Rendering: data-bind ---------- */
function bindInputs(root=document) {
  $$('[data-bind]', root).forEach(el => {
    const path = el.dataset.bind;
    const v = deepGet(S, path);
    if (v !== undefined && v !== null) el.value = v;
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('input', () => {
      let val = el.value;
      if (el.type === 'number') val = val === '' ? 0 : parseFloat(val);
      deepSet(S, path, val);
      saveState();
      renderDerived();
    });
  });
}

/* ---------- Rentals CRUD ---------- */
function renderRentals() {
  const tbody = $('#rentals-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const props = S.rental.properties;
  props.forEach((p, idx) => {
    const net = (p.rent||0) - (p.mortgageInt||0) - (p.taxes||0) - (p.insurance||0) - (p.otherExp||0) - (p.deprFed||0);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${p.label||''}" data-k="label"></td>
      <td class="num"><input type="number" value="${p.rent||0}" data-k="rent"></td>
      <td class="num"><input type="number" value="${p.mortgageInt||0}" data-k="mortgageInt"></td>
      <td class="num"><input type="number" value="${p.taxes||0}" data-k="taxes"></td>
      <td class="num"><input type="number" value="${p.insurance||0}" data-k="insurance"></td>
      <td class="num"><input type="number" value="${p.otherExp||0}" data-k="otherExp"></td>
      <td class="num"><input type="number" value="${p.deprFed||0}" data-k="deprFed"></td>
      <td class="num mono ${net<0?'muted':''}">${fmt$(net)}</td>
      <td><button class="link danger" data-del="${idx}">×</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', () => {
      const tr = input.closest('tr');
      const idx = Array.from(tbody.children).indexOf(tr);
      const k = input.dataset.k;
      let v = input.value;
      if (input.type === 'number') v = v === '' ? 0 : parseFloat(v);
      S.rental.properties[idx][k] = v;
      saveState();
      renderRentals();
      renderDerived();
    });
  });
  tbody.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.rental.properties.splice(+btn.dataset.del, 1);
      saveState(); renderRentals(); renderDerived();
    });
  });
  const totalRent = props.reduce((s,p) => s + (p.rent||0), 0);
  const totalNet  = props.reduce((s,p) => s + rentalNet(p), 0);
  $('[data-total="rent"]').textContent = fmt$(totalRent);
  $('[data-total="net"]').textContent  = fmt$(totalNet);
}
function rentalNet(p) {
  return (p.rent||0) - (p.mortgageInt||0) - (p.taxes||0) - (p.insurance||0) - (p.otherExp||0) - (p.deprFed||0);
}
function totalRentalNet() {
  return S.rental.properties.reduce((s,p) => s + rentalNet(p), 0);
}
function addRental() {
  S.rental.properties.push({
    id: uid(), label: 'Property ' + (S.rental.properties.length + 1),
    rent: 0, mortgageInt: 0, taxes: 0, insurance: 0, otherExp: 0, deprFed: 0,
  });
  saveState(); renderRentals(); renderDerived();
}

/* ---------- Grants CRUD (card-per-grant editor) ---------- */
function renderGrants() {
  const wrap = $('#grants-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  S.equity.grants.forEach((g, idx) => {
    const card = document.createElement('div');
    card.className = 'grant-card';
    const sched = Array.isArray(g.vestSchedule) ? g.vestSchedule : [];
    const schedSummary = sched.length
      ? `<div class="grant-sched">Imported schedule: <b>${sched.length}</b> vests, ${fmtN(sched.reduce((s,v)=>s+v.shares,0))} shares, ${sched[0].date} → ${sched[sched.length-1].date}</div>`
      : `<div class="grant-sched muted">Synthesized: ${g.cadence} for ${g.vestMonths||0}mo${g.cliffMonths?` (${g.cliffMonths}mo cliff)`:''} from ${g.vestStart||'?'}</div>`;
    card.innerHTML = `
      <button class="link danger del" data-del="${idx}" title="Delete grant">×</button>
      <div class="grant-head">
        <select class="type" data-k="type">
          <option value="ISO"${g.type==='ISO'?' selected':''}>ISO</option>
          <option value="RSU"${g.type==='RSU'?' selected':''}>RSU</option>
          <option value="NSO"${g.type==='NSO'?' selected':''}>NSO</option>
        </select>
        <input class="label" type="text" value="${escapeHtml(g.label||'')}" data-k="label" placeholder="Grant label">
        <span class="pill ${(g.type||'').toLowerCase()}">${g.type||''}</span>
      </div>
      ${schedSummary}
      <div class="grant-grid">
        <div class="field"><label>Grant date</label>
          <input type="date" value="${g.grantDate||''}" data-k="grantDate"></div>
        <div class="field"><label>Expiration</label>
          <input type="date" value="${g.expDate||''}" data-k="expDate"></div>

        <div class="field"><label>Shares granted</label>
          <input type="number" value="${g.shares||0}" data-k="shares" step="1"></div>
        <div class="field"><label>Strike ($/share)</label>
          <input type="number" value="${g.strike||0}" data-k="strike" step="0.01"></div>

        <div class="field"><label>FMV @ grant ($/share)</label>
          <input type="number" value="${g.fmvAtGrant||0}" data-k="fmvAtGrant" step="0.01"></div>
        <div class="field"><label>Vested now (shares)</label>
          <input type="number" value="${g.exercisableNow||0}" data-k="exercisableNow" step="1"></div>

        <div class="field"><label>Vest start ${sched.length?'<span class="muted">(from schedule)</span>':''}</label>
          <input type="date" value="${g.vestStart||''}" data-k="vestStart" ${sched.length?'disabled':''}></div>
        <div class="field"><label>Cadence ${sched.length?'<span class="muted">(from schedule)</span>':''}</label>
          <select data-k="cadence" ${sched.length?'disabled':''}>
            <option value="monthly"${g.cadence==='monthly'?' selected':''}>Monthly</option>
            <option value="quarterly"${g.cadence==='quarterly'?' selected':''}>Quarterly</option>
            <option value="annual"${g.cadence==='annual'?' selected':''}>Annual</option>
            <option value="cliff"${g.cadence==='cliff'?' selected':''}>Single cliff</option>
          </select></div>

        <div class="field"><label>Vest period (months) ${sched.length?'<span class="muted">(from schedule)</span>':''}</label>
          <input type="number" value="${g.vestMonths||0}" data-k="vestMonths" step="1" ${sched.length?'disabled':''}></div>
        <div class="field"><label>Cliff (months) ${sched.length?'<span class="muted">(from schedule)</span>':''}</label>
          <input type="number" value="${g.cliffMonths||0}" data-k="cliffMonths" step="1" ${sched.length?'disabled':''}></div>
      </div>
    `;
    wrap.appendChild(card);
  });
  wrap.querySelectorAll('input,select').forEach(el => {
    el.addEventListener('input', () => {
      const card = el.closest('.grant-card');
      const idx = Array.from(wrap.children).indexOf(card);
      const k = el.dataset.k;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? 0 : parseFloat(v);
      S.equity.grants[idx][k] = v;
      saveState();
      renderVestCalendar();
      // If type changed, refresh pill color
      if (k === 'type') renderGrants();
    });
  });
  wrap.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.equity.grants.splice(+btn.dataset.del, 1);
      saveState(); renderGrants(); renderVestCalendar();
    });
  });
  const count = $('#grant-count');
  if (count) count.textContent = S.equity.grants.length ? `${S.equity.grants.length} grants` : '';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function addGrant() {
  const today = new Date().toISOString().slice(0,10);
  S.equity.grants.push({
    id: uid(), type: 'RSU', label: 'New grant', grantDate: today,
    shares: 0, strike: 0, fmvAtGrant: S.equity.currentFMV,
    vestStart: today, cadence: 'quarterly', vestMonths: 48, cliffMonths: 12,
    exercisableNow: 0, expDate: '',
  });
  saveState(); renderGrants(); renderVestCalendar();
}

/* ---------- Vest schedule expansion ---------- */
function expandVests(g) {
  // Prefer explicit vestSchedule if present (from multi-row Benefit History import)
  if (Array.isArray(g.vestSchedule) && g.vestSchedule.length) {
    return g.vestSchedule
      .filter(v => v && v.date && v.shares > 0)
      .map(v => ({ date: v.date, shares: +v.shares }))
      .sort((a,b) => a.date.localeCompare(b.date));
  }
  // Otherwise synthesize from cadence + months + cliff
  if (!g.vestStart || !g.shares) return [];
  const start = new Date(g.vestStart + 'T00:00:00');
  if (isNaN(+start)) return [];
  const events = [];
  if (g.cadence === 'cliff') {
    return [{ date: g.vestStart, shares: g.shares }];
  }
  const stepMonths = g.cadence === 'quarterly' ? 3 : g.cadence === 'annual' ? 12 : 1;
  const totalMonths = Math.max(g.vestMonths || 0, g.cliffMonths || 0);
  if (totalMonths <= 0) return [{ date: g.vestStart, shares: g.shares }];
  const cliff = g.cliffMonths || 0;
  const remainingMonths = totalMonths - cliff;
  const numSteps = Math.max(1, Math.floor(remainingMonths / stepMonths));
  const cliffFrac = cliff > 0 ? (cliff / totalMonths) : 0;
  const cliffShares = Math.round(g.shares * cliffFrac);
  const remShares = g.shares - cliffShares;
  const perStep = Math.floor(remShares / numSteps);
  const remainder = remShares - perStep * numSteps;
  if (cliff > 0) {
    const d = new Date(start); d.setMonth(d.getMonth() + cliff);
    events.push({ date: d.toISOString().slice(0,10), shares: cliffShares });
  }
  for (let i = 0; i < numSteps; i++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + cliff + (i+1) * stepMonths);
    events.push({ date: d.toISOString().slice(0,10), shares: perStep + (i === numSteps - 1 ? remainder : 0) });
  }
  return events;
}

function renderVestCalendar() {
  const tbody = $('#vest-calendar tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const today = new Date().toISOString().slice(0,10);
  const events = [];
  S.equity.grants.forEach(g => {
    expandVests(g).forEach(v => {
      if (v.date < today) return;
      const year = +v.date.slice(0,4);
      const yearsOut = year - S.profile.startYear;
      const fmv = S.equity.currentFMV * Math.pow(1 + (S.equity.fmvGrowth||0)/100, Math.max(0, yearsOut));
      events.push({ ...v, grant: g, fmv });
    });
  });
  events.sort((a,b) => a.date.localeCompare(b.date));
  events.slice(0, 200).forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.date}</td>
      <td>${e.grant.label} <span class="pill ${e.grant.type.toLowerCase()}">${e.grant.type}</span></td>
      <td>${e.grant.type}</td>
      <td class="num">${fmtN(e.shares)}</td>
      <td class="num">$${e.fmv.toFixed(2)}</td>
      <td class="num">${fmt$(e.shares * e.fmv)}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ---------- E*TRADE import ---------- */
/**
 * Auto-detect delimiter (comma / tab / semicolon / pipe) by counting
 * occurrences on the first few non-empty lines. Strips BOM.
 */
function detectDelimiter(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
  const candidates = [',', '\t', ';', '|'];
  const counts = candidates.map(d => {
    // Count occurrences per line, take median-ish
    const perLine = lines.map(l => (l.match(new RegExp('\\' + d, 'g')) || []).length);
    perLine.sort((a,b) => a-b);
    return perLine[Math.floor(perLine.length/2)] || 0;
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
        if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
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

/**
 * Parse one E*TRADE CSV. Handles Stock Options, Restricted Stock, and
 * Benefit-History-Expanded layouts. Returns { grants: [...], diag: {...} }.
 *
 * Strategy: locate the header row, then use *prioritized* column matchers
 * (exact match preferred, then keyword) so we never confuse "Grant Price"
 * (per-share strike) with "Grant Value" (total-dollar), or "Grant Date" with
 * "Vest Date".
 */
function importETradeOne(text, filename) {
  const rows = parseCSV(text);
  const delim = rows._delim || ',';
  const delimName = delim === '\t' ? 'TAB' : delim === ',' ? 'comma' : delim === ';' ? 'semicolon' : delim === '|' ? 'pipe' : delim;
  const diag = { filename, headerRow: -1, kind: 'unknown', columns: {}, warn: [], grants: 0,
                 headerCells: [], sampleRow: [], delimiter: delimName };
  if (!rows.length) return { grants: [], diag: { ...diag, err: 'Empty file' } };

  // Find the header row (one that contains "Grant Number" or "Grant Date")
  let headerIdx = -1, headerRaw = null;
  for (let i = 0; i < Math.min(80, rows.length); i++) {
    const r = rows[i].map(c => (c||'').trim());
    const lower = r.map(c => c.toLowerCase());
    if ((lower.some(c => c === 'grant number' || c === 'grant #' || c.includes('grant number')))
        && (lower.some(c => c.includes('grant date') || c.includes('grant type') || c.includes('award type')))) {
      headerIdx = i; headerRaw = r; break;
    }
  }
  if (headerIdx < 0) {
    diag.headerCells = (rows[0] || []).slice(0, 20);
    return { grants: [], diag: { ...diag, err: 'No E*TRADE header row detected. Expected columns like "Grant Number", "Grant Date". First row above.' } };
  }
  const header = headerRaw.map(c => c.toLowerCase().trim());
  diag.headerRow = headerIdx + 1;
  diag.headerCells = headerRaw;

  // Column matchers — first exact-string match, then contains-any
  const findCol = (candidates) => {
    for (const cand of candidates) {
      const exact = header.findIndex(h => h === cand);
      if (exact >= 0) return exact;
    }
    for (const cand of candidates) {
      const partial = header.findIndex(h => h.includes(cand));
      if (partial >= 0) return partial;
    }
    return -1;
  };

  const cNumber   = findCol(['grant number', 'grant #', 'grant id']);
  const cType     = findCol(['award type', 'grant type', 'plan type', 'type']);
  const cGrantDt  = findCol(['grant date', 'award date']);
  const cShares   = findCol(['granted qty.', 'granted qty', 'total grant', 'total granted', 'granted', 'shares granted', 'grant quantity', 'total awarded']);
  const cStrike   = findCol(['exercise price', 'grant price', 'strike price', 'strike']);
  const cFMV      = (() => {
    const strict = header.findIndex(h =>
      h === 'grant date fmv' || h === 'fmv at grant' || h === 'fmv @ grant'
      || h === 'grant date fair market value' || h === 'fmv');
    if (strict >= 0) return strict;
    return header.findIndex(h => h.includes('fmv') && !h.includes('value') && !h.includes('total'));
  })();
  const cExp      = findCol(['expiration date', 'expiration', 'expire date']);
  const cVestSt   = findCol(['vest start', 'vest from', 'vesting start date']);
  const cVestMo   = findCol(['vest period', 'vesting term', 'vest term']);
  const cVestedNow= findCol(['exercisable qty.', 'exercisable qty', 'exercisable', 'sellable qty.', 'sellable qty', 'sellable', 'vested qty.', 'vested qty', 'vested']);
  const cVestDate = findCol(['vest date', 'vesting date']);
  // Per-vest quantity — E*TRADE uses "Vesting Qty." (Options) and "Qty. or Amount" (Restricted)
  const cVestQty  = (() => {
    // Prefer per-event quantity column names
    const candidates = ['vesting qty.', 'vesting qty', 'qty. or amount', 'qty or amount',
                        'quantity or amount', 'vest quantity', 'quantity vested',
                        'shares vested', 'vested shares'];
    for (const cand of candidates) {
      const idx = header.findIndex(h => h === cand);
      if (idx >= 0) return idx;
    }
    // If we have Vest Date, look for the closest "qty"/"quantity" column that
    // *isn't* the same as cVestedNow (which is the summary count).
    if (cVestDate >= 0) {
      let best = -1, bestDist = 999;
      header.forEach((h, i) => {
        if (i === cVestedNow) return;
        if (h === 'qty' || h === 'qty.' || h === 'quantity' || h === 'shares') {
          const d = Math.abs(i - cVestDate);
          if (d < bestDist) { best = i; bestDist = d; }
        }
      });
      return best;
    }
    return -1;
  })();
  const cRecType  = findCol(['record type']);

  diag.columns = { number: cNumber, type: cType, grantDate: cGrantDt, shares: cShares, strike: cStrike,
                   fmv: cFMV, expiration: cExp, vestStart: cVestSt, vestPeriod: cVestMo, vested: cVestedNow,
                   vestDate: cVestDate, vestQty: cVestQty, recordType: cRecType };

  if (cVestDate >= 0 && cVestQty >= 0) diag.kind = 'Benefit History (per-vest rows)';
  else if (cStrike >= 0 && cExp >= 0)  diag.kind = 'Stock Options';
  else if (cVestedNow >= 0 && cStrike < 0) diag.kind = 'Restricted Stock';
  else diag.kind = 'Generic';

  // Helper: read + normalize a cell if column is valid and non-empty
  const cell = (r, i) => (i >= 0 && r[i] != null) ? String(r[i]).trim() : '';

  const byNum = new Map();
  let lastNum = null; // for propagating grant number across "Vest" sub-rows

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;

    // Determine grant number — propagate from the last row if this row is a sub-row
    let num = cell(r, cNumber);
    if (!num) num = lastNum;
    if (!num) continue;

    if (!diag.sampleRow.length) diag.sampleRow = r.slice(0, headerRaw.length);

    let g = byNum.get(num);
    if (!g) {
      // Determine type — check any row for a value; default from strike presence
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
      };
      byNum.set(num, g);
    }
    lastNum = num;

    // Merge non-empty values from this row (first-wins per field)
    if (!g.grantDate)      g.grantDate  = normDate(cell(r, cGrantDt));
    if (!g.expDate)        g.expDate    = normDate(cell(r, cExp));
    if (!g.vestStart)      g.vestStart  = normDate(cell(r, cVestSt));
    if (!g.shares) {
      const s = numOrZero(cell(r, cShares));
      if (s > 0) g.shares = s;
    }
    if (!g.strike) {
      const s = numOrZero(cell(r, cStrike));
      if (s > 0) g.strike = s;
    }
    if (!g.fmvAtGrant) {
      const raw = numOrZero(cell(r, cFMV));
      const shares = g.shares || numOrZero(cell(r, cShares));
      // Reject "total value" masquerading as per-share FMV
      const clean = (raw > 0 && shares > 0 && g.strike > 0 && raw > g.strike * shares * 0.5) ? 0 : raw;
      if (clean !== raw) diag.warn.push(`grant ${num}: FMV column looked like a total; dropped.`);
      if (clean > 0) g.fmvAtGrant = clean;
    }
    if (!g.exercisableNow) {
      const v = numOrZero(cell(r, cVestedNow));
      if (v > 0) g.exercisableNow = v;
    }
    if (!g.vestMonths) {
      const v = numOrZero(cell(r, cVestMo));
      if (v > 0) g.vestMonths = v;
    }

    // Per-row vest event
    const vestDate = normDate(cell(r, cVestDate));
    const vestQty  = numOrZero(cell(r, cVestQty));
    if (vestDate && vestQty > 0) {
      g.vestSchedule.push({ date: vestDate, shares: vestQty });
    }
  }

  // Post-process: derive vestStart / cadence / months from the imported schedule
  byNum.forEach(g => {
    if (g.vestSchedule && g.vestSchedule.length) {
      // Dedupe: same date + same shares only once
      const seen = new Set();
      g.vestSchedule = g.vestSchedule.filter(v => {
        const k = v.date + '|' + v.shares;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      g.vestSchedule.sort((a,b) => a.date.localeCompare(b.date));
      const sum = g.vestSchedule.reduce((s,v) => s + v.shares, 0);
      if (!g.shares) g.shares = sum;
      g.vestStart = g.vestSchedule[0].date;
      if (g.vestSchedule.length > 1) {
        const first = new Date(g.vestSchedule[0].date + 'T00:00:00');
        const last  = new Date(g.vestSchedule[g.vestSchedule.length-1].date + 'T00:00:00');
        const gap = Math.round((last - first) / ((g.vestSchedule.length - 1) * 30.4375 * 86400e3));
        g.cadence = gap >= 10 ? 'annual' : gap >= 2 ? 'quarterly' : 'monthly';
        g.vestMonths = Math.round((last - first) / (30.4375 * 86400e3)) + gap;
      } else {
        g.cadence = 'cliff';
      }
    }
    // If we couldn't get FMV from CSV, fall back to strike (a common ISO reality)
    if (!g.fmvAtGrant && g.strike) g.fmvAtGrant = g.strike;
  });
  diag.grants = byNum.size;
  return { grants: [...byNum.values()], diag };
}

/**
 * Merge grants across multiple CSV imports (deduped by grant number, later
 * files fill missing fields). Existing grants with matching label are updated.
 */
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
function numOrZero(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
function normDate(v) {
  if (v == null || v === '') return '';
  let s = String(v).trim();
  if (!s) return '';
  // Strip trailing time component ("2020-07-15 00:00:00", "2020-07-15T00:00:00Z")
  s = s.replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?Z?$/, '');
  // mm/dd/yyyy or mm-dd-yyyy
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let mo = m[1], d = m[2], y = m[3];
    if (y.length === 2) y = (+y > 50 ? '19' : '20') + y;
    // If year came first (yyyy-mm-dd but matched as m[3]), fall through
    if (+mo > 12 && +y > 12) return '';
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // yyyy-mm-dd or yyyy/mm/dd
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  // yyyymmdd
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // "Aug 20, 2023" or "August 20 2023"
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mi = monthIndex(m[1]);
    if (mi >= 0) return `${m[3]}-${String(mi+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // "20-Aug-2023" / "20 Aug 2023" / "20-Aug-23"
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-](\d{2,4})$/);
  if (m) {
    const mi = monthIndex(m[2]);
    let y = m[3]; if (y.length === 2) y = (+y > 50 ? '19' : '20') + y;
    if (mi >= 0) return `${y}-${String(mi+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  // Last resort: Date.parse
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  return '';
}
function monthIndex(name) {
  return ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    .findIndex(x => name.toLowerCase().startsWith(x));
}

function setupETradeImport() {
  const input = $('#etrade-file');
  const status = $('#etrade-status');
  const diagEl = $('#etrade-diag');
  input?.addEventListener('change', () => {
    const files = input.files;
    if (!files || !files.length) return;
    status.textContent = `Reading ${files.length} file(s)…`;
    diagEl.innerHTML = '';
    importETradeMulti(files, (results) => {
      // Merge grants across files, deduped by "Grant #" embedded in the label
      const merged = new Map();
      // seed with existing (so we don't blow away edits)
      S.equity.grants.forEach(g => merged.set(g.label, g));
      let addedTotal = 0, updatedTotal = 0;
      const parts = [];
      results.forEach(r => {
        const line = document.createElement('div');
        line.className = 'file-row';
        if (r.diag.err) {
          const preview = r.diag.headerCells.length
            ? `<div class="small mono">First row: ${r.diag.headerCells.map(escapeHtml).join(' | ')}</div>` : '';
          line.innerHTML = `<span class="err">✗</span> <b>${escapeHtml(r.diag.filename)}</b>: ${escapeHtml(r.diag.err)}${preview}`;
        } else {
          let added = 0, updated = 0;
          r.grants.forEach(g => {
            const existing = merged.get(g.label);
            if (existing) {
              for (const k of Object.keys(g)) {
                if (k === 'id') continue;
                const v = g[k];
                if (v == null || v === '' || v === 0
                    || (Array.isArray(v) && !v.length)) continue;
                if (existing[k] == null || existing[k] === '' || existing[k] === 0
                    || (Array.isArray(existing[k]) && !existing[k].length)) existing[k] = v;
              }
              updated++;
            } else {
              merged.set(g.label, g);
              added++;
            }
          });
          addedTotal += added; updatedTotal += updated;
          const cols = r.diag.columns;
          const detected = Object.entries(cols)
            .map(([k, v]) => {
              const idx = v;
              const name = idx >= 0 ? r.diag.headerCells[idx] : '';
              return `<b>${k}</b>: ${idx >= 0 ? escapeHtml(name || '?') : '—'}`;
            }).join(' · ');
          const warns = r.diag.warn.length
              ? `<div class="warn">${r.diag.warn.map(escapeHtml).join('<br>')}</div>` : '';
          const headerPreview = `<div class="small mono">Header row ${r.diag.headerRow}: ${r.diag.headerCells.map(escapeHtml).join(' | ')}</div>`;
          const sample = r.diag.sampleRow.length
            ? `<div class="small mono">Sample row: ${r.diag.sampleRow.map(escapeHtml).join(' | ')}</div>` : '';
          line.innerHTML =
            `<span class="ok">✓</span> <b>${escapeHtml(r.diag.filename)}</b> — detected <i>${r.diag.kind}</i>. Delimiter: <b>${r.diag.delimiter}</b>. Grants: <b>${r.grants.length}</b> (added ${added}, updated ${updated}).`
            + `<div class="small">Mapping: ${detected}</div>${headerPreview}${sample}${warns}`;
        }
        diagEl.appendChild(line);
      });
      S.equity.grants = [...merged.values()];
      saveState(); renderGrants(); renderVestCalendar();
      status.textContent = `Done — ${addedTotal} new, ${updatedTotal} updated.`;
    });
  });
  $('#etrade-clear')?.addEventListener('click', () => {
    if (!confirm('Delete ALL grants?')) return;
    S.equity.grants = []; saveState(); renderGrants(); renderVestCalendar();
    status.textContent = 'Cleared.';
    diagEl.innerHTML = '';
  });
}

/* ---------- Expenses ---------- */
function renderExpenses() {
  const tbody = $('#expenses-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  S.expenses.forEach((e, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="date" value="${e.date||''}" data-k="date"></td>
      <td><input type="text" value="${e.label||''}" data-k="label"></td>
      <td class="num"><input type="number" value="${e.amount||0}" data-k="amount"></td>
      <td><button class="link danger" data-del="${idx}">×</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input').forEach(el => {
    el.addEventListener('input', () => {
      const tr = el.closest('tr');
      const idx = Array.from(tbody.children).indexOf(tr);
      let v = el.value;
      if (el.type === 'number') v = v === '' ? 0 : parseFloat(v);
      S.expenses[idx][el.dataset.k] = v;
      saveState();
    });
  });
  tbody.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.expenses.splice(+btn.dataset.del, 1);
      saveState(); renderExpenses();
    });
  });
}
function addExpense() {
  const today = new Date().toISOString().slice(0,10);
  S.expenses.push({ id: uid(), date: today, label: 'Expense', amount: 0 });
  saveState(); renderExpenses();
}

/* ---------- Constants tables ---------- */
function renderConstantsTables() {
  const status = S.profile.filingStatus;
  const fed = S.K.brackets[status];
  const fedTb = $('#fed-brackets tbody'); if (fedTb) {
    fedTb.innerHTML = fed.map(([cut, r]) => `<tr><td class="num">${isFinite(cut) ? fmt$(cut) : '∞'}</td><td class="num">${fmtPct(r)}</td></tr>`).join('');
  }
  const ltcg = S.K.ltcg[status];
  const ltcgTb = $('#ltcg-brackets tbody'); if (ltcgTb) {
    ltcgTb.innerHTML = ltcg.map(([cut, r]) => `<tr><td class="num">${isFinite(cut) ? fmt$(cut) : '∞'}</td><td class="num">${fmtPct(r)}</td></tr>`).join('');
  }
  const heading = $('#fed-brackets')?.closest('.panel')?.querySelector('h3');
  if (heading) heading.innerHTML = `Federal ordinary brackets (${status.toUpperCase()})`;
}

/* ---------- Base-year summary ---------- */
function computeBaseYear() {
  const rn = totalRentalNet();
  const y = {
    K: S.K, filingStatus: S.profile.filingStatus,
    state: S.profile.state, customStateRate: S.profile.customStateRate,
    localRate: S.profile.localRate,
    dependentsCTC: S.profile.dependentsCTC, dependentsODC: S.profile.dependentsODC,
    wages: S.income.wages, spouseWages: S.income.spouseWages, bonus: S.income.bonus,
    pretax401k: S.income.pretax401k, hsa: S.income.hsa,
    interestOrdDiv: S.income.interestOrdDiv, qualDiv: S.income.qualDiv,
    stcg: 0, ltcg: 0,
    rsuOrdinary: 0, isoBargainOrdinary: 0, isoBargainHeldAMT: 0,
    rentalNetFed: rn, rentalNetState: rn,
    ded: S.ded,
  };
  return computeYearTax(y);
}

function renderBaseSummary() {
  const el = $('#base-summary');
  if (!el) return;
  const r = computeBaseYear();
  const wages = (S.income.wages||0) + (S.income.spouseWages||0) + (S.income.bonus||0);
  const takehome = wages - r.total - (S.income.pretax401k||0) - (S.income.hsa||0);
  const effRate = wages > 0 ? r.total / wages : 0;
  el.innerHTML = `
    ${card('Gross wages + bonus', fmt$(wages))}
    ${card('AGI (est.)', fmt$(r.agi))}
    ${card('Deduction used', fmt$(r.deduction), r.deduction === S.K.stdDed[S.profile.filingStatus] ? 'standard' : 'itemized')}
    ${card('Fed regular', fmt$(r.fedRegular))}
    ${card('AMT (added)', fmt$(r.amt), r.amt > 0 ? 'preference exceeds regular' : 'none')}
    ${card('NIIT + Addl. Medicare', fmt$(r.niit + r.addlMed))}
    ${card('State ' + S.profile.state, fmt$(r.stateTax))}
    ${card('Local EIT', fmt$(r.localTax))}
    ${card('Total tax', fmt$(r.total), fmtPct(effRate) + ' effective', 'bad')}
    ${card('Est. take-home', fmt$(takehome), 'after all tax + 401k + HSA', 'good')}
  `;
}
function card(k, v, sub='', cls='') {
  return `<div class="summary-card">
    <div class="k">${k}</div>
    <div class="v ${cls}">${v}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

/* ---------- Import / Export / Reset ---------- */
function setupPersistence() {
  $('#btn-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `tax-optimizer-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#btn-import')?.addEventListener('click', () => $('#import-file').click());
  $('#import-file')?.addEventListener('change', () => {
    const file = $('#import-file').files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        S = deepMerge(structuredClone(DEFAULT_STATE), data);
        saveState(); renderAll(); setStatus('Imported.');
      } catch (e) { setStatus('Import failed: ' + e.message, 4000); }
    };
    r.readAsText(file);
  });
  $('#btn-reset')?.addEventListener('click', () => {
    if (!confirm('Reset all data to defaults? This clears your local storage.')) return;
    S = structuredClone(DEFAULT_STATE);
    saveState(); renderAll(); setStatus('Reset.');
  });
}

/* ---------- Render orchestration ---------- */
function renderDerived() {
  renderBaseSummary();
  renderConstantsTables();
}
function renderAll() {
  bindInputs();
  renderRentals();
  renderGrants();
  renderVestCalendar();
  renderExpenses();
  renderDerived();
}

/* ---------- Boot ---------- */
window.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupPersistence();
  setupETradeImport();
  $('#add-rental')?.addEventListener('click', addRental);
  $('#add-grant')?.addEventListener('click', addGrant);
  $('#add-expense')?.addEventListener('click', addExpense);
  $('#rebuild-schedule')?.addEventListener('click', renderVestCalendar);
  renderAll();
});
