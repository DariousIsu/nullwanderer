/**
 * LIVE-FIRE the local document extractors (lib/doc_extract.js) against REAL binary files on disk:
 * a .docx (mammoth) and a .pdf (pdfjs-dist), through the full pipeline binary → markdown →
 * editor_import.normalizeMarkdown → structured blocks. Proves the writing-suite substrate's import
 * side end to end. Override paths with argv[2] (.docx) / argv[3] (.pdf).
 *
 * Run: node scripts/livefire_doc_extract.js
 */
const DX = require('../lib/doc_extract');
const EI = require('../lib/editor_import');

const DOCX = process.argv[2] || 'C:/Users/azrae/Desktop/Claude/Work/consulting_services.docx';
const PDF = process.argv[3] || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/mcps/rainey/vault/files/AI Policy/research/Jevons_Paradox_AI_Datacenters.pdf';

(async () => {
  for (const [label, file] of [['docx', DOCX], ['pdf', PDF]]) {
    try {
      const t0 = Date.now();
      const ext = await DX.extractToMarkdown(file);
      const wc = EI.normalizeMarkdown(ext.markdown, { format: ext.format });
      const byType = {};
      for (const b of wc.blocks) byType[b.type] = (byType[b.type] || 0) + 1;
      console.log(`\n[${label}] ${file.split(/[\\/]/).pop()} — ${((Date.now() - t0) / 1000).toFixed(1)}s${ext.pages ? ` · ${ext.pages} pages` : ''}`);
      console.log(`  markdown: ${ext.markdown.length} chars → ${wc.blocks.length} blocks ${JSON.stringify(byType)}`);
      console.log(`  title: "${wc.title}"`);
      console.log(`  first blocks: ${wc.blocks.slice(0, 3).map(b => `[${b.type}] ${(b.text || '').slice(0, 60)}`).join(' | ')}`);
    } catch (e) {
      console.error(`[${label}] FAILED on ${file}: ${e.message}`);
    }
  }
  process.exit(0);
})();
