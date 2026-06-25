/**
 * Offline smoke for the Reader/Library view model (studio/doc_view.js): pure mappers over REAL
 * corpus tool shapes captured live (2026-06-25 — list_projects, recent_documents, get_document).
 *
 * Run: node scripts/smoke_doc_view.js
 */
const DV = require('../studio/doc_view');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const PROJECTS = { result: [
  { project_name: 'Op-Eds', project_type: 'output_library', path: 'Vault/Op-Eds', domain: null, document_count: 45 },
  { project_name: 'AI Over AI', project_type: 'research_topic', path: 'Vault/AI Over AI', domain: 'cybersecurity', document_count: 19 },
  { project_name: 'live-events', project_type: 'deliverables', path: 'Vault/Deliverables/live-events', domain: 'rainey-output', document_count: 0 },
] };
const RECENT = { result: [
  { id: 1182, project_name: 'live-events', path: '...\\v1.docx', source_path: '...\\v1.docx', title: 'Senator Mike Lee Town Hall Prep', ingested_at: 1781284168, extraction_method: 'skuld-deliverable' },
  { id: 1181, project_name: '_Inbox', path: 'Vault/_Inbox/2026-06-11-senate-enr.md', source_path: 'Vault/_Inbox/sources/Senate-ENR.pdf', title: 'Senate ENR Hearing', ingested_at: 1781206692, extraction_method: 'pymupdf4llm' },
] };
const DOC = {
  id: 1180, project_name: '_Inbox', path: 'Vault/_Inbox/2026-06-11-datacenter-onepager.md', source_path: 'Vault/_Inbox/sources/datacenter-onepager.docx',
  title: 'datacenter-onepager', extraction_method: 'markitdown', ingested_at: 1781206497,
  frontmatter: { title: 'datacenter-onepager', archive_reason: 'drop-to-open ingest', extraction_method: 'markitdown', source_vault_path: 'Vault/_Inbox/sources/datacenter-onepager.docx', archived_from: 'C:/x/datacenter-onepager.docx' },
  markdown: '**Datacenter Writing Program**\n\n*Three Framings Overview*\n\n**1. "How Will This Not Hurt Me"**\n\nVoters are not asking what a datacenter will do for them.\n\n* What a datacenter actually does to your electric bill\n* What the property value data shows',
};

// --- projects ---
{
  const p = DV.projectList(PROJECTS);
  ok('projects: mapped + sorted by count desc', p.length === 3 && p[0].name === 'Op-Eds' && p[1].name === 'AI Over AI');
  ok('projects: type + domain carried', p[1].type === 'research_topic' && p[1].domain === 'cybersecurity');
  ok('projects: zero-count kept (path-based deliverables)', p.some(x => x.name === 'live-events' && x.count === 0));
}

// --- doc list ---
{
  const d = DV.docList(RECENT);
  ok('docs: mapped', d.length === 2 && d[0].id === 1182);
  ok('docs: title + project', d[0].title === 'Senator Mike Lee Town Hall Prep' && d[0].project === 'live-events');
  ok('docs: ingested ts → ISO date', /^\d{4}-\d{2}-\d{2}$/.test(d[0].date));
  ok('docs: source ext detected', d[0].sourceExt === 'docx' && d[1].sourceExt === 'pdf');
}

// --- reader doc ---
{
  const r = DV.readerDoc(DOC);
  ok('reader: id/title/project', r.id === 1180 && r.title === 'datacenter-onepager' && r.project === '_Inbox');
  ok('reader: body → structured blocks', r.blockCount >= 4 && r.blocks.every(b => b.anchor && b.type));
  ok('reader: list items parsed from body', r.blocks.some(b => b.type === 'list_item' && /electric bill/.test(b.text)));
  ok('reader: source ext = docx', r.sourceExt === 'docx');
  ok('reader: meta keeps archive_reason, drops internal keys', r.meta.some(m => m.key === 'archive_reason') && !r.meta.some(m => m.key === 'source_vault_path' || m.key === 'archived_from' || m.key === 'title'));
  ok('reader: null payload → null', DV.readerDoc(null) === null);
  ok('reader: frontmatter_json fallback parses', DV.readerDoc({ id: 5, title: 't', markdown: '# H', frontmatter_json: '{"status":"active"}' }).meta.some(m => m.key === 'status'));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
