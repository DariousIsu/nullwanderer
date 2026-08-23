'use strict';
/* seed_contract.js — seed the slice-1 live-gate contract (docs/CONTRACT_AGENT_SPEC_2026-08-22.md §13).
 * Three slots on the LA data-center topic: held material (the canvas compilation) suffices, so the
 * unattended loop can fill every cell with real citations. Run against the PRODUCTION store — her
 * tick lists open contracts every pass, so the wave loop picks this up within ~45s. */
const store = require('../lib/contract_store');
const c = store.openContract({
  title: 'LA data-center community benefits — three cells (slice-1 live gate)',
  askVerbatim: 'Fill three cells on the Louisiana data centers: Meta/Richland jobs, the Applied Digital/Rapides project basics, and both facilities\' water commitments. Held material first; cite every figure; label company claims.',
  topicTokens: ['meta', 'applied', 'digital', 'louisiana', 'richland', 'rapides', 'hyperion', 'delta', 'forge'],
  entities: ['Meta Hyperion', 'Applied Digital Delta Forge'],
  budget: { maxWaves: 8 },
});
store.upsertSlot({ contractId: c.contractId, slotId: 'richland-jobs', description: 'Meta Hyperion (Richland Parish): construction + permanent jobs, cited' });
store.upsertSlot({ contractId: c.contractId, slotId: 'rapides-project', description: 'Applied Digital Delta Forge (Rapides Parish): investment, jobs, timeline, cited' });
store.upsertSlot({ contractId: c.contractId, slotId: 'water-commitments', description: 'Water: both facilities\' stated commitments, company claims labeled as such' });
console.log('seeded', c.contractId);
store.close();
