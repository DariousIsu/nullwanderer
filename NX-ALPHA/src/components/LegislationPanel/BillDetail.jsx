/**
 * BillDetail
 *
 * Right slide-in panel (~400px) showing full detail for the selected bill.
 * Renders from `billDetail` (full fetch) when available, falls back to the
 * shallow `bill` list item while the detail fetch is in flight.
 *
 * SECTIONS:
 *   Header        — identifier, status badge, chamber label, close button
 *   Title         — full bill title
 *   Subjects      — tag chips parsed from bill.subjects (JSON string or array)
 *   Sponsors      — primary (bold) + co-sponsors
 *   Abstract      — if available
 *   Action timeline — bill_actions, most-recent first
 *   Source links  — clickable external links
 *   AI Commentary — request button → streaming tokens via POST ReadableStream
 *   Open in Agent Creator — navigates to 'agents' drop panel
 *
 * @param {object}      bill              — shallow bill from list (always present)
 * @param {object|null} billDetail        — full bill from detail endpoint (may be null while loading)
 * @param {string}      context           — 'personal' | 'client'
 * @param {function}    onClose           — () => void
 * @param {function}    onRequestCommentary — () => void
 * @param {boolean}     commentaryLoading — true while SSE stream is active
 * @param {string}      commentaryTokens  — accumulated streamed tokens
 * @param {function}    onOpenAgents      — () => void — opens Agent Creator panel
 */
import styles from './LegislationPanel.module.css';

// ── ICONS ────────────────────────────────────────────────────────────────────

const IconClose = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

const IconSparkle = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M5 1v2M5 7v2M1 5h2M7 5h2M2.5 2.5l1.4 1.4M6.1 6.1l1.4 1.4M7.5 2.5L6.1 3.9M3.9 6.1L2.5 7.5"
      stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
  </svg>
);

const IconExternal = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
    <path d="M3.5 1.5H1.5v6h6V5.5M5 1.5H7.5v2.5M4 5L7.5 1.5"
      stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const IconAgents = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <circle cx="5" cy="5" r="1.5" stroke="currentColor" strokeWidth="1.1"/>
    <circle cx="1.5" cy="1.5" r="1" stroke="currentColor" strokeWidth="1"/>
    <circle cx="8.5" cy="1.5" r="1" stroke="currentColor" strokeWidth="1"/>
    <circle cx="1.5" cy="8.5" r="1" stroke="currentColor" strokeWidth="1"/>
    <circle cx="8.5" cy="8.5" r="1" stroke="currentColor" strokeWidth="1"/>
    <path d="M2.2 2.2l2.1 2.1M7.8 2.2L5.7 4.3M2.2 7.8l2.1-2.1M7.8 7.8L5.7 5.7"
      stroke="currentColor" strokeWidth=".9" opacity=".6"/>
  </svg>
);

// ── STATUS BADGE ─────────────────────────────────────────────────────────────

const STATUS_CLASS = {
  active:  styles.badgeActive,
  pending: styles.badgePending,
  passed:  styles.badgePassed,
  dropped: styles.badgeDropped,
};

function StatusBadge({ status }) {
  return (
    <span className={[styles.billStatusBadge, STATUS_CLASS[status] ?? styles.badgeUnknown].join(' ')}>
      {status ?? 'unknown'}
    </span>
  );
}

// ── SUBJECT PARSING ───────────────────────────────────────────────────────────

function parseSubjects(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

// ── BILL DETAIL ───────────────────────────────────────────────────────────────

export default function BillDetail({
  bill,
  billDetail           = null,
  context              = 'personal',
  onClose,
  onRequestCommentary,
  onRequestDeepResearch,
  commentaryLoading    = false,
  commentaryTokens     = '',
  onOpenAgents,
}) {
  // Use full detail when available, fall back to shallow list item
  const data = billDetail ?? bill;
  if (!data) return null;

  const subjects   = parseSubjects(data.subjects);
  const sponsors   = data.sponsors   ?? [];
  const actions    = data.actions    ?? [];
  const sources    = data.sources    ?? [];
  const primary    = sponsors.find(s => s.primary_sponsor);
  const coSponsors = sponsors.filter(s => !s.primary_sponsor);

  // Actions: most-recent first
  const sortedActions = [...actions].sort((a, b) =>
    (b.date ?? '').localeCompare(a.date ?? '')
  );

  const isLoading = !billDetail;

  return (
    <div className={styles.detail}>

      {/* ── HEADER ── */}
      <div className={styles.detailHeader}>
        <div className={styles.detailMeta}>
          <div className={styles.detailIdRow}>
            <span className={styles.detailId}>{data.identifier}</span>
            <StatusBadge status={data.status} />
            {data.chamber && (
              <span className={styles.detailChamber}>{data.chamber}</span>
            )}
          </div>
        </div>
        <button
          className={styles.detailClose}
          onClick={onClose}
          aria-label="Close bill detail"
          title="Close"
        >
          <IconClose />
        </button>
      </div>

      {/* ── SCROLLABLE BODY ── */}
      {isLoading ? (
        <div className={styles.detailLoading}>Loading…</div>
      ) : (
        <div className={styles.detailScroll}>

          {/* Title */}
          <div className={styles.detailSection}>
            <p className={styles.detailTitle}>{data.title}</p>
          </div>

          {/* Subjects */}
          {subjects.length > 0 && (
            <div className={styles.detailSection}>
              <div className={styles.sectionLabel}>Subjects</div>
              <div className={styles.subjects}>
                {subjects.map((s, i) => (
                  <span key={i} className={styles.subjectChip}>{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Sponsors */}
          {sponsors.length > 0 && (
            <div className={styles.detailSection}>
              <div className={styles.sectionLabel}>Sponsors</div>
              {primary && (
                <div className={styles.primarySponsor}>{primary.name}</div>
              )}
              {coSponsors.length > 0 && (
                <div className={styles.cosponsorList}>
                  {coSponsors.slice(0, 8).map((s, i) => (
                    <span key={i} className={styles.cosponsor}>{s.name}</span>
                  ))}
                  {coSponsors.length > 8 && (
                    <span className={styles.cosponsor}>
                      +{coSponsors.length - 8} more
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Abstract */}
          {data.abstract && (
            <div className={styles.detailSection}>
              <div className={styles.sectionLabel}>Abstract</div>
              <p className={styles.abstract}>{data.abstract}</p>
            </div>
          )}

          {/* Action Timeline */}
          {sortedActions.length > 0 && (
            <div className={styles.detailSection}>
              <div className={styles.sectionLabel}>Actions</div>
              <div className={styles.timeline}>
                {sortedActions.map((a, i) => (
                  <div key={i} className={styles.timelineItem}>
                    <span className={styles.actionDate}>{a.date ?? '—'}</span>
                    <div>
                      <div className={styles.actionDesc}>{a.description}</div>
                      {a.classification && (
                        <div className={styles.actionClass}>{a.classification}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Source Links */}
          {sources.length > 0 && (
            <div className={styles.detailSection}>
              <div className={styles.sectionLabel}>Sources</div>
              <div className={styles.sourceLinks}>
                {sources.map((src, i) => (
                  <a
                    key={i}
                    href={src.url}
                    className={styles.sourceLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={src.url}
                  >
                    <IconExternal /> {src.note || src.url}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* AI Commentary */}
          <div className={styles.detailSection}>
            <div className={styles.sectionLabel}>
              AI Commentary
              {context === 'client' ? ' — Client' : ' — Personal'}
            </div>

            {!commentaryTokens && !commentaryLoading && (
              <button
                className={styles.commentaryBtn}
                onClick={onRequestCommentary}
                disabled={commentaryLoading}
              >
                <IconSparkle />
                Quick Summary
              </button>
            )}

            {(commentaryTokens || commentaryLoading) && (
              <div className={styles.commentaryStream}>
                {commentaryTokens}
                {commentaryLoading && (
                  <span className={styles.commentaryCursor} aria-hidden="true" />
                )}
              </div>
            )}

            {/* Deep Research */}
            <button
              className={styles.deepResearchBtn}
              onClick={onRequestDeepResearch}
              title="Spin up a full research brief in the main chat"
            >
              <IconSparkle />
              Deep Research
            </button>

            {/* Open in Agent Creator */}
            <button
              className={styles.agentsLink}
              onClick={onOpenAgents}
              title="Open Agent Creator"
            >
              <IconAgents />
              Open in Agent Creator
            </button>
          </div>

        </div>
      )}
    </div>
  );
}
