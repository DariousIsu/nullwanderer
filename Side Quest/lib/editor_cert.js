/**
 * lib/editor_cert.js — Editor Studio "Certify" issuance (B4).
 *
 * The terminal QA action: turn a completed verification pass ({findings, suggestions, summary})
 * into a CANONICAL, logged certificate. Deterministic end to end — the cert number, the grade,
 * the rendered HTML are all pure functions of the structured findings + the clock:
 *
 *   1. cert number  CFC-YYYY-MM-DD-<rev>  (registry.nextCertSeq → collision-free daily sequence)
 *   2. grade + scoreline  derived from summary.byVerdict (studio/cert_template.gradeFor)
 *   3. render  studio/cert_template.renderCertificate (standardized B5 template)
 *   4. write   <certsDir>/<certNumber>.html
 *   5. log     registry.attachCertificate → certificates row + doc.cert_number + status→certified
 *
 * The findings are passed IN (from the renderer's last Run-checks result) — issuance never re-runs
 * verification. Re-audits pass parentCertId to chain to the prior cert.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const registry = require('./editor_registry');
const certTemplate = require('../studio/cert_template');

/**
 * Issue a certificate for a document from a completed verification result.
 * @param {object} a
 *   docId         (REQUIRED) pipeline_documents.id
 *   mapped        (REQUIRED) { findings, suggestions, summary } from runHarnessChecks
 *   certsDir      directory to write the cert HTML into (default ./data/certs)
 *   checkRunId, verificationSessionId, parentCertId   optional provenance links
 *   reaudit       label the cert as a re-audit (default: parentCertId != null)
 *   now           clock injector (default Date.now) — keeps issuance testable/deterministic
 *   writeFile     fs.writeFileSync injector (default real)
 * @returns {{ certNumber, certDocRef, grade, scoreline, certId, html }}
 */
function issueCertificate(a = {}) {
  const { docId, mapped, checkRunId = null, verificationSessionId = null, parentCertId = null } = a;
  if (docId == null) throw new Error('issueCertificate: docId is required');
  if (!mapped || !mapped.summary || !Array.isArray(mapped.findings)) throw new Error('issueCertificate: mapped {findings, summary} is required');

  const doc = registry.getDocument(docId);
  if (!doc) throw new Error(`issueCertificate: no document ${docId}`);

  const now = typeof a.now === 'function' ? a.now : Date.now;
  const writeFile = typeof a.writeFile === 'function' ? a.writeFile : ((p, c) => fs.writeFileSync(p, c, 'utf8'));
  const certsDir = a.certsDir || path.join(process.cwd(), 'data', 'certs');
  const reaudit = a.reaudit != null ? a.reaudit : (parentCertId != null);

  const issuedAt = now();
  const dateStr = registry.dateStamp(issuedAt);
  const certNumber = registry.formatCertNumber(dateStr, registry.nextCertSeq(dateStr));

  const grade = certTemplate.gradeFor(mapped.summary);
  const scoreline = certTemplate.scorelineOf(mapped.summary);

  const html = certTemplate.renderCertificate({
    doc, findings: mapped.findings, suggestions: mapped.suggestions, summary: mapped.summary,
    certNumber, issuedAt, reaudit,
  });

  try { fs.mkdirSync(certsDir, { recursive: true }); } catch (e) { /* may already exist */ }
  const certDocRef = path.join(certsDir, `${certNumber}.html`);
  writeFile(certDocRef, html);

  const certId = registry.attachCertificate(docId, {
    certNumber, parentCertId, verificationSessionId, checkRunId,
    grade: grade.key, scoreline, certDocRef,
  });

  return { certNumber, certDocRef, grade: grade.key, gradeLabel: grade.label, scoreline, certId, html };
}

module.exports = { issueCertificate };
