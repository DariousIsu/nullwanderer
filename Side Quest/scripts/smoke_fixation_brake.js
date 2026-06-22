/** R4 — cluster-density brake: deepening (sparse related vein) passes; a dense fixation cluster
 *  (the water-shortage loop) brakes, even when no single pair hits the 0.82 near-dup threshold.
 *  Vectors model near-variants: shared dominant axis e0 + a distinct orthogonal component each,
 *  tuned so intra-vein pairwise cosine ≈ 0.75 (below 0.82, above the 0.62 cluster line). */
const os=require('os'),path=require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_fix_${Date.now()}`,'sq.db');
require('../lib/db').init();
const A = require('../lib/monologue').assessSearchNovelty;
let pass=0,fail=0; const ok=(n,c)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n));};

const D=10, B=0.577; // b=a/√3 → cosine(member_i,member_j)=1/(1+1/3)=0.75 on shared e0
const unit=(arr)=>{const n=Math.hypot(...arr)||1;return arr.map(x=>x/n);};
const veinMember=(i)=>{const a=Array(D).fill(0); a[0]=1; a[i]=B; return unit(a);}; // shares e0, distinct e_i
const ortho=(i)=>{const a=Array(D).fill(0); a[i]=1; return a;}; // unrelated: orthogonal to e0
const waterVein=[veinMember(1),veinMember(2),veinMember(3),veinMember(4),veinMember(5)];
const unrelated=[ortho(6),ortho(7),ortho(8)];
const candidate=veinMember(9); // new water variant: ~0.75 to each vein member, 0 to unrelated

let r=A(candidate, waterVein);
ok(`fixation cluster braked (cluster=${r.clusterCount}, maxSim=${r.maxSim.toFixed(2)})`, r.suppress && r.fixated);
ok('  ...via cluster density, NOT a single near-dup', !r.nearDup && r.maxSim < 0.82);
r=A(candidate, waterVein.slice(0,2));
ok(`early deepening passes (cluster=${r.clusterCount})`, !r.suppress);
r=A(ortho(6), waterVein);
ok(`a genuinely new domain passes (cluster=${r.clusterCount})`, !r.suppress);
r=A(veinMember(1), [veinMember(1), ...unrelated]);
ok(`outright near-dup still braked (maxSim=${r.maxSim.toFixed(2)})`, r.suppress && r.nearDup);
r=A(candidate, [...waterVein.slice(0,3), ...unrelated]);
ok(`3-in-vein amid other interests still deepens (cluster=${r.clusterCount})`, !r.suppress);

console.log('\n'+(fail===0?'ALL PASS':'FAILURES')+` — ${pass} passed, ${fail} failed`);
try{require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH),{recursive:true,force:true});}catch{}
process.exit(fail===0?0:1);
