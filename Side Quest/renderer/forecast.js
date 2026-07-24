/* Forecasting studio — a glass-box R&D instrument. Three regions: a compact POLL rail (left), the
   BALANCE-OF-POWER centerpiece (center), and the WORK inspector (right) that shows the active widget's
   variable inputs + live computation reads. Data from window.sq.forecast.*; embedded samples when absent. */
'use strict';
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const bridge = !!(window.sq && window.sq.forecast);
  const C = { dem: '#4B79D6', rep: '#D6534B', approve: '#43B89F', disapprove: '#E4694F', accent: '#D9A441', muted: '#98A1B2' };
  const pctCol = (name) => /disapprov|unfavor|\bno\b/i.test(name) ? C.disapprove : /approv|favor|\byes\b/i.test(name) ? C.approve : C.accent;
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

  let active = 'balance_of_power';
  const cache = {};
  let calData = null;   // structural-model calibration backtest (fetched once) — the trust readout

  // ---- fetchers ----
  const getPoll = (force) => bridge ? window.sq.forecast.pollAverage({ subject: 'Donald Trump', poll_type: 'approval', force }) : Promise.resolve(SAMPLE_POLL);
  const getBalance = (opts) => bridge ? window.sq.forecast.balance(opts || {}) : Promise.resolve(SAMPLE_BALANCE);

  // ---- POLL (compact, left rail) ----
  function renderPoll(host, d) {
    host.innerHTML = '';
    const card = el('div', 'card'); card.dataset.id = 'poll_average';
    const head = el('div', 'w-head');
    head.appendChild(el('span', 'tag', 'Model'));
    head.appendChild(el('h2', null, 'Poll Average'));
    head.appendChild(el('span', 'sub', d.subject || ''));
    head.addEventListener('click', () => setActive('poll_average'));
    const body = el('div', 'w-body');
    const sorted = (d.choices || []).slice();
    const lead = sorted[0], run = sorted[1];
    const net = lead && run ? +(lead.pct - run.pct).toFixed(1) : null;
    const netCol = lead && /disapprov/i.test(lead.choice) ? C.disapprove : C.approve;
    const nb = el('div', 'p-net');
    const num = el('div', 'num', net == null ? '—' : (lead && /disapprov/i.test(lead.choice) ? '−' : '+') + Math.abs(net)); num.style.color = netCol;
    nb.appendChild(num); nb.appendChild(el('div', 'lbl', 'net margin')); body.appendChild(nb);
    const bars = el('div', 'p-bars');
    sorted.forEach((c) => {
      const col = pctCol(c.choice); const row = el('div', 'p-row');
      const ph = el('div', 'ph'); const nm = el('span', 'nm'); const i = el('i'); i.style.background = col; nm.appendChild(i); nm.appendChild(document.createTextNode(c.choice));
      const v = el('span', 'v', c.pct.toFixed(1)); v.style.color = col; ph.appendChild(nm); ph.appendChild(v);
      const tr = el('div', 'track'); const f = el('div', 'fill'); f.style.width = Math.max(0, Math.min(100, c.pct)) + '%'; f.style.background = col; tr.appendChild(f);
      row.appendChild(ph); row.appendChild(tr); bars.appendChild(row);
    });
    const corr = el('div', 'p-corr'); corr.innerHTML = `<b>${fmt(d.n_polls)}</b> polls · <b>${fmt(d.n_pollsters)}</b> pollsters`;
    bars.appendChild(corr); body.appendChild(bars);
    card.appendChild(head); card.appendChild(body); host.appendChild(card);
    markActive();
  }

  // ---- BALANCE OF POWER (center) ----
  function verdict(ch) { const d = ch.pD_control; return d >= .9 ? 'D safe' : d >= .6 ? 'D favored' : d > .4 ? 'Toss-up' : d > .1 ? 'R favored' : 'R safe'; }
  function chamberCard(name, ch) {
    const c = el('div', 'cham');
    const hh = el('div', 'ch-head'); hh.appendChild(el('h3', null, name));
    const meta = el('div', 'ch-meta'); meta.innerHTML = `${ch.total} seats<br>${ch.need} to win · ${ch.competitive} in play`; hh.appendChild(meta); c.appendChild(hh);
    const v = el('div', 'verdict'); const who = el('div', 'who', verdict(ch)); who.style.color = ch.pD_control > ch.pR_control ? C.dem : (ch.pR_control > .6 ? C.rep : C.ink);
    const p = el('div', 'pct'); p.innerHTML = `<b style="color:${C.dem}">D ${Math.round(ch.pD_control * 100)}%</b> &nbsp; <b style="color:${C.rep}">R ${Math.round(ch.pR_control * 100)}%</b>`;
    v.appendChild(who); v.appendChild(p); c.appendChild(v);
    // bar
    const dPct = ch.dSeats_mean / ch.total * 100, needPct = ch.need / ch.total * 100, p10 = ch.dSeats_p10 / ch.total * 100, p90 = ch.dSeats_p90 / ch.total * 100;
    const bar = el('div', 'bar');
    const dem = el('div', 'dem'); dem.style.width = dPct + '%'; bar.appendChild(dem);
    const rep = el('div', 'rep'); rep.style.width = (100 - dPct) + '%'; bar.appendChild(rep);
    const band = el('div', 'band'); band.style.left = p10 + '%'; band.style.width = (p90 - p10) + '%'; bar.appendChild(band);
    const maj = el('div', 'maj'); maj.style.left = needPct + '%'; bar.appendChild(maj);
    const ml = el('div', 'maj-label', ch.need); ml.style.left = needPct + '%'; bar.appendChild(ml);
    c.appendChild(bar);
    const sr = el('div', 'seat-row'); sr.innerHTML = `<span class="d">D ${Math.round(ch.dSeats_mean)} <span class="rng">(${ch.dSeats_p10}–${ch.dSeats_p90})</span></span><span class="r">${Math.round(ch.total - ch.dSeats_mean)} R</span>`; c.appendChild(sr);
    const tip = el('div', 'tip'); tip.appendChild(el('div', 'tl', 'Tipping-point races'));
    (ch.tipping || []).forEach((r) => { const row = el('div', 'race'); row.innerHTML = `<span class="rid">${String(r.id).toUpperCase()}</span><span class="m" style="color:${r.margin >= 0 ? C.dem : C.rep}">${r.margin >= 0 ? 'D' : 'R'} +${Math.abs(r.margin).toFixed(1)}</span>`; tip.appendChild(row); });
    c.appendChild(tip); return c;
  }
  function renderBalance(host, d) {
    host.innerHTML = '';
    const pay = d.payload || d;
    const card = el('div', 'card'); card.dataset.id = 'balance_of_power';
    const head = el('div', 'w-head');
    head.appendChild(el('span', d.illustrative ? 'tag illus' : 'tag', d.illustrative ? 'Illustrative' : 'Model'));
    head.appendChild(el('h2', null, 'Balance of Power'));
    head.appendChild(el('span', 'sub', d.work ? `${d.work.sim.iterations.toLocaleString()} runs · ${d.work.timing_ms}ms` : ''));
    head.addEventListener('click', () => setActive('balance_of_power'));
    const body = el('div', 'w-body');
    const chambers = el('div', 'chambers'); chambers.appendChild(chamberCard('House', pay.house)); chambers.appendChild(chamberCard('Senate', pay.senate)); body.appendChild(chambers);
    const scen = el('div', 'scen'); scen.appendChild(el('div', 'sl', 'Government scenarios'));
    const max = Math.max.apply(null, (pay.scenarios || []).map((s) => s.prob).concat([0.01]));
    (pay.scenarios || []).forEach((s, i) => {
      const hd = s.label.indexOf('House D') >= 0, sd = s.label.indexOf('Senate D') >= 0;
      const row = el('div', 'scen-row');
      const nm = el('div', 'name'); nm.innerHTML = `<span class="chip" style="background:${hd ? C.dem : C.rep}"></span><span class="chip" style="background:${sd ? C.dem : C.rep}"></span>${s.label}`;
      const tr = el('div', 'scen-track'); const f = el('div', 'scen-fill'); f.style.width = (s.prob / max * 100) + '%'; f.style.background = (hd === sd) ? (hd ? C.dem : C.rep) : 'linear-gradient(90deg,' + C.dem + ',' + C.rep + ')'; f.style.animationDelay = (i * .07) + 's'; tr.appendChild(f);
      row.appendChild(nm); row.appendChild(tr); row.appendChild(el('div', 'p', Math.round(s.prob * 100) + '%')); scen.appendChild(row);
    });
    body.appendChild(scen);
    card.appendChild(head); card.appendChild(body); host.appendChild(card);
    markActive();
  }

  // ---- INSPECTOR (right: the WORK) ----
  function sec(title, right) { const s = el('div', 'insp-sec'); const h = el('div', 'h'); h.appendChild(el('span', null, title)); if (right) h.appendChild(el('span', 'live', right)); s.appendChild(h); return s; }
  function chip(label, val) { const c = el('div', 'chip'); c.appendChild(el('b', null, label)); c.appendChild(document.createTextNode(' ' + val)); return c; }
  function kv(pairs) { const g = el('div', 'kv'); pairs.forEach(([k, v]) => { g.appendChild(el('div', 'k', k)); const vd = el('div', 'v', v); g.appendChild(vd); }); return g; }

  function renderInspector(id, pulse) {
    const host = $('#insp-col'); host.innerHTML = '';
    const data = cache[id]; if (!data) { host.appendChild(el('div', 'w-loading', 'No widget selected.')); return; }
    const insp = el('div', 'insp');
    const hd = el('div', 'insp-head'); hd.appendChild(el('span', 'k', 'Work')); hd.appendChild(el('span', 't', id === 'balance_of_power' ? 'Balance of Power' : 'Poll Average')); insp.appendChild(hd);
    const b = el('div', 'insp-body');

    if (id === 'balance_of_power' && data.work) {
      const w = data.work, cfg = w.inputs.config;
      const inS = sec('Variable inputs');
      const chips = el('div', 'chips');
      chips.appendChild(chip('nat. σ', cfg.nationalSigma)); chips.appendChild(chip('iters', cfg.iterations.toLocaleString())); chips.appendChild(chip('seed', cfg.seed));
      chips.appendChild(chip('House maj', cfg.majority.house)); chips.appendChild(chip('Senate maj', cfg.majority.senate));
      inS.appendChild(chips);
      b.appendChild(inS);

      // COVERAGE — how many races carry a real signed margin vs a prior (the real-vs-illustrative read)
      if (w.margins) {
        const covS = sec('Coverage', `${w.margins.polled}/${w.margins.total} polled`);
        covS.appendChild(kv([
          ['races (total)', fmt(w.margins.total)],
          ['on real polls', fmt(w.margins.polled)],
          ['on priors', fmt(w.margins.prior)],
        ]));
        b.appendChild(covS);
      }

      // FUNDAMENTALS — the national economic environment lean + its component audit (the "outside conditions" leg)
      if (w.fundamentals && w.fundamentals.has_data) {
        const f = w.fundamentals;
        const favCol = f.favors === 'A' ? C.dem : (f.favors === 'B' ? C.rep : C.muted);
        const fS = sec('Fundamentals · economy', `${f.lean > 0 ? '+' : ''}${f.lean} → ${f.favors === 'A' ? 'D' : f.favors === 'B' ? 'R' : 'neutral'}`);
        fS.querySelector('.live').style.color = favCol;
        fS.appendChild(kv((f.components || []).map((c) => [c.note || c.name, (c.points_incumbent > 0 ? '+' : '') + c.points_incumbent])));
        const nb = el('div', 'chip'); nb.textContent = `national lean ${f.lean} pts (incumbent = ${f.incumbentParty === 'A' ? 'D' : 'R'}); applied uniformly to every race, capped, provisional.`; fS.appendChild(nb);
        b.appendChild(fS);
      }

      // SIGNALS — the live news volume feeding the reactor (events = corroborated; momentum = raw incl. CC)
      if (w.signals) {
        const sgS = sec('News signals', w.assess ? `${w.assess.assessed}/${w.assess.pairs} judged` : '');
        sgS.appendChild(kv([
          ['corroborated events', fmt(w.signals.events)],
          ['momentum (raw/CC)', fmt(w.signals.momentum)],
          ['shift-eligible pairs', w.assess ? fmt(w.assess.pairs) : '—'],
          ['gpt-oss judged', w.assess ? fmt(w.assess.assessed) : '—'],
        ]));
        b.appendChild(sgS);
      }

      // RACE LEDGER — every race, its margin + where it came from (polls vs prior) + what news/econ moved it
      const races = (w.inputs.races || []).slice().sort((a, z) => (a.margin_source === 'polls' ? 0 : 1) - (z.margin_source === 'polls' ? 0 : 1) || Math.abs(z.margin) - Math.abs(a.margin));
      const dtS = sec('Race ledger', `${races.length} races`);
      const dt = el('div', 'datatable'); const tbl = el('table');
      tbl.innerHTML = '<thead><tr><th>race</th><th>src</th><th>margin</th><th>n</th><th>σ</th></tr></thead>';
      const tb = el('tbody');
      races.forEach((r) => {
        const polled = r.margin_source === 'polls';
        const tr = el('tr');
        tr.innerHTML = `<td>${r.id || r.subject || ''}</td>`
          + `<td style="color:${polled ? C.accent : C.muted}">${polled ? 'poll' : 'prior'}</td>`
          + `<td class="${r.margin >= 0 ? 'pos' : 'neg'}">${r.margin >= 0 ? 'D+' : 'R+'}${Math.abs(r.margin).toFixed(1)}</td>`
          + `<td>${r.n_polls || 0}</td><td>${r.sigma}</td>`;
        tb.appendChild(tr);
      });
      tbl.appendChild(tb); dt.appendChild(tbl); dtS.appendChild(dt); b.appendChild(dtS);

      const liveS = sec('Live simulator reads', pulse ? 'updated' : ''); if (pulse) liveS.classList.add('pulse');
      const H = w.sim.chambers.house, S = w.sim.chambers.senate;
      liveS.appendChild(kv([
        ['House P(D control)', (H.pA_control * 100).toFixed(1) + '%'],
        ['House D seats', `${H.seatsA_mean} (${H.seatsA_p10}–${H.seatsA_p90})`],
        ['Senate P(D control)', (S.pA_control * 100).toFixed(1) + '%'],
        ['Senate D seats', `${S.seatsA_mean} (${S.seatsA_p10}–${S.seatsA_p90})`],
        ['iterations', w.sim.iterations.toLocaleString()],
        ['compute', w.timing_ms + ' ms'],
      ]));
      b.appendChild(liveS);
      const note = el('div', 'insp-sec'); note.appendChild(el('div', 'h', 'Provenance'));
      const provTxt = data.illustrative
        ? 'Illustrative — no race has a real signed margin yet (all priors). Balance is driven by holdovers + fundamentals.'
        : `Real signal — ${w.margins ? w.margins.polled : '?'} races on live poll averages (FEC-signed), + fundamentals + news. Holdovers/coverage still approximate.`;
      note.appendChild(el('div', 'chip', provTxt)); b.appendChild(note);

      // MODEL SCORES — the structural model's full-chain backtest vs real presidential history (the trust readout)
      if (calData && calData.ok) {
        const cS = sec('Model scores · backtest', `n=${calData.n}`);
        cS.appendChild(kv([
          ['win Brier', calData.brier],
          ['skill vs base rate', Math.round(calData.brier_skill * 100) + '%'],
          ['calibration (ECE)', calData.ece],
          ['95% coverage', Math.round(calData.coverage95 * 100) + '%'],
          ['margin RMSE', calData.rmse + ' pts'],
          ['tuned σ', calData.tuned_sigma],
        ]));
        const rel = el('div'); rel.style.marginTop = '8px';   // reliability: predicted prob → observed frequency
        (calData.reliability || []).forEach((bk) => {
          const row = el('div'); row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;font-size:.66rem;font-variant-numeric:tabular-nums';
          const pp = Math.round((bk.mean_prob || 0) * 100), ob = Math.round((bk.observed || 0) * 100);
          row.innerHTML = `<span style="width:46px;color:var(--muted)">p~${pp}%</span>`
            + `<span style="flex:1;height:7px;background:var(--panel-2);border-radius:4px;position:relative;overflow:hidden"><i style="position:absolute;left:0;top:0;bottom:0;width:${ob}%;background:var(--accent)"></i></span>`
            + `<span style="width:58px;text-align:right;color:var(--ink)">won ${ob}%</span>`;
          rel.appendChild(row);
        });
        cS.appendChild(rel);
        cS.appendChild(el('div', 'chip', 'Structural model, backtested leave-one-election-out on presidential history (1976–2024). When it says X%, it happens ~X% — the probabilities are calibrated.'));
        b.appendChild(cS);
      }
    } else if (id === 'poll_average') {
      const inS = sec('Variable inputs');
      const chips = el('div', 'chips');
      [['½-life', '21d'], ['sample', '√n'], ['quality', '538'], ['house-fx', 'on'], ['choice-set', (data.applied && data.applied.choiceSet) || 'modal']].forEach(([k, v]) => chips.appendChild(chip(k, v)));
      inS.appendChild(chips);
      inS.appendChild(kv([['polls', fmt(data.n_polls)], ['pollsters', fmt(data.n_pollsters)], ['as of', data.as_of || '—']]));
      b.appendChild(inS);
      const liveS = sec('Live model reads');
      liveS.appendChild(kv((data.choices || []).map((c) => [c.choice, c.pct.toFixed(1) + '%']).concat([['leader', data.leader || '—'], ['margin', data.margin != null ? '+' + Math.abs(data.margin) : '—']])));
      b.appendChild(liveS);
    }
    insp.appendChild(b); host.appendChild(insp);
  }

  // ---- CONDITIONAL WHAT-IF (Slice 3): run a hypothetical against the live baseline, show the delta ----
  let whatIfCatalog = null;
  const getScenarioList = () => bridge ? window.sq.forecast.scenarioList() : Promise.resolve({ ok: true, scenarios: SAMPLE_SCEN_LIST });
  const runScenario = (opts) => bridge ? window.sq.forecast.scenario(opts) : Promise.resolve(SAMPLE_SCENARIO);

  function deltaBadge(dP) {
    const pts = dP * 100, flat = Math.abs(pts) < 0.05;
    const b = el('span', 'dd', (pts > 0 ? '+' : '') + pts.toFixed(1) + ' pts');
    b.style.color = flat ? C.muted : (pts > 0 ? C.dem : C.rep);
    b.style.background = flat ? 'transparent' : (pts > 0 ? 'var(--dem-dim)' : 'var(--rep-dim)');
    return b;
  }
  function chamberDeltaEl(name, ch) {   // ch = { dP_control, base_pA_control, scn_pA_control }
    const row = el('div', 'wi-cham');
    row.appendChild(el('span', 'cn', name));
    row.appendChild(el('span', 'from', Math.round((ch.base_pA_control || 0) * 100) + '%'));
    row.appendChild(el('span', 'arrow', '→'));
    const to = el('span', 'to', Math.round((ch.scn_pA_control || 0) * 100) + '%'); to.style.color = (ch.scn_pA_control >= 0.5 ? C.dem : C.rep); row.appendChild(to);
    row.appendChild(el('span', 'from', 'P(D)'));
    row.appendChild(deltaBadge(ch.dP_control || 0));
    return row;
  }
  function chamberRangeEl(name, pos, neg) {
    const row = el('div', 'wi-cham');
    const lo = Math.min(pos.scn_pA_control, neg.scn_pA_control), hi = Math.max(pos.scn_pA_control, neg.scn_pA_control);
    row.appendChild(el('span', 'cn', name));
    row.appendChild(el('span', 'from', Math.round((pos.base_pA_control || 0) * 100) + '%'));
    row.appendChild(el('span', 'arrow', '→'));
    row.appendChild(el('span', 'to', Math.round(lo * 100) + '–' + Math.round(hi * 100) + '%'));
    row.appendChild(el('span', 'from', 'P(D) range'));
    return row;
  }
  function renderScenarioResult(out, r) {
    out.innerHTML = '';
    if (!r || r.ok === false) { out.appendChild(el('div', 'w-error', (r && r.error) || 'no result')); return; }
    const s = r.scenario || {};
    const hdr = el('div', 'wi-hdr'); hdr.appendChild(el('span', null, s.name || 'What-if'));
    if (s.estimated) hdr.appendChild(el('span', 'wi-est', 'estimated'));
    if (r.two_sided) hdr.appendChild(el('span', 'wi-est', 'two-sided range'));
    out.appendChild(hdr);
    if (s.description) out.appendChild(el('div', 'wi-desc', s.description));
    const cd = el('div'); cd.style.cssText = 'display:flex;flex-direction:column;gap:7px';
    if (r.two_sided) {
      const ph = r.positive.delta.chambers, nh = r.negative.delta.chambers;
      if (ph.house && nh.house) cd.appendChild(chamberRangeEl('House', ph.house, nh.house));
      if (ph.senate && nh.senate) cd.appendChild(chamberRangeEl('Senate', ph.senate, nh.senate));
    } else {
      const ch = (r.delta && r.delta.chambers) || {};
      if (ch.house) cd.appendChild(chamberDeltaEl('House', ch.house));
      if (ch.senate) cd.appendChild(chamberDeltaEl('Senate', ch.senate));
    }
    out.appendChild(cd);
    if (!r.two_sided) {
      const flips = (r.delta && r.delta.flips) || [];
      const fl = el('div'); fl.appendChild(el('div', 'wi-sec-l', flips.length ? `Seats that flip (${flips.length})` : 'Seats that flip'));
      if (flips.length) {
        const box = el('div', 'wi-flips');
        flips.slice(0, 24).forEach((f) => { const towardR = /Rep|B\//.test(f.toward || ''); const c = el('div', 'wi-flip'); c.innerHTML = `${String(f.id).split(':')[0]} <b style="color:${towardR ? C.rep : C.dem}">→ ${towardR ? 'R' : 'D'}</b>`; box.appendChild(c); });
        fl.appendChild(box);
      } else { fl.appendChild(el('div', 'wi-desc', 'None cross at the point estimate — the shock moves probabilities, not the tipping seats.')); }
      out.appendChild(fl);
    } else { out.appendChild(el('div', 'wi-desc', 'Direction is genuinely ambiguous, so the outcome is a band — which seats cross depends on which way it breaks.')); }
    const eff = s.effects || [];
    if (eff.length) {
      const es = el('div'); es.appendChild(el('div', 'wi-sec-l', 'What it applied'));
      const list = el('div', 'wi-eff');
      eff.forEach((e) => {
        const where = e.scope === 'national' ? 'nationally' : `${e.scope}:${e.value}`;
        const bits = [];
        if (e.margin_delta) bits.push(`${e.margin_delta > 0 ? '+' : ''}${e.margin_delta} pts`);
        if (e.sigma_add) bits.push(`+${e.sigma_add}σ`);
        if (e.correlated) bits.push('correlated');
        if (e.direction_uncertain) bits.push('two-sided');
        list.appendChild(el('div', null, `• ${bits.join(', ') || 'volatility'} — ${where}${e.competitiveOnly ? ' (competitive only)' : ''}${e.rationale ? ' · ' + e.rationale : ''}`));
      });
      es.appendChild(list); out.appendChild(es);
    }
  }
  function renderWhatIf(host) {
    if (!host) return;
    host.innerHTML = '';
    const card = el('div', 'card');
    const head = el('div', 'w-head'); head.appendChild(el('span', 'tag illus', 'Hypothetical')); head.appendChild(el('h2', null, 'Conditional what-if'));
    card.appendChild(head);
    const body = el('div', 'w-body');
    const ctrl = el('div', 'wi-ctrl');
    const sel = el('select', 'wi-sel'); sel.appendChild(new Option('— pick a scenario —', ''));
    (whatIfCatalog || []).forEach((sc) => sel.appendChild(new Option(sc.name + (sc.two_sided ? '  (±)' : ''), sc.id)));
    const txt = el('input', 'wi-txt'); txt.type = 'text'; txt.placeholder = 'or describe one: "Iran war hot on election day"';
    const run = el('button', 'btn', 'Run');
    ctrl.appendChild(sel); ctrl.appendChild(txt); ctrl.appendChild(run);
    body.appendChild(ctrl);
    const out = el('div', 'wi-out'); body.appendChild(out);
    card.appendChild(body); host.appendChild(card);
    const go = () => {
      const id = sel.value, description = txt.value.trim();
      if (!id && description.length < 8) { out.innerHTML = ''; out.appendChild(el('div', 'w-error', 'Pick a scenario, or type a what-if (a phrase).')); return; }
      run.disabled = true; out.innerHTML = ''; out.appendChild(el('div', 'w-loading', id ? 'Running the counterfactual…' : 'Estimating the shock, then running it…'));
      Promise.resolve().then(() => runScenario(id ? { id } : { description })).then((r) => renderScenarioResult(out, r))
        .catch((e) => { out.innerHTML = ''; out.appendChild(el('div', 'w-error', 'Error — ' + e.message)); })
        .finally(() => { run.disabled = false; });
    };
    run.addEventListener('click', go);
    txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    sel.addEventListener('change', () => { if (sel.value) { txt.value = ''; go(); } });
  }
  function loadWhatIf() {
    return Promise.resolve().then(() => getScenarioList())
      .then((r) => { whatIfCatalog = (r && r.ok !== false && r.scenarios) || []; renderWhatIf($('#whatif-col')); })
      .catch(() => { whatIfCatalog = []; renderWhatIf($('#whatif-col')); });
  }

  function markActive() { document.querySelectorAll('.card').forEach((c) => c.classList.toggle('active', c.dataset.id === active)); }
  function setActive(id) { active = id; markActive(); renderInspector(id); }

  // ---- mount + controls ----
  function loadPoll() { return Promise.resolve().then(() => getPoll(false)).then((d) => { if (d && d.ok !== false) { cache.poll_average = d; renderPoll($('#poll-col'), d); } else { $('#poll-col').innerHTML = ''; $('#poll-col').appendChild(el('div', 'card', '')).appendChild(el('div', 'w-error', 'Poll model unavailable' + (d && d.error ? ' — ' + d.error : ''))); } }).catch((e) => { $('#poll-col').innerHTML = `<div class="card"><div class="w-error">Error — ${e.message}</div></div>`; }); }
  function loadBalance(opts, pulse) { $('#balance-col').innerHTML = '<div class="card"><div class="w-loading">Simulating…</div></div>'; return Promise.resolve().then(() => getBalance(opts)).then((d) => { if (d && d.ok !== false) { cache.balance_of_power = d; renderBalance($('#balance-col'), d); if (active === 'balance_of_power') renderInspector('balance_of_power', pulse); } else { $('#balance-col').innerHTML = `<div class="card"><div class="w-error">Balance model unavailable${d && d.error ? ' — ' + d.error : ''}</div></div>`; } }).catch((e) => { $('#balance-col').innerHTML = `<div class="card"><div class="w-error">Error — ${e.message}</div></div>`; }); }

  function mount() {
    loadPoll(); loadBalance({}).then(() => { setActive('balance_of_power'); });
    loadWhatIf();
    (bridge ? window.sq.forecast.calibration() : Promise.resolve(SAMPLE_CAL))
      .then((c) => { calData = c; if (active === 'balance_of_power' && cache.balance_of_power) renderInspector('balance_of_power'); }).catch(() => {});
  }
  const SAMPLE_CAL = { ok: true, n: 612, rmse: 10.36, brier: 0.115, brier_skill: 0.526, ece: 0.036, coverage95: 0.946, tuned_sigma: 10, reliability: [{ mean_prob: 0.06, observed: 0.03, n: 223 }, { mean_prob: 0.29, observed: 0.27, n: 86 }, { mean_prob: 0.5, observed: 0.45, n: 82 }, { mean_prob: 0.71, observed: 0.66, n: 82 }, { mean_prob: 0.92, observed: 0.94, n: 139 }] };
  document.addEventListener('DOMContentLoaded', () => {
    mount();
    const rr = $('#rerun'); if (rr) rr.addEventListener('click', () => { rr.disabled = true; loadBalance({ seed: Math.floor(Math.random() * 1e9) }, true).finally(() => { rr.disabled = false; }); });
    const rf = $('#refresh'); if (rf) rf.addEventListener('click', () => { rf.disabled = true; Promise.all([loadPoll(), loadBalance({ force: true })]).finally(() => { rf.disabled = false; renderInspector(active); }); });
  });

  // ---- embedded samples (standalone preview only) ----
  const SAMPLE_SCEN_LIST = [{ id: 'wildfire-brownouts', name: 'Wildfire brownouts break through the heat', two_sided: false }, { id: 'iran-war-hot', name: 'Iran war hot during voting', two_sided: true }];
  const SAMPLE_SCENARIO = { ok: true, two_sided: false, scenario: { id: 'wildfire-brownouts', name: 'Wildfire brownouts', description: 'Western grid strain punishes the incumbent party in competitive western seats.', estimated: false, effects: [{ scope: 'region', value: 'fire-west', competitiveOnly: true, margin_delta: -4, sigma_add: 2, correlated: true, rationale: 'competence/incumbent penalty' }] }, delta: { chambers: { house: { dP_control: -0.07, base_pA_control: 0.68, scn_pA_control: 0.61 }, senate: { dP_control: -0.05, base_pA_control: 0.57, scn_pA_control: 0.52 } }, flips: [{ id: 'CA-01:us-representative', toward: 'B/Rep' }, { id: 'NV-03:us-representative', toward: 'B/Rep' }, { id: 'AZ:us-senator', toward: 'B/Rep' }] } };
  const SAMPLE_POLL = { ok: true, as_of: '2026-07-03', subject: 'Donald Trump', choices: [{ choice: 'Disapprove', pct: 57.2 }, { choice: 'Approve', pct: 39.8 }], leader: 'Disapprove', margin: 17.4, n_polls: 1015, n_pollsters: 91, applied: { choiceSet: 'approve|disapprove' } };
  const SB_RACES = Array.from({ length: 6 }, (_, i) => ({ id: 'house-' + i, chamber: 'house', margin: (i - 2.5), sigma: 6 })).concat(Array.from({ length: 3 }, (_, i) => ({ id: 'senate-' + i, chamber: 'senate', margin: (i - 1) - 1, sigma: 6 })));
  const SAMPLE_BALANCE = { ok: true, illustrative: true, as_of: 'illustrative', payload: { house: { need: 218, total: 435, pD_control: .383, pR_control: .617, dSeats_mean: 215.4, dSeats_p10: 207, dSeats_p90: 224, competitive: 37, tipping: [{ id: 'house-19', margin: -0.2 }, { id: 'house-20', margin: 0.2 }, { id: 'house-21', margin: 0.5 }] }, senate: { need: 51, total: 100, pD_control: .241, pR_control: .759, dSeats_mean: 48.7, dSeats_p10: 46, dSeats_p90: 52, competitive: 11, tipping: [{ id: 'senate-7', margin: 0.4 }, { id: 'senate-6', margin: -0.5 }] }, scenarios: [{ label: 'House R | Senate R', prob: .575 }, { label: 'House D | Senate D', prob: .199 }, { label: 'House D | Senate R', prob: .184 }, { label: 'House R | Senate D', prob: .042 }] }, work: { inputs: { config: { nationalSigma: 3.4, iterations: 40000, seed: 2026, majority: { house: 218, senate: 51 } }, races: SB_RACES }, sim: { chambers: { house: { pA_control: .383, seatsA_mean: 215.4, seatsA_p10: 207, seatsA_p90: 224 }, senate: { pA_control: .241, seatsA_mean: 48.7, seatsA_p10: 46, seatsA_p90: 52 } }, iterations: 40000 }, timing_ms: 42 } };
})();
