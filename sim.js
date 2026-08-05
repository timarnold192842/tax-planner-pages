/* ================================================================
   Multi-year strategy simulator, optimizer, stress test, charts.
   Runs after app.js. Uses globals: S, DEFAULT_STATE, computeYearTax,
   expandVests, totalRentalNet, saveState, bindInputs, setStatus,
   card, deepGet, fmt$, fmtN, fmtPct, $, $$.
================================================================ */

let chartCash, chartWealth, chartPareto, chartStressCash, chartStressWealth;

/* ---------- FMV path ---------- */
function fmvPath(strategy, baseGrowth, horizonYears, shock) {
  const scenario = strategy?.scenario || 'base';
  let growth = (baseGrowth || 0) / 100;
  if (scenario === 'bull') growth = growth * 2;
  else if (scenario === 'bear') growth = -0.05;
  else if (scenario === 'flat') growth = 0;
  const years = [];
  let price = S.equity.currentFMV;
  for (let i = 0; i < horizonYears; i++) {
    let g = growth;
    if (shock && i === shock.year) {
      price = price * (1 - shock.pct / 100);
      g = (shock.postGrowth ?? 0) / 100;
    } else if (shock && i > shock.year) {
      g = (shock.postGrowth ?? 0) / 100;
    }
    years.push({ year: S.profile.startYear + i, fmv: price });
    price = price * (1 + g);
  }
  return years;
}

function grantSharesVestedBy(g, dateStr) {
  return expandVests(g).filter(e => e.date <= dateStr).reduce((s, e) => s + e.shares, 0);
}

function sortISOs(grants, priority) {
  const arr = grants.filter(g => g.type === 'ISO' || g.type === 'NSO');
  const key = g => {
    if (priority === 'expiring')       return g.expDate || '9999-12-31';
    if (priority === 'lowest-strike')  return g.strike;
    if (priority === 'highest-strike') return -g.strike;
    if (priority === 'oldest')         return g.grantDate || '';
    return g.grantDate || '';
  };
  return arr.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/* ---------- Simulator ---------- */
function simulate(strategy, options = {}) {
  const horizon = S.profile.horizonYears || 10;
  const startYear = S.profile.startYear;
  const wageGrowth = (S.income.wageGrowth || 0) / 100;
  const inflation = (S.profile.expenseInflation || 0) / 100;
  const path = fmvPath(strategy, S.equity.fmvGrowth || 0, horizon, options.shock);

  // Cost-basis lots. Each lot tracks the info needed to correctly determine
  // qualifying vs disqualifying disposition for ISO lots, and STCG vs LTCG
  // for RSU lots.
  //   kind: 'RSU' | 'ISO'
  //   shares: shares in the lot
  //   acquireDate: 'YYYY-MM-DD' — the exercise (ISO) or vest (RSU) date
  //   grantDate: 'YYYY-MM-DD' (ISO only) — for the 2-year ISO qualifying test
  //   strike: $/share (ISO only, 0 for RSU)
  //   fmvAtAcquire: $/share FMV at acquisition (basis for RSU cap-gain calc,
  //                 and used for the "ordinary chunk" on a disqualifying ISO sale)
  const lots = [];
  if (S.equity.sharesHeld > 0) {
    lots.push({
      kind: 'RSU',
      shares: S.equity.sharesHeld,
      acquireDate: `${startYear - 2}-01-01`,
      grantDate: '',
      strike: 0,
      fmvAtAcquire: S.equity.currentFMV * 0.5,
    });
  }

  const grants = structuredClone(S.equity.grants);
  grants.forEach(g => { g._remaining = g.shares; });

  let cash = S.profile.cashOnHand;
  let minCash = cash;
  let maxAMTyr = 0;
  let totalTax = 0;
  let mtcCarry = 0;                    // Minimum Tax Credit carryforward
  let totalISOSpreadRealized = 0;      // Σ (sale_price - strike) × shares across all ISO cash realizations
  let totalTaxOnISOSpread = 0;         // taxes attributable to ISO-derived income (rough attribution)

  const years = [];

  for (let yi = 0; yi < horizon; yi++) {
    const year = startYear + yi;
    const yEnd = `${year + 1}-01-01`;
    const yStart = `${year}-01-01`;
    const midYear = `${year}-06-30`;
    const fmv = path[yi].fmv;

    /* 1) RSU vests */
    let rsuOrdinary = 0;
    let rsuCashProceeds = 0;
    let rsuLTCG = 0, rsuSTCG = 0;
    // Extra ordinary income from disqualifying ISO dispositions (Path 3)
    let isoDisqualifyingOrdinary = 0;
    grants.filter(g => g.type === 'RSU').forEach(g => {
      const vests = expandVests(g).filter(e => e.date >= yStart && e.date < yEnd);
      const totalVest = vests.reduce((s, e) => s + e.shares, 0);
      if (!totalVest) return;
      rsuOrdinary += totalVest * fmv;
      const sellShares = Math.round(totalVest * (strategy.rsuSellPct / 100));
      const keepShares = totalVest - sellShares;
      rsuCashProceeds += sellShares * fmv;
      if (keepShares > 0) {
        lots.push({
          kind: 'RSU',
          shares: keepShares,
          acquireDate: midYear,
          grantDate: g.grantDate || '',
          strike: 0,
          fmvAtAcquire: fmv,
        });
      }
    });

    /* 2) Wages (with optional recession) */
    let wageScale = 1;
    if (options.shock && options.shock.wageRecessionYears
        && yi > options.shock.year && yi <= options.shock.year + options.shock.wageRecessionYears) {
      wageScale = 0.7;
    }
    const wages = (S.income.wages + S.income.spouseWages + S.income.bonus)
                  * Math.pow(1 + wageGrowth, yi) * wageScale;

    /* 3) ISO exercises */
    let isoExercisedShares = 0;
    let isoBargainHeldAMT = 0;
    let isoBargainOrdinary = 0;     // same-day-sell (Path 1) bargain
    let isoStrikeOutlay = 0;
    let isoSTCProceeds = 0;

    const isoGrants = sortISOs(grants, strategy.isoPriority);
    isoGrants.forEach(g => {
      const vestedByEnd = Math.min(grantSharesVestedBy(g, yEnd), g._remaining);
      let takeThisYear = Math.floor(vestedByEnd * (strategy.isoExercisePct / 100));
      if (g.expDate && strategy.forceExpireMonths > 0) {
        const expY = +g.expDate.slice(0, 4);
        const expM = +g.expDate.slice(5, 7) || 12;
        const monthsToExp = (expY - year) * 12 + (expM - 12);
        if (monthsToExp <= strategy.forceExpireMonths) takeThisYear = vestedByEnd;
      }
      g._takeThisYear = takeThisYear;
    });

    const maxAMT = strategy.maxAMT || 0;
    let shrinkFactor = 1;
    if (maxAMT > 0) {
      let bargain = 0;
      isoGrants.forEach(g => {
        bargain += (g._takeThisYear || 0) * (strategy.isoHoldPct / 100) * Math.max(0, fmv - g.strike);
      });
      const est = bargain * 0.28;
      if (est > maxAMT && bargain > 0) shrinkFactor = maxAMT / est;
    }

    isoGrants.forEach(g => {
      const take = Math.floor((g._takeThisYear || 0) * shrinkFactor);
      if (take <= 0) return;
      isoExercisedShares += take;
      g._remaining -= take;
      const heldShares = Math.round(take * (strategy.isoHoldPct / 100));
      const sellShares = take - heldShares;
      const bargainPerShare = Math.max(0, fmv - g.strike);
      // Path 1 (same-day sell): bargain → ordinary income, no AMT
      isoBargainOrdinary += sellShares * bargainPerShare;
      // Path 2 (hold): bargain → AMT preference this year
      isoBargainHeldAMT += heldShares * bargainPerShare;
      isoStrikeOutlay += take * g.strike;
      isoSTCProceeds += sellShares * fmv;
      // Path 1 realizes spread now
      totalISOSpreadRealized += sellShares * bargainPerShare;
      if (heldShares > 0) {
        lots.push({
          kind: 'ISO',
          shares: heldShares,
          acquireDate: midYear,
          grantDate: g.grantDate || '',
          strike: g.strike,
          fmvAtAcquire: fmv,
        });
      }
    });

    // Sell-to-cover: sell freshly-exercised ISO shares (disqualifying same-day) to fund strike/AMT
    if (strategy.stc === 'strike' || strategy.stc === 'amt') {
      const need = isoStrikeOutlay
                 + (strategy.stc === 'amt' ? isoBargainHeldAMT * 0.28 : 0)
                 - isoSTCProceeds;
      if (need > 0 && fmv > 0) {
        let extraShares = Math.ceil(need / fmv);
        for (let i = lots.length - 1; i >= 0 && extraShares > 0; i--) {
          const lot = lots[i];
          if (lot.kind !== 'ISO' || lot.acquireDate !== midYear) continue;
          const n = Math.min(lot.shares, extraShares);
          lot.shares -= n;
          extraShares -= n;
          const bargainPerShare = Math.max(0, fmv - (lot.strike || 0));
          const gain = n * bargainPerShare;
          isoBargainOrdinary += gain;      // disqualifying — becomes ordinary
          isoBargainHeldAMT -= gain;       // remove from AMT preference
          isoSTCProceeds += n * fmv;
          totalISOSpreadRealized += gain;
        }
        for (let i = lots.length - 1; i >= 0; i--) if (lots[i].shares <= 0) lots.splice(i, 1);
      }
    }

    // Helper: dispose of `n` shares from a lot at `salePrice`. Returns
    // { proceeds, ordinary, stcg, ltcg, isoSpread }.
    const disposeLot = (lot, n, salePrice) => {
      const proceeds = n * salePrice;
      const holdYearsFromAcquire = (new Date(midYear) - new Date(lot.acquireDate)) / 31557600000;
      if (lot.kind === 'RSU') {
        const gain = proceeds - n * lot.fmvAtAcquire;
        return holdYearsFromAcquire >= 1
          ? { proceeds, ordinary: 0, stcg: 0, ltcg: gain, isoSpread: 0 }
          : { proceeds, ordinary: 0, stcg: gain, ltcg: 0, isoSpread: 0 };
      }
      // ISO
      const isoSpread = n * (salePrice - (lot.strike || 0));
      const holdYearsFromGrant = lot.grantDate
        ? (new Date(midYear) - new Date(lot.grantDate)) / 31557600000
        : Infinity;
      const qualifying = holdYearsFromAcquire >= 1 && holdYearsFromGrant >= 2;
      if (qualifying) {
        // Entire (P - K) is LTCG, basis = strike (Path 2)
        return { proceeds, ordinary: 0, stcg: 0, ltcg: isoSpread, isoSpread };
      }
      // Disqualifying disposition (Path 3):
      // ordinary chunk = min(bargain-at-exercise, actual gain from strike)
      const bargainAtEx = Math.max(0, lot.fmvAtAcquire - (lot.strike || 0));
      const gainFromStrike = Math.max(0, salePrice - (lot.strike || 0));
      const ordPerShare = Math.min(bargainAtEx, gainFromStrike);
      const ordinary = n * ordPerShare;
      // Capital gain leg for regular tax: sale − FMV_ex
      const capGain = n * (salePrice - lot.fmvAtAcquire);
      const disq = holdYearsFromAcquire >= 1
        ? { proceeds, ordinary, stcg: 0, ltcg: capGain, isoSpread }
        : { proceeds, ordinary, stcg: capGain, ltcg: 0, isoSpread };
      return disq;
    };

    /* 4) Strategic sales of held lots */
    if (strategy.heldSellPct > 0) {
      const totalHeld = lots.reduce((s, l) => s + l.shares, 0);
      let toSell = Math.floor(totalHeld * (strategy.heldSellPct / 100));
      lots.sort((a, b) => a.acquireDate.localeCompare(b.acquireDate));
      for (let i = 0; i < lots.length && toSell > 0; i++) {
        const lot = lots[i];
        const n = Math.min(lot.shares, toSell);
        const r = disposeLot(lot, n, fmv);
        rsuCashProceeds += r.proceeds;
        rsuLTCG += r.ltcg;
        rsuSTCG += r.stcg;
        isoDisqualifyingOrdinary += r.ordinary;
        totalISOSpreadRealized += r.isoSpread;
        lot.shares -= n;
        toSell -= n;
      }
      for (let i = lots.length - 1; i >= 0; i--) if (lots[i].shares <= 0) lots.splice(i, 1);
    }

    /* 5) Fund strike shortfall by selling RSU lots first (LT-qualified preferred) */
    if (strategy.fundFromRSU === 'true' || strategy.fundFromRSU === true) {
      const cashOut = isoStrikeOutlay - isoSTCProceeds;
      if (cashOut > 0) {
        // Prefer LT-qualified RSU lots (acquired ≥1yr ago) first
        const rsuLots = lots.filter(l => l.kind === 'RSU');
        rsuLots.sort((a, b) => a.acquireDate.localeCompare(b.acquireDate));
        let need = cashOut;
        for (const lot of rsuLots) {
          if (need <= 0) break;
          const sharesNeeded = Math.min(lot.shares, Math.ceil(need / fmv));
          const r = disposeLot(lot, sharesNeeded, fmv);
          rsuCashProceeds += r.proceeds;
          rsuLTCG += r.ltcg;
          rsuSTCG += r.stcg;
          lot.shares -= sharesNeeded;
          need -= r.proceeds;
        }
        for (let i = lots.length - 1; i >= 0; i--) if (lots[i].shares <= 0) lots.splice(i, 1);
      }
    }

    /* 6) Rental */
    const rentalNetFed = totalRentalNet();

    /* 7) Taxes — with MTC carryforward */
    const y = {
      K: S.K, filingStatus: S.profile.filingStatus,
      state: S.profile.state, customStateRate: S.profile.customStateRate,
      localRate: S.profile.localRate,
      dependentsCTC: S.profile.dependentsCTC, dependentsODC: S.profile.dependentsODC,
      wages, spouseWages: 0, bonus: 0,
      pretax401k: S.income.pretax401k, hsa: S.income.hsa,
      interestOrdDiv: S.income.interestOrdDiv, qualDiv: S.income.qualDiv,
      stcg: rsuSTCG, ltcg: rsuLTCG,
      rsuOrdinary,
      // Path 1 same-day-sell + Path 3 disqualifying-later-sale both add to ordinary
      isoBargainOrdinary: isoBargainOrdinary + isoDisqualifyingOrdinary,
      isoBargainHeldAMT,
      rentalNetFed, rentalNetState: rentalNetFed,
      ded: S.ded,
      mtcCarryIn: mtcCarry,
    };
    const taxR = computeYearTax(y);
    totalTax += taxR.total;
    if (taxR.amt > maxAMTyr) maxAMTyr = taxR.amt;
    mtcCarry = taxR.mtcCarryOut;

    /* 8) Cash flow */
    const livingExp = S.profile.livingExpenses * Math.pow(1 + inflation, yi);
    const takehomeWages = wages * 0.68;
    const datedExp = S.expenses
      .filter(e => e.date >= yStart && e.date < yEnd)
      .reduce((s, e) => s + (e.amount || 0), 0);

    const netTax = Math.max(0, taxR.total - wages * 0.32);
    const cashIn = takehomeWages + rsuCashProceeds + isoSTCProceeds - isoStrikeOutlay;
    const cashOut = livingExp + datedExp + netTax;
    cash += cashIn - cashOut;
    if (cash < minCash) minCash = cash;

    const equityShares = lots.reduce((s, l) => s + l.shares, 0);
    const equityMkt = equityShares * fmv;
    const wealth = cash + ((strategy.wealthIncludesEquity === 'true' || strategy.wealthIncludesEquity === true) ? equityMkt : 0);

    years.push({
      year, fmv,
      rsuVestValue: rsuOrdinary,
      isoExercisedShares,
      isoBargain: isoBargainHeldAMT + isoBargainOrdinary,
      isoDisqOrdinary: isoDisqualifyingOrdinary,
      stcg: rsuSTCG, ltcg: rsuLTCG,
      taxTotal: taxR.total, taxAMT: taxR.amt,
      mtcCarry, mtcUsed: taxR.mtcUsed || 0,
      cash, equityShares, equityMkt, wealth,
      isoStrikeOutlay, isoSTCProceeds, rsuCashProceeds,
    });
  }

  // Mark remaining held equity as unrealized ISO spread (informational)
  const finalYear = years[years.length - 1];
  const finalFMV = finalYear?.fmv || S.equity.currentFMV;
  let unrealizedISOSpread = 0;
  lots.forEach(l => {
    if (l.kind === 'ISO') unrealizedISOSpread += l.shares * (finalFMV - (l.strike || 0));
  });

  const effectiveRateOnRealizedISO = totalISOSpreadRealized > 0
      ? totalTaxOnISOSpread / totalISOSpreadRealized
      : null;

  return {
    strategy, years,
    totalTax, minCash, maxAMTyr,
    endWealth: years[years.length - 1]?.wealth ?? cash,
    feasible: minCash >= S.profile.minCash,
    mtcCarryEnd: mtcCarry,
    totalISOSpreadRealized,
    unrealizedISOSpread,
    baseYearTax: typeof computeBaseYear === 'function' ? computeBaseYear().total : 0,
  };
}

/* ---------- Rendering ---------- */
function renderStrategyResult(res) {
  const el = $('#strategy-summary');
  if (!el) return;
  // Rough effective rate on realized ISO spread — attribute the delta between
  // this strategy's total tax and the base-year tax × horizon to ISO activity.
  const effRateOnSpread = res.totalISOSpreadRealized > 0
      ? (res.totalTax - (res.baseYearTax || 0) * res.years.length) / res.totalISOSpreadRealized
      : null;
  el.innerHTML = `
    ${card('Ending wealth', fmt$(res.endWealth), '', 'good')}
    ${card('Total tax paid', fmt$(res.totalTax))}
    ${card('Tax as % of wealth', fmtPct(res.totalTax / Math.max(1, res.endWealth)))}
    ${card('Min cash', fmt$(res.minCash), res.feasible ? 'above floor' : 'BELOW min-cash', res.feasible ? 'good' : 'bad')}
    ${card('Max AMT (any year)', fmt$(res.maxAMTyr))}
    ${card('MTC unused at end', fmt$(res.mtcCarryEnd), 'AMT credit that never got recovered', res.mtcCarryEnd > 1000 ? 'warn' : '')}
    ${card('ISO spread realized', fmt$(res.totalISOSpreadRealized), 'Σ (sale − strike) across ISO cash events')}
    ${card('Effective rate on ISO spread',
      effRateOnSpread != null ? fmtPct(effRateOnSpread) : '—',
      'incremental tax ÷ ISO spread realized')}
    ${card('Unrealized ISO spread', fmt$(res.unrealizedISOSpread), 'still-held ISO shares × (endFMV − strike)')}
    ${card('Horizon', `${res.years.length} yrs`)}
  `;

  const tb = $('#strategy-years tbody');
  if (tb) tb.innerHTML = res.years.map(y => `
    <tr>
      <td>${y.year}</td>
      <td class="num">${fmt$(y.rsuVestValue)}</td>
      <td class="num">${fmtN(y.isoExercisedShares)}</td>
      <td class="num">${fmt$(y.isoBargain)}</td>
      <td class="num">${fmt$(y.isoDisqOrdinary || 0)}</td>
      <td class="num">${fmt$(y.stcg)}</td>
      <td class="num">${fmt$(y.ltcg)}</td>
      <td class="num">${fmt$(y.taxAMT)}</td>
      <td class="num">${fmt$(y.mtcUsed || 0)}</td>
      <td class="num">${fmt$(y.mtcCarry || 0)}</td>
      <td class="num">${fmt$(y.taxTotal)}</td>
      <td class="num ${y.cash < S.profile.minCash ? 'bad' : ''}">${fmt$(y.cash)}</td>
      <td class="num">${fmt$(y.equityMkt)}</td>
      <td class="num">${fmt$(y.wealth)}</td>
    </tr>
  `).join('');

  const cashCtx = $('#chart-cash')?.getContext('2d');
  if (cashCtx) {
    chartCash?.destroy();
    chartCash = new Chart(cashCtx, {
      type: 'line',
      data: {
        labels: res.years.map(y => y.year),
        datasets: [
          { label: 'Cash on hand', data: res.years.map(y => y.cash), borderColor: '#0b6bcb', backgroundColor: 'rgba(11,107,203,0.1)', tension: 0.2, fill: true },
          { label: 'Min cash floor', data: res.years.map(_ => S.profile.minCash), borderColor: '#c0392b', borderDash: [5,5], pointRadius: 0 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }}}}
    });
  }

  const wCtx = $('#chart-wealth')?.getContext('2d');
  if (wCtx) {
    chartWealth?.destroy();
    chartWealth = new Chart(wCtx, {
      type: 'bar',
      data: {
        labels: res.years.map(y => y.year),
        datasets: [
          { label: 'Cash', data: res.years.map(y => Math.max(0, y.cash)), backgroundColor: '#0b6bcb', stack: 'w' },
          { label: 'Equity (mkt)', data: res.years.map(y => y.equityMkt), backgroundColor: '#1f8a4c', stack: 'w' },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { stacked: true, ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }}, x: { stacked: true }}}
    });
  }
}

/* ---------- Optimizer ---------- */
function generateStrategyGrid() {
  const grid = [];
  const exs = [0, 20, 40, 60, 80, 100];
  const holds = [0, 50, 100];
  const rsuSells = [0, 25, 50, 75];
  const stcs = ['none', 'strike', 'amt'];
  for (const ex of exs) for (const h of holds) for (const rs of rsuSells) for (const stc of stcs) {
    grid.push({ ...S.strategy, isoExercisePct: ex, isoHoldPct: h, rsuSellPct: rs, stc });
  }
  return grid;
}
function paretoFrontier(results) {
  const feasible = results.filter(r => r.feasible);
  const frontier = [];
  for (const r of feasible) {
    const dominated = feasible.some(o => o !== r
      && o.endWealth >= r.endWealth && o.totalTax <= r.totalTax
      && (o.endWealth > r.endWealth || o.totalTax < r.totalTax));
    if (!dominated) frontier.push(r);
  }
  frontier.sort((a, b) => a.totalTax - b.totalTax);
  return frontier;
}
function runOptimizer() {
  setStatus('Searching strategies…', 5000);
  const grid = generateStrategyGrid();
  const results = grid.map(s => {
    const r = simulate(s);
    r.name = `Ex ${s.isoExercisePct}% · Hold ${s.isoHoldPct}% · RSU ${s.rsuSellPct}% · STC ${s.stc}`;
    return r;
  });
  const frontier = paretoFrontier(results);

  const ctx = $('#chart-pareto')?.getContext('2d');
  if (ctx) {
    chartPareto?.destroy();
    chartPareto = new Chart(ctx, {
      type: 'scatter',
      data: { datasets: [
        { label: 'Infeasible', data: results.filter(r => !r.feasible).map(r => ({ x: r.totalTax, y: r.endWealth })), backgroundColor: 'rgba(200,200,200,0.35)' },
        { label: 'Feasible', data: results.filter(r => r.feasible && !frontier.includes(r)).map(r => ({ x: r.totalTax, y: r.endWealth })), backgroundColor: 'rgba(11,107,203,0.35)' },
        { label: 'Pareto frontier', data: frontier.map(r => ({ x: r.totalTax, y: r.endWealth })), backgroundColor: '#1f8a4c', pointRadius: 6 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: 'Total tax paid' }, ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }},
          y: { title: { display: true, text: 'Ending wealth' }, ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }},
        }
      }
    });
  }

  const tb = $('#pareto-table tbody');
  if (tb) {
    tb.innerHTML = frontier.map((r, i) => `
      <tr class="frontier">
        <td>${i + 1}</td>
        <td>${r.name}</td>
        <td class="num">${fmt$(r.endWealth)}</td>
        <td class="num">${fmt$(r.totalTax)}</td>
        <td class="num">${fmt$(r.minCash)}</td>
        <td class="num">${fmt$(r.maxAMTyr)}</td>
        <td>${r.feasible ? '✓' : '✗'}</td>
        <td><button class="secondary select" data-select="${i}">Use</button></td>
      </tr>
    `).join('');
    tb.querySelectorAll('button[data-select]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = +btn.dataset.select;
        Object.assign(S.strategy, frontier[i].strategy);
        saveState();
        bindInputs();
        renderStrategyResult(frontier[i]);
        updateRangeLabels();
      });
    });
  }
  setStatus(`Searched ${results.length} strategies · ${frontier.length} on frontier.`, 4000);
}

/* ---------- Stress test ---------- */
function runStressTest() {
  const shock = {
    year: S.stress.shockYear,
    pct: S.stress.shockPct,
    postGrowth: S.stress.postShockGrowth,
    wageRecessionYears: S.stress.wageRecessionYears,
  };
  const base = simulate(S.strategy);
  const stressed = simulate(S.strategy, { shock });

  const el = $('#stress-summary');
  if (el) {
    el.innerHTML = `
      ${card('Base ending wealth', fmt$(base.endWealth), '', 'good')}
      ${card('Stressed ending wealth', fmt$(stressed.endWealth), '',
        stressed.endWealth < base.endWealth * 0.6 ? 'bad' : '')}
      ${card('Wealth loss', fmt$(base.endWealth - stressed.endWealth),
        fmtPct((base.endWealth - stressed.endWealth) / Math.max(1, base.endWealth)))}
      ${card('Base min cash', fmt$(base.minCash))}
      ${card('Stressed min cash', fmt$(stressed.minCash),
        stressed.minCash < S.profile.minCash ? 'below floor' : 'ok',
        stressed.minCash < S.profile.minCash ? 'bad' : 'good')}
      ${card('Max AMT (stress)', fmt$(stressed.maxAMTyr))}
    `;
  }

  const scCtx = $('#chart-stress-cash')?.getContext('2d');
  if (scCtx) {
    chartStressCash?.destroy();
    chartStressCash = new Chart(scCtx, {
      type: 'line',
      data: {
        labels: base.years.map(y => y.year),
        datasets: [
          { label: 'Base cash', data: base.years.map(y => y.cash), borderColor: '#0b6bcb', tension: 0.2 },
          { label: 'Stressed cash', data: stressed.years.map(y => y.cash), borderColor: '#c0392b', tension: 0.2 },
          { label: 'Min cash floor', data: base.years.map(_ => S.profile.minCash), borderColor: '#999', borderDash: [4,4], pointRadius: 0 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }}}}
    });
  }

  const swCtx = $('#chart-stress-wealth')?.getContext('2d');
  if (swCtx) {
    chartStressWealth?.destroy();
    chartStressWealth = new Chart(swCtx, {
      type: 'line',
      data: {
        labels: base.years.map(y => y.year),
        datasets: [
          { label: 'Base wealth', data: base.years.map(y => y.wealth), borderColor: '#1f8a4c', tension: 0.2 },
          { label: 'Stressed wealth', data: stressed.years.map(y => y.wealth), borderColor: '#c0392b', tension: 0.2 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }}}}
    });
  }
  setStatus('Stress test complete.', 3000);
}

/* ---------- Range label helpers ---------- */
function updateRangeLabels() {
  const map = {
    'v-isoex':    ['strategy.isoExercisePct', '%'],
    'v-isohold':  ['strategy.isoHoldPct', '%'],
    'v-rsusell':  ['strategy.rsuSellPct', '%'],
    'v-heldsell': ['strategy.heldSellPct', '%'],
    'v-shock':    ['stress.shockPct', '%'],
  };
  for (const id in map) {
    const el = document.getElementById(id);
    if (el) el.textContent = (deepGet(S, map[id][0]) ?? '') + map[id][1];
  }
}

/* ---------- Wire up buttons ---------- */
window.addEventListener('DOMContentLoaded', () => {
  $('#run-strategy')?.addEventListener('click', () => {
    const res = simulate(S.strategy);
    res.name = 'Current strategy';
    renderStrategyResult(res);
    setStatus('Simulation complete.', 3000);
  });
  $('#run-optimizer')?.addEventListener('click', runOptimizer);
  $('#run-stress')?.addEventListener('click', runStressTest);

  document.addEventListener('input', updateRangeLabels);
  updateRangeLabels();
});
