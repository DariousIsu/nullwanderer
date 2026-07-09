'use strict';
/**
 * lib/civic_domain.js — anti-drift domain filter for the civic knowledge graph.
 *
 * The graph exists for LEGISLATORS · BILLS · ORGS/PACs · GOVERNMENT · POLICY ·
 * ELECTIONS. The news + discovery feeds pull from general news, which drags in
 * OFF-DOMAIN entities — sports ("Dave Bowen (footballer)", "World Cup", clubs)
 * and entertainment — that dilute the graph's purpose (the audit's live drift).
 *
 * This is a DENYLIST, not an allowlist: civic is the default, we only reject
 * HIGH-PRECISION off-domain signals so we never drop a legitimate civic entity.
 * Pure + deterministic (no LLM) — a cheap classical guard at the propose gate.
 * A borderline case is KEPT (the operator promotion gate is the backstop).
 */

// High-precision off-domain signals. Chosen to almost never fire on civic text.
const DENY = [
  // Parenthetical disambiguators Wikipedia attaches to non-civic people.
  { re: /\((?:footballer|football player|soccer|cricketer|basketball|baseball|rugby|ice hockey|tennis|golfer|boxer|athlete|sportsperson|singer|actor|actress|musician|rapper|comedian|dj|band|film|album|novel|video game|tv series|racing driver|wrestler)\b[^)]*\)/i, tag: 'paren-role' },
  // Named leagues / competitions / trophies.
  { re: /\b(?:world cup|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league|uefa|fifa|nba|nfl|nhl|mlb|ncaa|super bowl|world series|stanley cup|olympic games|olympics|wimbledon|grand slam|formula 1|grand prix|eurovision|the masters|ryder cup)\b/i, tag: 'league-event' },
  // Sport-specific playing roles (whole word). ONLY unambiguous compounds — words
  // that double as common surnames (striker, winger, bowler, batsman) are excluded
  // so we never reject a person named e.g. "Daniel Striker".
  { re: /\b(?:midfielder|goalkeeper|centre-back|full-back|quarterback|linebacker|cornerback|running back|wide receiver|point guard|shortstop|scrum-half|fly-half)\b/i, tag: 'sport-role' },
  // Football-club shapes: "… F.C.", "A.F.C. …", "… United/City/Rovers/Wanderers/Albion FC".
  { re: /\b(?:a\.?f\.?c\.?|f\.?c\.?)\b/i, tag: 'club-fc' },
  { re: /\b(?:united|city|rovers|wanderers|albion|hotspur|forest|athletic)\s+(?:f\.?c\.?|football club)\b/i, tag: 'club-name' },
];

// A few civic anchors that would otherwise trip a loose deny (keep-list guard).
// e.g. "United States", "Kansas City", "New York City" contain club tokens but
// are civic — the DENY patterns above already require a sports co-token, so
// these pass; this list is a belt-and-suspenders for exact civic names.
const KEEP_EXACT = new Set([
  'united states', 'united states of america', 'united kingdom', 'united nations',
]);

/**
 * isCivic({ name, type, context }) → { civic: boolean, reason: string|null }
 *   name    the entity/principal name
 *   type    optional entity type (unused today; reserved for type-aware rules)
 *   context optional extra text (e.g. the story title) to judge the name in
 */
function isCivic({ name, type = null, context = '' } = {}) {  // eslint-disable-line no-unused-vars
  const n = String(name == null ? '' : name).trim();
  if (!n) return { civic: false, reason: 'empty' };
  if (KEEP_EXACT.has(n.toLowerCase())) return { civic: true, reason: null };
  const hay = `${n} ${String(context || '')}`;
  for (const d of DENY) {
    if (d.re.test(hay)) return { civic: false, reason: d.tag };
  }
  return { civic: true, reason: null };
}

// Convenience boolean.
function isCivicDomain(name, context = '') {
  return isCivic({ name, context }).civic;
}

module.exports = { isCivic, isCivicDomain, DENY, KEEP_EXACT };
