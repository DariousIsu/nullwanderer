'use strict';
/**
 * lib/civic_domain.js — civic-domain PRIORITY TAG for the knowledge graph.
 *
 * The graph's CORE is LEGISLATORS · BILLS · ORGS/PACs · GOVERNMENT · POLICY ·
 * ELECTIONS. This classifier flags whether an entity/story sits in that core or
 * is OFF-DOMAIN (sports, entertainment). It is a SIGNAL, not a filter: the graph
 * is living and absorbs everything it's handed — a World-Cup match can be a major
 * political story, a celebrity's connections matter — so nothing is ever dropped
 * on topic. Consumers use this only to TAG proposals (so the operator can sort the
 * civic core to the top) and to prioritize the subconscious walk toward Lucas's
 * neighborhood. Quality lives on the CONFIDENCE axis (is it true/well-sourced),
 * which is orthogonal to topic; the promotion gate + operator are the backstops.
 *
 * This is a DENYLIST: civic is the default, only HIGH-PRECISION off-domain signals
 * flag off-domain. Pure + deterministic (no LLM). A borderline case tags civic.
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
