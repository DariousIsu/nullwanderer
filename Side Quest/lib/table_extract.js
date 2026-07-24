/**
 * lib/table_extract.js — turn a markdown TABLE (the shape a spreadsheet/CSV decomposes into) into a
 * grouped, presentable ANSWER. Built for the roster homecoming (inquiry #1): the held doc's body IS
 * the answer — a 6,694-row markdown table of every Louisiana elected official — but the operator kept
 * emitting a QUERY to extract it instead of the extracted TABLE, because the held-source hint fed it a
 * structure SUMMARY, never the rows. This extracts the rows so the hint can inject the ANSWER itself.
 *
 * Generic + pure + offline (no DB, no model): parseMarkdownTable → {headers, rows}; pivot groups rows
 * by a column into role→name pairs (dropping noise roles via an exclude pattern — e.g. party
 * committees, which are not government); digestByGroup renders a compact one-line-per-group summary,
 * ordering the roles the caller cares about first. The caller picks the columns and the role order —
 * nothing here is domain-specific (top-down containment applied to data, not a per-domain channel).
 */
'use strict';
const str = (v) => (v == null ? '' : String(v));

// Parse a GitHub-style markdown table into {headers:[], rows:[{header:value}]}. Tolerant: skips the
// separator row, ignores non-table lines, trims the empty cells the leading/trailing pipes produce.
function parseMarkdownTable(text) {
  const lines = str(text).split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return { headers: [], rows: [] };
  const cells = (l) => { const p = l.split('|'); return p.slice(1, p.length - 1).map((s) => s.trim()); };
  const headers = cells(lines[0]);
  if (headers.length < 2) return { headers: [], rows: [] };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^\|\s*:?-{2,}/.test(lines[i])) continue;              // separator row
    const c = cells(lines[i]);
    if (!c.length || c.every((x) => !x)) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = c[j] == null ? '' : c[j];
    rows.push(obj);
  }
  return { headers, rows };
}

// Group rows by groupCol; collect {role, name} from roleCol/nameCol. Drops rows whose role matches
// excludeRole (RegExp) or whose group/role/name is blank. Returns Map<group, [{role,name}]>.
function pivot({ rows, groupCol, roleCol, nameCol, excludeRole = null } = {}) {
  const out = new Map();
  for (const r of (rows || [])) {
    const g = str(r[groupCol]).trim(), role = str(r[roleCol]).trim(), name = str(r[nameCol]).trim();
    if (!g || !role || !name) continue;
    if (excludeRole && excludeRole.test(role)) continue;
    if (!out.has(g)) out.set(g, []);
    out.get(g).push({ role, name });
  }
  return out;
}

// One compact line per group: roles in roleOrder first (each collapsed to "Role — name[, name…]"),
// a repeated role rendered "Role (N) — n1, n2…". Roles not in roleOrder are dropped when roleOrder is
// given (that IS the governing/relevant filter), else all roles show. maxNames caps names per role.
function digestByGroup(map, { roleOrder = [], maxNames = 3, cite = null } = {}) {
  const order = roleOrder.map((r) => r.toLowerCase());
  const rank = (role) => { const i = order.indexOf(str(role).toLowerCase()); return i < 0 ? 999 : i; };
  const lines = [];
  for (const group of [...map.keys()].sort()) {
    const byRole = new Map();
    for (const { role, name } of map.get(group)) {
      if (roleOrder.length && rank(role) === 999) continue;    // roleOrder acts as the include filter
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(name);
    }
    if (!byRole.size) continue;
    const parts = [...byRole.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([role, names]) => {
      const shown = names.slice(0, maxNames).join(', ') + (names.length > maxNames ? `, +${names.length - maxNames} more` : '');
      return names.length > 1 ? `${role} (${names.length}) — ${shown}` : `${role} — ${shown}`;
    });
    lines.push(`- **${group}**: ${parts.join(' · ')}`);
  }
  const head = `| ${map.size} groups |` + (cite ? ` cited to ${cite}` : '');
  return { lines, text: lines.join('\n'), groups: map.size };
}

// ── officialsAnswer — the shared "roster table → grouped leadership answer" (used by the inquiry
// homecoming AND the chat-path homecoming). Detects the group/role/name columns, drops party
// committees (not government), orders the governing body first. Returns { text, groups, groupCol } or
// null when the body is not a recognizable officials roster. THE single source of truth for the extract.
const PARTY_COMMITTEE = /committee member|\b[DR][PS](?:EC|CC) member\b/i;
const OFFICIALS_ROLE_ORDER = ['Parish President', 'Police Juror', 'Council Member', 'Councilman', 'Councilmember', 'Council Member at Large', 'Councilman at Large', 'Councilmember at Large', 'Mayor', 'Sheriff', 'Clerk of Court', 'Assessor', 'Coroner', 'District Attorney'];
function detectCol(headers, re) { return (headers || []).find((h) => re.test(str(h))) || null; }
function officialsAnswer(body, { cite = null, roleOrder = OFFICIALS_ROLE_ORDER, excludeRole = PARTY_COMMITTEE, minGroups = 3 } = {}) {
  const parsed = parseMarkdownTable(body);
  if (!parsed.rows || parsed.rows.length < 5) return null;
  const groupCol = detectCol(parsed.headers, /parish|county|borough|municipalit|district/i);
  const roleCol = detectCol(parsed.headers, /office title|^title$|position|\brole\b/i);
  const nameCol = detectCol(parsed.headers, /candidate name|^name$|official|incumbent|member name/i);
  if (!groupCol || !roleCol || !nameCol) return null;
  const map = pivot({ rows: parsed.rows, groupCol, roleCol, nameCol, excludeRole });
  if (map.size < minGroups) return null;
  const dig = digestByGroup(map, { roleOrder, maxNames: 3, cite });
  if (!dig.lines || !dig.lines.length) return null;
  return { text: dig.text, groups: dig.groups, groupCol };
}

module.exports = { parseMarkdownTable, pivot, digestByGroup, officialsAnswer, detectCol, PARTY_COMMITTEE, OFFICIALS_ROLE_ORDER };
