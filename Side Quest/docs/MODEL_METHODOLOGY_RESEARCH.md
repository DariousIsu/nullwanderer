# Forecasting Methodology Research — "What we actually need to pull this off"

> Research pass 2026-07-03 (Lucas). Deep-read of three real modern election models + a data/method GAP analysis
> against our current machine. Purpose: decide what DATA and what METHODS we need, and whether we need a
> Python sidecar. Sources at the bottom. **Both reference models are MIT-licensed → liftable.**

---

## 1. The three systems (what they actually do)

### A. keithpotz/Election-Prediction — supervised ML (XGBoost) · MIT license
The most directly liftable (closest to what we're building, FRED-based).
- **Engine:** XGBoost regression on **71,840 county-level rows (2000–2024)**. THREE models (median + 2.5th + 97.5th quantile) → a **95% CI** on every state. Leave-One-Election-Out CV; recency-weighted (2024 = 5×, 2000 = 1×). Target = candidate vote share 0–100%.
- **Features (this is the gold):** `year, totalvotes, gdp_growth, unemployment, inflation, consumer_confidence, is_incumbent, incumbent_on_ballot, consecutive_terms, state_lean, county_lean, turnout_delta`, one-hot state, one-hot party. + a live **approval adjustment** to the incumbent's share.
- **Data:** MIT Election Lab (state 1976–2020, county 2000–2024); **FRED** (GDP, unemployment, CPI=CPIAUCSL, consumer-confidence=UMCSENT); Silver Bulletin approval.
- **Stack:** pandas/numpy/scikit-learn/xgboost/joblib + PostgreSQL + Streamlit. Light-to-moderate.

### B. TheEconomist/us-potus-model — dynamic Bayesian (R + Stan) · MIT license
The gold standard. Improves Pierre Kremp's build of **Drew Linzer's dynamic linear model (2013)**.
- **Structure:** a **fundamentals PRIOR** (economic + structural, informative state-level, updates through the year) + a **poll LIKELIHOOD** + a **correlated random walk over days** back from Election Day. MCMC (Stan).
- **Three innovations (why it beat 2016 aggregators):** (1) corrections for **partisan non-response, survey mode (phone/online), and population (A/RV/LV)** — kills fake poll "bounces"; (2) **informative updating state priors**; (3) **empirical state-level correlation matrix from political + demographic variables** — pools information (a poll in WA informs OR).
- **Data:** economic fundamentals, historical state results, the full poll stream w/ pollster+mode+population metadata. Backtest: Brier scores, 49/50 states.
- **Stack:** R + Stan (cmdstan). Heavy but bounded; the Stan model file is the asset.

### C. 24cast.org (Brown) — AutoML + Explainable AI (SHAP) · Python
The newest wave; our "glass box" done rigorously.
- **Engine:** automated ML, **100+ features**, weights learned purely from **backtested history (2002+)** — no human-assigned pollster/factor weights. ~100k daily simulations for uncertainty.
- **Features beyond the usual:** campaign-finance data, **state-by-state voting-accessibility laws**, demographics — a much wider feature net.
- **The standout: SHAP (Shapley values)** — cooperative-game-theory attribution telling you *exactly* how much each variable pushed a state's prediction. This is precisely our "parts→whole glass box," but principled.

---

## 2. What they share — the DATA FOUNDATION (this is what we need)

| Data | Source | We have it? |
|---|---|---|
| **Historical election results** (past margins, by state/county/district) | **MIT Election Lab (MEDSL)** via Harvard Dataverse — House 1976–2022, Senate, President county 2000–2024. CC-licensed CSVs. | ❌ **NEED** — this is the Phase-2 past-margin source |
| **Economic fundamentals** | FRED (GDP, unemployment, CPI, **consumer confidence UMCSENT**) | ✅ via api_stream (add UMCSENT — one `DATASETS` line) |
| **Presidential lean by geography** (partisan baseline) | Derived from past pres results; CD-level = **DK Elections 2024-pres-by-CD** | ❌ NEED (state easy; CD needs the DK dataset) |
| **Polls** (w/ pollster/mode/population metadata) | VoteHub + 538 legacy | ✅ have (VoteHub carries population; house-effects in poll_average) |
| **Campaign finance** | FEC | ✅ have (api_stream + Echo bulk) |
| **Approval** | Silver Bulletin / our poll_average | ✅ have (approval poll_average) |
| **Voting-access laws / demographics** | external (24cast) | ⚠ later, lower priority |

**Headline:** the ONE load-bearing thing we're missing is **historical election results** (MIT Election Lab) + a **presidential-lean-by-geography** table (DK Elections). Everything else we already pull. This is exactly the Phase-2 data-acquisition slice — now with confirmed, free, liftable sources.

---

## 3. The METHOD ladder — where we are, what each adds

- **Layer A — our current JS machine:** poll aggregation + correlated Monte-Carlo + fundamentals lean + news reactor + glass box. A working, live, reactive baseline — a simpler cousin of the Economist's aggregate. **Keep as the live/serving layer.**
- **Layer B — fundamentals prior (keithpotz):** learn state/district lean + economic response from historical results → real per-seat priors with quantile CIs. **This IS Lucas's Phase-2 prior model** (past-two-elections = the historical feature; Trump-counter = state_lean/presidential feature; incumbency = is_incumbent/consecutive_terms). His spec independently matches the established approach — good validation.
- **Layer C — dynamic Bayesian (Economist):** fundamentals prior + daily poll updating + state correlation + nonresponse/mode/population corrections. The rigorous version of our reactor+sim. Stan.
- **Layer D — SHAP explainability (24cast):** per-variable attribution over the model → the principled glass box.

**Layers B/C/D need Python** (xgboost, cmdstanpy/Stan, shap). Layer A is our JS. → the honest architecture answer.

---

## 4. THE decision — the Python sidecar

Every "real" method layer (ML, Bayesian, SHAP) lives in the Python/R/Stan ecosystem. Our machine is JS. The pros run exactly this split: a **fast serving/reactive layer** + a **heavy model layer**. So what we need is the **Python sidecar (B0, already parked)**:
- **JS stays** the live layer: news reactor, cadence, VoteHub/FEC/Echo ingestion, the correlated sim for fast what-ifs, the studio, memory-rail emission.
- **Python sidecar runs** the heavy fits offline (XGBoost fundamentals → Layer B; Stan Bayesian → Layer C; SHAP → Layer D) and feeds results back (per-seat priors, CIs, attributions) through a file/IPC contract — same pattern as `api_stream` feeding econ signals in.
- **Footprint is modest:** pandas/numpy/scikit-learn/xgboost/shap (pip); cmdstanpy for the Bayesian capstone. All free, local, offline. No PostgreSQL needed (we have SQLite).

**But note — Phase-2 v1 does NOT require the sidecar.** A per-seat prior from *past-two-election margins + presidential lean + incumbency* is a weighted arithmetic formula — implementable in JS now, fed by the MIT Election Lab data. XGBoost/quantile/Bayesian/SHAP are the *upgrades* the sidecar unlocks. So we can ship a real coverage prior in JS, then graduate to the sidecar for the learned models.

---

## 5. Recommended path (what to build, in order)

1. **Phase-2 DATA acquisition:** ingest **MIT Election Lab** historical results (House/Senate/President, via Harvard Dataverse) into our own store; lift the **DK Elections** 2024-pres-by-CD table; add **FRED UMCSENT** (consumer confidence) to `api_stream.DATASETS`.
2. **Phase-2 prior (JS, Layer B-lite):** per-seat prior = f(past-two-election margin, presidential lean, incumbency) — capped/audited/provisional, replacing the holdover lumps; flag prior-based races for research. Ships the topline-trust fix.
3. **Calibration harness:** backtest the whole chain vs 2014–2024 (Brier/RMSE), the discipline all three share. Gates trust.
4. **Python sidecar (B0):** stand it up → XGBoost fundamentals (Layer B, quantile CIs) → SHAP (Layer D, the principled glass box) → Stan dynamic-Bayesian (Layer C, the capstone). Each MIT-liftable from the two reference repos.

---

## Sources
- keithpotz/Election-Prediction (GitHub, MIT) — XGBoost county-level + FRED + MIT Election Lab.
- TheEconomist/us-potus-model (GitHub, MIT) — dynamic Bayesian R/Stan; Linzer (2013) / Kremp lineage.
- Gelman/Heidemanns/Morris, "An Updated Dynamic Bayesian Forecasting Model for the U.S. Presidential Election," Harvard Data Science Review 2.4 (2020).
- 24cast.org (Brown) — AutoML + SHAP, 100+ features incl. campaign finance + voting-access laws (Brown Daily Herald, 2024-09).
- Data: MIT Election Lab / Harvard Dataverse; FRED (UMCSENT, CPIAUCSL); Daily Kos Elections (pres-by-CD).
