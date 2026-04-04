/**
 * AURA NX-Alpha — NewsPanel (Intel Feed v4)
 *
 * LAYOUT:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  FEED WALL  — 5 live/video slots (paginated ÷ 12)   │
 *   ├──── feed selector strip ────────────────────────────┤
 *   │  THE INTEL DISPATCH                                  │
 *   │    [ticker] [tabs]                                  │
 *   │    [featured] | [recent] | [trending]               │
 *   └─────────────────────────────────────────────────────┘
 *
 * OVERLAYS:
 *   StoryReader — slide-up article overlay
 *   FeedModal   — enlarged 16:9 video slot
 *
 * Data: stub until backend RSS/API connectors are live.
 * Feed source config lives in SettingsPanel → Intel Feed section.
 */

import { useState, useEffect, useRef } from 'react';
import styles from './NewsPanel.module.css';
import { useNews, useIntelligenceFeed, useIntelligenceSources } from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// FEED SOURCES — 15-20 curated news channels for Intel tab
// streamUrl: Haystack.tv channel page (preferred) or YouTube live fallback
// ─────────────────────────────────────────────────────────────────────────────

const FEED_SOURCES = [
  { id: 'reuters',    label: 'Reuters',      icon: 'R',  status: 'live',    streamUrl: 'https://www.haystack.tv/channel/reuters' },
  { id: 'bloomberg',  label: 'Bloomberg',    icon: 'B',  status: 'live',    streamUrl: 'https://www.haystack.tv/channel/bloomberg-television' },
  { id: 'cnbc',       label: 'CNBC',         icon: 'C',  status: 'live',    streamUrl: 'https://www.haystack.tv/channel/cnbc' },
  { id: 'bbc',        label: 'BBC World',    icon: 'W',  status: 'live',    streamUrl: 'https://www.haystack.tv/channel/bbc-news' },
  { id: 'al_jazeera', label: 'Al Jazeera',   icon: 'AJ', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/al-jazeera' },
  { id: 'cnn',        label: 'CNN',          icon: 'CN', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/cnn' },
  { id: 'fox_news',   label: 'Fox News',     icon: 'FX', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/fox-news' },
  { id: 'msnbc',      label: 'MSNBC',        icon: 'MS', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/msnbc' },
  { id: 'abc_news',   label: 'ABC News',     icon: 'AB', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/abc-news' },
  { id: 'cbs_news',   label: 'CBS News',     icon: 'CB', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/cbs-news' },
  { id: 'nbc_news',   label: 'NBC News',     icon: 'NB', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/nbc-news' },
  { id: 'france24',   label: 'France 24',    icon: 'F24', status: 'live',   streamUrl: 'https://www.haystack.tv/channel/france-24' },
  { id: 'euronews',   label: 'Euronews',     icon: 'EU', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/euronews' },
  { id: 'dw',         label: 'DW News',      icon: 'DW', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/dw' },
  { id: 'newsmax',    label: 'Newsmax',      icon: 'NM', status: 'live',    streamUrl: 'https://www.haystack.tv/channel/newsmax' },
];

const CATEGORIES = [
  { id: 'all',        label: 'All' },
  { id: 'markets',    label: 'Markets' },
  { id: 'technology', label: 'Technology' },
  { id: 'geopolitics',label: 'Geopolitics' },
  { id: 'ai',         label: 'AI' },
  { id: 'crypto',     label: 'Crypto' },
  { id: 'science',    label: 'Science' },
];

const TICKER_ITEMS = [
  'FED HOLDS RATES — FOMC statement released at 14:00 EST',
  'S&P 500 +0.6% — Energy sector leads gains on crude rally',
  'BREAKING: EU Parliament passes AI Liability Directive, 412–189',
  'BTC $72,400 +2.1% — ETF inflows extend 8-day streak',
  'Anthropic releases Claude 4.5 with 200K context window',
  'TSMC Q1 revenue beats: $19.6B vs $18.9B est — AI demand cited',
  'Ukraine ceasefire talks stalled — G7 emergency session called',
  'OpenAI in talks to acquire Cursor for $2.5B — sources',
  'Gold hits record $3,250/oz amid dollar weakness',
  'NVDA +3.4% pre-market after analyst raises PT to $1,200',
];

const STORIES = [
  {
    id: 's1',
    source: 'reuters',
    category: 'markets',
    headline: 'Fed signals two rate cuts likely in 2026 as inflation holds near target',
    snippet: 'Federal Reserve officials indicated Wednesday they expect to lower interest rates twice this year, maintaining their projection despite persistent services inflation hovering above the 2% target. Chair Powell emphasized patience in a press conference following the FOMC decision.',
    body: 'Federal Reserve officials indicated Wednesday they expect to lower interest rates twice this year, maintaining their projection despite persistent services inflation. Speaking at a press conference after the Federal Open Market Committee held its benchmark rate steady in a 4.25%–4.5% range, Chair Jerome Powell said the central bank was "well positioned to wait" before adjusting policy further.\n\nThe Fed\'s so-called dot plot, the summary of individual officials\' rate projections, showed the median expectation for two quarter-point cuts by year-end — unchanged from December. However, the number of officials projecting just one cut or none at all increased slightly, reflecting unease about lingering price pressures in services and shelter.\n\n"We do not need to be in a hurry to adjust our policy stance," Powell told reporters. "The economy continues to perform well, and the labor market remains solid." Core PCE inflation — the Fed\'s preferred gauge — stood at 2.8% in February, still above the 2% target.',
    time: '6m ago',
    readTime: '4 min',
    urgent: true,
    image: null,
    tag: 'MACRO',
  },
  {
    id: 's2',
    source: 'bloomberg',
    category: 'markets',
    headline: 'S&P 500 edges higher as earnings season opens with mixed bank results',
    snippet: 'Major US equity indices gained modestly Thursday after JPMorgan and Wells Fargo reported quarterly results that beat analyst estimates on trading revenue.',
    body: 'Major US equity indices gained modestly Thursday after JPMorgan Chase & Co. and Wells Fargo & Co. reported first-quarter results that beat analyst estimates on trading revenue but fell slightly short on net interest income.',
    time: '18m ago',
    readTime: '3 min',
    urgent: false,
    image: null,
    tag: 'MARKETS',
  },
  {
    id: 's3',
    source: 'techcrunch',
    category: 'ai',
    headline: 'Anthropic raises $3.5B Series E, valuation climbs to $61B',
    snippet: 'The AI safety company announced a new funding round led by Spark Capital, with participation from Google and Salesforce Ventures.',
    body: 'Anthropic, the AI safety company, has raised $3.5 billion in a new funding round led by Spark Capital, pushing its valuation to approximately $61 billion. The Series E also includes participation from Google, which remains the company\'s largest outside investor, and Salesforce Ventures.',
    time: '34m ago',
    readTime: '5 min',
    urgent: false,
    image: null,
    tag: 'AI',
  },
  {
    id: 's4',
    source: 'ars',
    category: 'technology',
    headline: "Apple's M4 Ultra delivers 40% CPU performance gain in sustained workloads",
    snippet: 'Detailed benchmarks from Mac Studio units shipping this week show that the M4 Ultra sustains performance levels previously only achievable in brief burst scenarios.',
    body: 'Detailed benchmarks from Mac Studio units shipping this week show that the M4 Ultra chip sustains performance levels that its predecessors could only achieve in brief burst scenarios — a meaningful shift for workloads that demand minutes or hours of peak throughput.',
    time: '1h ago',
    readTime: '6 min',
    urgent: false,
    image: null,
    tag: 'TECH',
  },
  {
    id: 's5',
    source: 'reuters',
    category: 'geopolitics',
    headline: 'EU proposes new digital services levy targeting large language model operators',
    snippet: 'The European Commission published a draft framework that would impose per-query fees on frontier AI systems deployed in member states.',
    body: 'The European Commission published a draft framework Thursday that would impose per-query fees on frontier AI systems deployed in member states, with revenue earmarked for national digital infrastructure funds.',
    time: '2h ago',
    readTime: '4 min',
    urgent: false,
    image: null,
    tag: 'GEOPOLITICS',
  },
  {
    id: 's6',
    source: 'hn',
    category: 'technology',
    headline: 'Show HN: I built a local-first SQLite sync engine for multi-device apps',
    snippet: 'A developer released an open-source library enabling conflict-free replication of SQLite databases across devices without a central server.',
    body: 'A developer released an open-source library enabling conflict-free replication of SQLite databases across devices without a central server, using CRDTs and a gossip protocol.',
    time: '3h ago',
    readTime: '2 min',
    urgent: false,
    image: null,
    tag: 'DEV',
  },
  {
    id: 's7',
    source: 'bloomberg',
    category: 'markets',
    headline: 'Private credit markets reach $2.3T as banks retreat from leveraged lending',
    snippet: 'Direct lending funds now account for the majority of leveraged buyout financing in North America, a structural shift accelerating as Basel III takes effect.',
    body: 'Private credit markets have grown to $2.3 trillion in assets, cementing their position as the dominant source of leveraged buyout financing in North America as traditional banks continue pulling back amid Basel III capital requirements.',
    time: '4h ago',
    readTime: '7 min',
    urgent: false,
    image: null,
    tag: 'MARKETS',
  },
  {
    id: 's8',
    source: 'arxiv',
    category: 'science',
    headline: 'Researchers demonstrate room-temperature superconductivity in hydrogen-rich compound at 1.4 GPa',
    snippet: 'A team at MIT claims to have achieved superconductivity at 22°C using a novel lutetium-hydrogen-nitrogen compound under moderate pressure.',
    body: 'A research team at MIT claims to have achieved superconductivity at room temperature using a novel lutetium-hydrogen-nitrogen compound under moderate pressure.',
    time: '5h ago',
    readTime: '8 min',
    urgent: false,
    image: null,
    tag: 'SCIENCE',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _relativeTime(date) {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Strip HTML tags from RSS descriptions (e.g. Hacker News, arXiv)
function _stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function _guessCategory(tags) {
  const t = tags.join(' ').toLowerCase();
  if (t.includes('market') || t.includes('stock') || t.includes('finance')) return 'markets';
  if (t.includes('tech') || t.includes('ai') || t.includes('software')) return 'technology';
  if (t.includes('crypto') || t.includes('bitcoin') || t.includes('eth')) return 'crypto';
  if (t.includes('science') || t.includes('research')) return 'science';
  if (t.includes('politic') || t.includes('geopolitic') || t.includes('war')) return 'geopolitics';
  return 'all';
}

// ─────────────────────────────────────────────────────────────────────────────
// FEED SELECTOR — horizontal chip strip
// ─────────────────────────────────────────────────────────────────────────────

const FeedSelector = ({ feeds, activeFeed, onSelect }) => {
  const scrollRef = useRef(null);

  return (
    <div className={styles.feedSelector}>
      <div className={styles.feedSelectorLabel}>FEEDS</div>
      <div className={styles.feedChips} ref={scrollRef}>
        <button
          className={`${styles.feedChip} ${activeFeed === 'all' ? styles.feedChipActive : ''}`}
          onClick={() => onSelect('all')}
        >
          <span className={`${styles.chipDot} ${styles.chipDotAll}`} />
          All
        </button>
        {feeds.map(feed => (
          <button
            key={feed.id}
            className={`${styles.feedChip} ${activeFeed === feed.id ? styles.feedChipActive : ''}`}
            onClick={() => onSelect(feed.id)}
            data-status={feed.status}
          >
            <span className={`${styles.chipDot} ${styles[`chipDot_${feed.status}`]}`} />
            {feed.label}
          </button>
        ))}
      </div>
      <div className={styles.feedSelectorRight}>
        <span className={styles.feedCount}>
          {feeds.filter(f => f.status === 'live').length} live
        </span>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TICKER TAPE
// ─────────────────────────────────────────────────────────────────────────────

const TickerTape = ({ items }) => {
  const doubled = [...items, ...items]; // seamless loop

  return (
    <div className={styles.ticker} aria-label="Breaking news ticker" role="marquee">
      <div className={styles.tickerBadge}>BREAKING</div>
      <div className={styles.tickerTrack}>
        <div className={styles.tickerInner}>
          {doubled.map((item, i) => (
            <span key={i} className={styles.tickerItem}>
              {item}
              <span className={styles.tickerDivider} aria-hidden="true"> ◆ </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// STORY CARD
// ─────────────────────────────────────────────────────────────────────────────

const StoryCard = ({ story, variant = 'regular', onClick }) => {
  const cls = [
    styles.storyCard,
    variant === 'featured' && styles.storyCardFeatured,
    variant === 'compact'  && styles.storyCardCompact,
  ].filter(Boolean).join(' ');

  return (
    <article className={cls} onClick={() => onClick(story)} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick(story)}
      aria-label={`Read: ${story.headline}`}
    >
      {story.urgent && (
        <div className={styles.breakingBadge}>BREAKING</div>
      )}
      {story.image && variant !== 'compact' && (
        <div className={styles.cardImageWrap}>
          <img src={story.image} alt="" className={styles.cardImage} loading="lazy"
            onError={e => { e.target.parentNode.style.display = 'none'; }} />
        </div>
      )}
      <div className={styles.cardMeta}>
        <span className={styles.cardTag}>{story.tag}</span>
        <span className={styles.cardSource}>{story.source.toUpperCase()}</span>
        <span className={styles.cardTime}>{story.time}</span>
      </div>
      <h3 className={styles.cardHeadline}>{story.headline}</h3>
      {variant !== 'compact' && (
        <p className={styles.cardSnippet}>{story.snippet}</p>
      )}
      <div className={styles.cardFooter}>
        <span className={styles.cardReadTime}>{story.readTime} read</span>
        {variant === 'featured' && (
          <span className={styles.cardCta}>Read full story →</span>
        )}
      </div>
    </article>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// INTEL DISPATCH — newspaper section
// ─────────────────────────────────────────────────────────────────────────────

const IntelDispatch = ({ stories, onOpenStory }) => {
  const [category, setCategory] = useState('all');

  const filtered = category === 'all'
    ? stories
    : stories.filter(s => s.category === category);

  const [featured, ...rest] = filtered;
  const recent   = rest.slice(0, 3);
  const trending = rest.slice(3, 7);

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return (
    <div className={styles.dispatch}>
      {/* Masthead */}
      <div className={styles.masthead}>
        <div className={styles.mastheadLeft}>
          <div className={styles.mastheadEdition}>
            VOL. I — NO. {Math.floor((Date.now() - new Date('2026-01-01')) / 86400000)}
          </div>
        </div>
        <div className={styles.mastheadCenter}>
          <div className={styles.mastheadTitle}>THE INTEL DISPATCH</div>
          <div className={styles.mastheadRule} aria-hidden="true" />
          <div className={styles.mastheadSub}>INTELLIGENCE BRIEFING · ALL SOURCES · LOCAL ENCRYPTED</div>
        </div>
        <div className={styles.mastheadRight}>
          <div className={styles.mastheadDate}>{dateStr}</div>
          <div className={styles.mastheadCount}>{stories.length} STORIES TODAY</div>
        </div>
      </div>

      {/* Ticker — live headlines with hardcoded fallback */}
      <TickerTape items={
        stories.length > 0
          ? stories.slice(0, 15).map(s => `${s.source.toUpperCase()} — ${s.headline}`)
          : TICKER_ITEMS
      } />

      {/* Category Tabs */}
      <div className={styles.catTabs} role="tablist">
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            className={`${styles.catTab} ${category === cat.id ? styles.catTabActive : ''}`}
            onClick={() => setCategory(cat.id)}
            role="tab"
            aria-selected={category === cat.id}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Story Grid */}
      <div className={styles.storyGrid}>
        {/* Featured — left */}
        <div className={styles.colFeatured}>
          {featured ? (
            <StoryCard story={featured} variant="featured" onClick={onOpenStory} />
          ) : (
            <div className={styles.emptyCol}>No stories in this category</div>
          )}
        </div>

        {/* Recent — center */}
        <div className={styles.colRecent}>
          <div className={styles.colHeader}>RECENT</div>
          {recent.length > 0 ? recent.map(s => (
            <StoryCard key={s.id} story={s} variant="regular" onClick={onOpenStory} />
          )) : (
            <div className={styles.emptyCol}>—</div>
          )}
        </div>

        {/* Trending — right */}
        <div className={styles.colTrending}>
          <div className={styles.colHeader}>TRENDING</div>
          {trending.length > 0 ? trending.map(s => (
            <StoryCard key={s.id} story={s} variant="compact" onClick={onOpenStory} />
          )) : (
            <div className={styles.emptyCol}>—</div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// STORY READER — slide-up overlay
// ─────────────────────────────────────────────────────────────────────────────

const StoryReader = ({ story, onClose }) => {
  // Close on Escape
  useEffect(() => {
    const handler = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className={styles.readerOverlay} role="dialog" aria-modal="true" aria-label="Story reader">
      <div className={styles.readerBackdrop} onClick={onClose} />
      <div className={styles.readerSheet}>
        {/* Header */}
        <div className={styles.readerHeader}>
          <div className={styles.readerMeta}>
            <span className={styles.readerTag}>{story.tag}</span>
            <span className={styles.readerSource}>{story.source.toUpperCase()}</span>
            <span className={styles.readerTime}>{story.time}</span>
            <span className={styles.readerReadTime}>{story.readTime} read</span>
          </div>
          <div className={styles.readerActions}>
            <button className={styles.readerExternalBtn} aria-label="Open in browser" title="Open in browser">
              ↗
            </button>
            <button className={styles.readerCloseBtn} onClick={onClose} aria-label="Close story reader">
              ✕
            </button>
          </div>
        </div>

        {/* Hero image */}
        <div className={styles.readerHero}>
          {story.image ? (
            <img src={story.image} alt="" className={styles.readerHeroImg}
              onError={e => { e.target.style.display = 'none'; }} />
          ) : (
            <>
              <div className={styles.readerHeroNoise} />
              <span className={styles.readerHeroLabel}>IMAGE / THUMBNAIL</span>
            </>
          )}
        </div>

        {/* Article body */}
        <div className={styles.readerBody}>
          <h1 className={styles.readerHeadline}>{story.headline}</h1>
          <div className={styles.readerRule} />
          {story.body.split('\n\n').map((para, i) => (
            <p key={i} className={styles.readerPara}>{para}</p>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// NEWS PANEL — main assembly
// ─────────────────────────────────────────────────────────────────────────────

const NewsPanel = ({ feeds = FEED_SOURCES, stories = STORIES }) => {
  const [activeFeed, setActiveFeed]     = useState('all');
  const [openStory,  setOpenStory]      = useState(null);

  // ── Live data from intelligence service ──
  const { data: intelFeed } = useIntelligenceFeed(['news'], 100, 24, 300000);
  const { data: intelSources } = useIntelligenceSources(60000);
  const { data: newsData } = useNews(300000);
  const [liveStories, setLiveStories] = useState(null);
  const [liveFeedSources, setLiveFeedSources] = useState(null);

  // Map intelligence feed items to story format
  useEffect(() => {
    const feedItems = intelFeed?.items;
    if (feedItems && feedItems.length > 0) {
      const mapped = feedItems.map((item, i) => {
        const ts = item.timestamp ? new Date(item.timestamp) : null;
        const timeAgo = ts ? _relativeTime(ts) : '';
        return {
          id:       item.id || `intel-${i}`,
          source:   item.source || 'unknown',
          category: _guessCategory(item.tags || []),
          headline: _stripHtml(item.title || ''),
          snippet:  _stripHtml(item.description || ''),
          body:     _stripHtml(item.description || item.metadata?.summary || ''),
          time:     timeAgo,
          readTime: `${Math.max(1, Math.ceil((item.description || '').split(' ').length / 200))} min`,
          urgent:   false,
          image:    item.metadata?.image || null,
          tag:      (item.source || 'NEWS').toUpperCase().slice(0, 8),
          url:      item.url || '',
        };
      });
      setLiveStories(mapped);
    }
  }, [intelFeed]);

  // Fallback: use plain news endpoint if intelligence feed is empty
  useEffect(() => {
    if (liveStories) return; // already have intel data
    if (!newsData?.articles?.length) return;
    const mapped = newsData.articles.map((a, i) => ({
      id:       `live-${i}`,
      source:   (a.source || 'reuters').toLowerCase().replace(/\s+/g, '_'),
      category: a.category || 'all',
      headline: _stripHtml(a.title || ''),
      snippet:  _stripHtml(a.summary || a.description || ''),
      body:     _stripHtml(a.summary || ''),
      time:     a.published ? new Date(a.published).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '',
      readTime: '2 min',
      urgent:   false,
      image:    a.image || a.urlToImage || null,
      tag:      (a.category || 'NEWS').toUpperCase().slice(0, 6),
    }));
    setLiveStories(mapped);
  }, [newsData, liveStories]);

  // Build live feed sources from intelligence sources config
  useEffect(() => {
    if (!intelSources?.news) return;
    const mapped = Object.entries(intelSources.news).map(([id, cfg]) => {
      const existingFeed = FEED_SOURCES.find(f => f.id === id);
      return {
        id,
        label:     existingFeed?.label || id.charAt(0).toUpperCase() + id.slice(1),
        icon:      existingFeed?.icon || id.slice(0, 2).toUpperCase(),
        status:    cfg.enabled ? 'live' : 'standby',
        streamUrl: existingFeed?.streamUrl || '',
      };
    });
    setLiveFeedSources(mapped);
  }, [intelSources]);

  // Filter stories by active feed source
  const visibleStories = activeFeed === 'all'
    ? (liveStories || stories)
    : (liveStories || stories).filter(s => s.source === activeFeed);

  const displayFeeds = liveFeedSources || feeds;

  return (
    <div className={styles.root}>

      {/* ── FEED SELECTOR STRIP ── */}
      <FeedSelector feeds={displayFeeds} activeFeed={activeFeed} onSelect={setActiveFeed} />

      {/* ── INTEL DISPATCH ── */}
      <div className={styles.dispatchWrapper}>
        <IntelDispatch stories={visibleStories} onOpenStory={setOpenStory} />
      </div>

      {/* ── OVERLAYS ── */}
      {openStory && (
        <StoryReader story={openStory} onClose={() => setOpenStory(null)} />
      )}

    </div>
  );
};

export default NewsPanel;
