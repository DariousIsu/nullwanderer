/**
 * AURA NX-Alpha — WeatherPanel (Atmospheric Command)
 *
 * Full-density weather panel. Renders inside DropPanel for 'weather'.
 *
 * LAYOUT:
 *   City Strip (full-width) — 5 cities, clickable, temp/condition/hi-lo
 *   Body (two-column):
 *     Left  (180px) — Locations, Alert Status, Air Quality, Astronomy, Radar Layer
 *     Right (flex:1) — Live Doppler Radar (3), 7-Day Forecast, Historical Chart,
 *                       Current Conditions, Emergency Weather Center, Intel Feed
 *
 * DATA: Stub arrays — wire to NWS/NOAA API in Connectors sprint.
 * IDENTITY: Sky-500 (#0EA5E9) / Sky-400 (#38BDF8) / Sky-200 (#BAE6FD)
 */

import { useState, useEffect } from 'react';
import styles from './WeatherPanel.module.css';
import { useWeather } from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// STUB DATA
// ─────────────────────────────────────────────────────────────────────────────

const CITIES = [
  { icon: '⛅', temp: 58, name: 'Seattle',     label: 'Seattle, WA',     cond: 'Partly Cloudy', hi: 63, lo: 48 },
  { icon: '🌤', temp: 72, name: 'New York',     label: 'New York, NY',    cond: 'Mostly Clear',  hi: 76, lo: 61 },
  { icon: '☀️', temp: 84, name: 'Los Angeles',  label: 'Los Angeles, CA', cond: 'Clear',         hi: 87, lo: 68 },
  { icon: '🌧', temp: 55, name: 'Chicago',      label: 'Chicago, IL',     cond: 'Rain Showers',  hi: 60, lo: 48 },
  { icon: '⛈', temp: 79, name: 'Miami',         label: 'Miami, FL',       cond: 'Thunderstorm',  hi: 83, lo: 74 },
];

const DAYS = [
  { name: 'Wed', icon: '⛅', hi: 63, lo: 48, pp: 45, today: true  },
  { name: 'Thu', icon: '🌧', hi: 58, lo: 44, pp: 80              },
  { name: 'Fri', icon: '🌧', hi: 55, lo: 42, pp: 75              },
  { name: 'Sat', icon: '⛅', hi: 62, lo: 46, pp: 35              },
  { name: 'Sun', icon: '☀️', hi: 68, lo: 50, pp: 10              },
  { name: 'Mon', icon: '☀️', hi: 71, lo: 52, pp:  5              },
  { name: 'Tue', icon: '🌤', hi: 65, lo: 49, pp: 20              },
];

const CONDITIONS = [
  { label: 'Humidity',   val: '74%'        },
  { label: 'Wind',       val: 'SW 12 mph'  },
  { label: 'Pressure',   val: '29.88 in'   },
  { label: 'Visibility', val: '10 mi'      },
  { label: 'UV Index',   val: '3 — Low'    },
  { label: 'Dew Pt',     val: '50°F'       },
  { label: 'Cld Cover',  val: '65%'        },
  { label: 'Precip %',   val: '45%'        },
  { label: 'Feels Like', val: '54°F'       },
  { label: 'AQI',        val: '28 — Good', green: true },
];

// sev: 'ev' Emergency · 'w' Warning · 'a' Watch · 'i' Advisory
const ALERTS = {
  global: [
    { sev: 'ev', name: 'Super Typhoon Mawar — Category 4',    area: 'Western Pacific · Philippines Sea · 18.2°N 134.8°E',         stamp: 'Issued 12:00Z · Expires 48hr · JTWC',            badge: 'Emergency' },
    { sev: 'w',  name: 'Cyclone — Tropical Storm Biparjoy',   area: 'Bay of Bengal · NE India Coast · 20.5°N 91.2°E',             stamp: 'Issued 10:00Z · Expires 72hr · IMD',             badge: 'Warning'   },
    { sev: 'w',  name: 'Extreme Heat Wave — 47°C+ Forecast',  area: 'Central India · Maharashtra, Telangana, Andhra Pradesh',     stamp: 'Issued 06:00Z · Expires 96hr · IMD',             badge: 'Warning'   },
    { sev: 'a',  name: 'Arctic Blizzard — Sub-Polar System',  area: 'Northern Canada · Nunavut Territory · Baffin Island',        stamp: 'Issued 09:30Z · Expires 36hr · MSC',             badge: 'Watch'     },
    { sev: 'i',  name: 'Saharan Dust Storm Surge',            area: 'North Africa · Libya, Egypt, Northern Sudan',                stamp: 'Issued 08:00Z · Expires 24hr · ECMWF',           badge: 'Advisory'  },
  ],
  national: [
    { sev: 'ev', name: 'Tornado Emergency — Large Wedge',     area: 'Central Oklahoma · Canadian, Grady, McClain Counties',       stamp: 'Issued 14:22Z · Expires 15:00Z · NWS OUN',       badge: 'Emergency' },
    { sev: 'w',  name: 'Flash Flood Warning — Rapid Rise',    area: 'Middle Tennessee · Davidson, Williamson, Rutherford',        stamp: 'Issued 13:45Z · Expires 17:00Z · NWS OHX',       badge: 'Warning'   },
    { sev: 'w',  name: 'Severe Thunderstorm Warning',         area: 'South Florida · Miami-Dade, Broward, Palm Beach',            stamp: 'Issued 14:10Z · Expires 15:30Z · NWS MFL',       badge: 'Warning'   },
    { sev: 'a',  name: 'Winter Storm Watch — Snow & Ice',     area: 'Montana · Cascade, Lewis & Clark, Broadwater Counties',     stamp: 'Issued 12:00Z · Expires Thu 12:00Z · NWS TFX',   badge: 'Watch'     },
    { sev: 'i',  name: 'Rip Current Statement',               area: 'Atlantic Coast · South Carolina, Georgia Beaches',           stamp: 'Issued 10:00Z · Expires Thu 06:00Z · NWS CHS',   badge: 'Advisory'  },
  ],
  local: [
    { sev: 'a',  name: 'Dense Fog Advisory',                  area: 'Seattle Metro · King County, Pierce County — Visibility <¼mi', stamp: 'Issued 04:00Z · Expires Today 10:00 PST · NWS SEW', badge: 'Advisory' },
    { sev: 'i',  name: 'High Wind Advisory — Cascades',       area: 'E. Cascades · Snoqualmie Pass, Stevens Pass, White Pass',   stamp: 'Issued 12:00Z · Expires Thu 00:00Z · NWS SEW',   badge: 'Advisory'  },
    { sev: 'i',  name: 'Small Craft Advisory — Puget Sound',  area: 'North & South Puget Sound — Winds 20–30 kt, Seas 4–6 ft',  stamp: 'Issued 10:00Z · Expires Thu 06:00Z · NWS SEW',   badge: 'Advisory'  },
    { sev: 'i',  name: 'Air Quality — Moderate',              area: 'Seattle Metro · AQI 58 · Sensitive groups advised to limit outdoor activity', stamp: 'Updated 14:00Z · Ongoing · PSCAA', badge: 'Notice' },
  ],
};

// tag: 'wx' | 'em' | 'cl' | 'rs'
const NEWS = {
  national: [
    { hl: 'Tornado outbreak continues across Oklahoma and Texas — at least 3 confirmed twisters, damage reports emerging from El Reno', src: 'NWS',     time: '14:28', tag: 'em', tagLabel: 'Breaking'  },
    { hl: 'NOAA spring outlook updated: above-normal temperatures expected across Southeast US through May; drought risk elevated',      src: 'NOAA',    time: '13:55', tag: 'cl', tagLabel: 'Climate'   },
    { hl: 'Exceptional drought declared in Arizona as SW water crisis deepens; Lake Mead at 32% capacity',                             src: 'NWS WRH', time: '13:30', tag: 'wx', tagLabel: 'Drought'   },
    { hl: 'Pacific atmospheric river targets Pacific Northwest this weekend — heavy rainfall 3–5 inches possible in Cascades foothills', src: 'WPC',    time: '12:48', tag: 'wx', tagLabel: 'Rain'      },
    { hl: 'La Niña weakening; ENSO forecast shifts to neutral through summer — implications for hurricane season outlook',              src: 'CPC',     time: '12:00', tag: 'rs', tagLabel: 'Research'  },
  ],
  local: [
    { hl: 'Dense fog advisory continues for King and Pierce Counties — visibility below ¼ mile at Sea-Tac, recommend avoiding early travel', src: 'NWS SEW',   time: '14:15', tag: 'em', tagLabel: 'Alert'    },
    { hl: 'Weekend warm-up ahead: temperatures reaching low-70s Saturday and Sunday as high pressure builds — enjoy it before the next system', src: 'KOMO Wx', time: '14:00', tag: 'wx', tagLabel: 'Forecast' },
    { hl: 'Snow levels dropping to 4,000 ft Thursday; travel advisory issued for Snoqualmie, Stevens, and White Passes — chain requirements possible', src: 'WSDOT', time: '13:20', tag: 'wx', tagLabel: 'Roads'   },
    { hl: 'Puget Sound small craft advisory active through Thursday morning — sustained SW winds 20–28 knots, combined seas 4–6 feet',       src: 'NWS Marine', time: '10:00', tag: 'wx', tagLabel: 'Marine'  },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// CLASS MAPS
// ─────────────────────────────────────────────────────────────────────────────

const SEV_BAR   = { ev: styles.alertBarEv,  w: styles.alertBarW,  a: styles.alertBarA,  i: styles.alertBarI  };
const SEV_BADGE = { ev: styles.alertBadgeEv, w: styles.alertBadgeW, a: styles.alertBadgeA, i: styles.alertBadgeI };
const TAG_CLS   = { wx: styles.newsTagWx,   em: styles.newsTagEm, cl: styles.newsTagCl, rs: styles.newsTagRs };

// ─────────────────────────────────────────────────────────────────────────────
// HIST CHART POINTS
// ─────────────────────────────────────────────────────────────────────────────

const HI_PTS = [
  { x: 44,  y: 26 }, { x: 88,  y: 34 }, { x: 132, y: 22 },
  { x: 176, y: 27 }, { x: 220, y: 20 }, { x: 264, y: 24 }, { x: 310, y: 28 },
];
const HI_POLY  = `0,30 ${HI_PTS.map(p => `${p.x},${p.y}`).join(' ')} 310,72 0,72`;
const HI_LINE  = HI_PTS.map(p => `${p.x},${p.y}`).join(' ');
const LO_LINE  = '0,50 44,46 88,54 132,44 176,48 220,42 264,46 310,50';
const LO_POLY  = `0,50 44,46 88,54 132,44 176,48 220,42 264,46 310,50 310,72 0,72`;

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const WeatherPanel = () => {
  const [activeCity, setActiveCity] = useState(0);
  const [emgTab,     setEmgTab]     = useState('global');
  const [newsTab,    setNewsTab]    = useState('national');
  const [cities,     setCities]     = useState(CITIES);
  const [days,       setDays]       = useState(DAYS);
  const [conditions, setConditions] = useState(CONDITIONS);
  const { data: wxData } = useWeather(300000);

  useEffect(() => {
    if (!wxData?.current) return;
    const c = wxData.current;
    const tempF = c.temperature_2m != null
      ? Math.round(c.temperature_2m * 9 / 5 + 32)
      : cities[0].temp;
    const codeText = c.weathercode != null
      ? ['Clear','Partly Cloudy','Overcast','Fog','Drizzle','Rain','Snow','Thunder'][
          Math.min(Math.floor(c.weathercode / 10), 7)] || 'Conditions Vary'
      : cities[0].cond;
    setCities(prev => prev.map((city, i) =>
      i === 0 ? { ...city, temp: tempF, cond: codeText } : city
    ));
    // Update conditions grid for Seattle
    if (c.relative_humidity_2m != null) {
      setConditions(prev => prev.map(cond => {
        if (cond.label === 'Humidity')   return { ...cond, val: `${c.relative_humidity_2m}%` };
        if (cond.label === 'Wind' && c.windspeed_10m != null) return { ...cond, val: `${Math.round(c.windspeed_10m)} mph` };
        if (cond.label === 'Feels Like' && c.apparent_temperature != null)
          return { ...cond, val: `${Math.round(c.apparent_temperature * 9/5 + 32)}°F` };
        return cond;
      }));
    }
    // Update forecast
    if (wxData.daily?.temperature_2m_max?.length) {
      const daily = wxData.daily;
      setDays(prev => prev.map((day, i) => {
        if (!daily.temperature_2m_max[i]) return day;
        const hiF = Math.round(daily.temperature_2m_max[i] * 9/5 + 32);
        const loF = Math.round(daily.temperature_2m_min[i] * 9/5 + 32);
        const pp  = daily.precipitation_probability_max?.[i] ?? day.pp;
        return { ...day, hi: hiF, lo: loF, pp };
      }));
    }
  }, [wxData]);

  const cx = (...cls) => cls.filter(Boolean).join(' ');

  return (
    <div className={styles.root}>

      {/* ══ CITY STRIP ══ */}
      <div className={styles.cityStrip}>
        {cities.map((city, i) => (
          <div
            key={city.name}
            className={cx(styles.cityPill, i === activeCity && styles.cityPillActive)}
            onClick={() => setActiveCity(i)}
          >
            <div className={styles.pillIcon}>{city.icon}</div>
            <div className={styles.pillTempWrap}>
              <div className={styles.pillTemp}>{city.temp}</div>
              <div className={styles.pillUnit}>°F</div>
            </div>
            <div className={styles.pillInfo}>
              <div className={styles.pillName}>{city.name}</div>
              <div className={styles.pillCond}>{city.cond}</div>
              <div className={styles.pillHl}>↑{city.hi}° ↓{city.lo}°</div>
            </div>
          </div>
        ))}
      </div>

      {/* ══ BODY ══ */}
      <div className={styles.body}>

        {/* ── SIDEBAR ── */}
        <div className={styles.side}>

          <div className={styles.snHd}>Locations</div>
          {cities.map((c, i) => (
            <div
              key={c.name}
              className={cx(styles.snItem, i === activeCity && styles.snItemOn)}
              onClick={() => setActiveCity(i)}
            >
              <div className={styles.snDot} />{c.label}
            </div>
          ))}
          <div className={styles.snItem} style={{ opacity: .45 }}>
            <div className={styles.snDot} style={{ background: 'var(--text-muted)' }} />+ Add City
          </div>

          <div className={styles.snHd}>Alert Status</div>
          <div className={cx(styles.snItem, styles.snItemOk)}><div className={styles.snDot} />Seattle — Clear</div>
          <div className={cx(styles.snItem, styles.snItemOk)}><div className={styles.snDot} />NYC — Clear</div>
          <div className={cx(styles.snItem, styles.snItemOk)}><div className={styles.snDot} />LA — Clear</div>
          <div className={cx(styles.snItem, styles.snItemWarn)}><div className={styles.snDot} />Chicago — Watch</div>
          <div className={cx(styles.snItem, styles.snItemErr)}><div className={styles.snDot} />Miami — Warning</div>

          <div className={styles.snHd}>Air Quality</div>
          <div className={cx(styles.snItem, styles.snItemOk)}><div className={styles.snDot} />Seattle · AQI 28</div>
          <div className={cx(styles.snItem, styles.snItemOk)}><div className={styles.snDot} />NYC · AQI 72</div>
          <div className={cx(styles.snItem, styles.snItemWarn)}><div className={styles.snDot} />LA · AQI 121</div>

          <div className={styles.snHd}>Astronomy · SEA</div>
          <div className={styles.snItem}><div className={styles.snDot} style={{ background: '#FCD34D' }} />Sunrise 06:24</div>
          <div className={styles.snItem}><div className={styles.snDot} style={{ background: '#F59E0B' }} />Sunset 19:47</div>
          <div className={styles.snItem}><div className={styles.snDot} style={{ background: '#E2E8F0', opacity: .55 }} />Moon 78% Full</div>

          <div className={styles.snHd}>Radar Layer</div>
          <div className={cx(styles.snItem, styles.snItemOn)}><div className={styles.snDot} />Precipitation</div>
          <div className={styles.snItem}><div className={styles.snDot} />Base Velocity</div>
          <div className={styles.snItem}><div className={styles.snDot} />Composite Refl.</div>
          <div className={styles.snItem}><div className={styles.snDot} />Storm Motion</div>

        </div>{/* end side */}

        {/* ── MAIN ── */}
        <div className={styles.main}>

          {/* ── RADAR ── */}
          <div className={styles.secHd}>Live Doppler Radar · Z-Layer · 5 min composite</div>
          <div className={styles.radarGrid}>

            {/* KSEA — primary (larger) — filter defs live here, referenced by all 3 radars */}
            <div className={cx(styles.radarCard, styles.radarCardPrimary)}>
              <div className={styles.radarHdr}>
                <span className={styles.radarLbl}>Radar</span>
                <span className={styles.radarCity}>KSEA · Seattle–Tacoma</span>
                <span className={styles.radarUpd}>14:38Z</span>
              </div>
              <div className={styles.radarWrap}>
                <svg className={styles.radarSvg} viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <clipPath id="wxrc1"><circle cx="100" cy="100" r="98"/></clipPath>
                    <filter id="wxb4"><feGaussianBlur stdDeviation="4"/></filter>
                    <filter id="wxb7"><feGaussianBlur stdDeviation="7"/></filter>
                    <filter id="wxb10"><feGaussianBlur stdDeviation="10"/></filter>
                  </defs>
                  <g clipPath="url(#wxrc1)">
                    <rect x="0" y="0" width="200" height="200" fill="#02080E"/>
                    <circle cx="100" cy="100" r="25" fill="none" stroke="rgba(14,165,233,.09)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="50" fill="none" stroke="rgba(14,165,233,.11)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="75" fill="none" stroke="rgba(14,165,233,.13)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="97" fill="none" stroke="rgba(14,165,233,.16)" strokeWidth=".8"/>
                    <line x1="2"   y1="100" x2="198" y2="100" stroke="rgba(14,165,233,.07)" strokeWidth=".5"/>
                    <line x1="100" y1="2"   x2="100" y2="198" stroke="rgba(14,165,233,.07)" strokeWidth=".5"/>
                    <line x1="29"  y1="29"  x2="171" y2="171" stroke="rgba(14,165,233,.03)" strokeWidth=".5"/>
                    <line x1="171" y1="29"  x2="29"  y2="171" stroke="rgba(14,165,233,.03)" strokeWidth=".5"/>
                    {/* Precip blobs */}
                    <circle cx="62"  cy="118" r="30" fill="rgba(56,189,248,.12)"  filter="url(#wxb10)"/>
                    <circle cx="55"  cy="128" r="22" fill="rgba(14,165,233,.32)"  filter="url(#wxb7)"/>
                    <circle cx="48"  cy="115" r="16" fill="rgba(99,102,241,.48)"  filter="url(#wxb4)"/>
                    <circle cx="70"  cy="143" r="18" fill="rgba(14,165,233,.28)"  filter="url(#wxb7)"/>
                    <circle cx="38"  cy="132" r="12" fill="rgba(99,102,241,.40)"  filter="url(#wxb4)"/>
                    <circle cx="82"  cy="125" r="14" fill="rgba(56,189,248,.22)"  filter="url(#wxb7)"/>
                    <circle cx="108" cy="88"  r="11" fill="rgba(56,189,248,.14)"  filter="url(#wxb7)"/>
                    <circle cx="92"  cy="75"  r="8"  fill="rgba(14,165,233,.12)"  filter="url(#wxb4)"/>
                    <circle cx="152" cy="65"  r="8"  fill="rgba(56,189,248,.10)"  filter="url(#wxb7)"/>
                    <circle cx="140" cy="155" r="6"  fill="rgba(56,189,248,.08)"  filter="url(#wxb4)"/>
                    <circle cx="165" cy="130" r="5"  fill="rgba(56,189,248,.07)"  filter="url(#wxb4)"/>
                  </g>
                  <circle cx="100" cy="100" r="3"  fill="#0EA5E9" opacity=".90"/>
                  <circle cx="100" cy="100" r="7"  fill="none" stroke="#0EA5E9" strokeWidth=".8" opacity=".40"/>
                  <text x="105" y="97"  fontSize="8"   fill="rgba(14,165,233,.72)" fontFamily="monospace" letterSpacing=".5">SEA</text>
                  <text x="126" y="99"  fontSize="5.5" fill="rgba(14,165,233,.25)" fontFamily="monospace">50mi</text>
                  <text x="151" y="99"  fontSize="5.5" fill="rgba(14,165,233,.20)" fontFamily="monospace">100mi</text>
                </svg>
                <div className={styles.radarSweep}
                  style={{ background: 'conic-gradient(from 0deg,rgba(14,165,233,0) 305deg,rgba(14,165,233,.04) 335deg,rgba(14,165,233,.16) 352deg,rgba(14,165,233,.22) 360deg)' }}
                />
                <div className={styles.radarScale}>NWS KSEA · 0.5° PPI</div>
              </div>
            </div>

            {/* KOKX — New York */}
            <div className={styles.radarCard}>
              <div className={styles.radarHdr}>
                <span className={styles.radarLbl}>Radar</span>
                <span className={styles.radarCity}>KOKX · New York</span>
                <span className={styles.radarUpd}>14:38Z</span>
              </div>
              <div className={styles.radarWrap}>
                <svg className={styles.radarSvg} viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                  <defs><clipPath id="wxrc2"><circle cx="100" cy="100" r="98"/></clipPath></defs>
                  <g clipPath="url(#wxrc2)">
                    <rect x="0" y="0" width="200" height="200" fill="#02080E"/>
                    <circle cx="100" cy="100" r="25"  fill="none" stroke="rgba(14,165,233,.09)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="50"  fill="none" stroke="rgba(14,165,233,.11)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="75"  fill="none" stroke="rgba(14,165,233,.13)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="97"  fill="none" stroke="rgba(14,165,233,.15)" strokeWidth=".8"/>
                    <line x1="2"   y1="100" x2="198" y2="100" stroke="rgba(14,165,233,.07)" strokeWidth=".5"/>
                    <line x1="100" y1="2"   x2="100" y2="198" stroke="rgba(14,165,233,.07)" strokeWidth=".5"/>
                    <circle cx="132" cy="66"  r="15" fill="rgba(56,189,248,.13)" filter="url(#wxb7)"/>
                    <circle cx="150" cy="78"  r="10" fill="rgba(14,165,233,.22)" filter="url(#wxb4)"/>
                    <circle cx="140" cy="52"  r="8"  fill="rgba(56,189,248,.18)" filter="url(#wxb4)"/>
                    <circle cx="162" cy="60"  r="7"  fill="rgba(14,165,233,.14)" filter="url(#wxb4)"/>
                    <circle cx="72"  cy="148" r="7"  fill="rgba(56,189,248,.09)" filter="url(#wxb4)"/>
                    <circle cx="55"  cy="80"  r="5"  fill="rgba(56,189,248,.07)" filter="url(#wxb4)"/>
                  </g>
                  <circle cx="100" cy="100" r="3" fill="#0EA5E9" opacity=".90"/>
                  <circle cx="100" cy="100" r="7" fill="none" stroke="#0EA5E9" strokeWidth=".8" opacity=".40"/>
                  <text x="105" y="97" fontSize="8" fill="rgba(14,165,233,.72)" fontFamily="monospace">NYC</text>
                </svg>
                <div className={styles.radarSweep}
                  style={{ background: 'conic-gradient(from 0deg,rgba(14,165,233,0) 305deg,rgba(14,165,233,.04) 335deg,rgba(14,165,233,.16) 352deg,rgba(14,165,233,.22) 360deg)', animationDuration: '4.5s', animationDelay: '-.8s' }}
                />
                <div className={styles.radarScale}>KOKX · 0.5° PPI</div>
              </div>
            </div>

            {/* KAMX — Miami (active storm, red identity) */}
            <div className={styles.radarCard}>
              <div className={styles.radarHdr}>
                <span className={styles.radarLbl}>Radar</span>
                <span className={styles.radarCity} style={{ color: '#FCA5A5' }}>KAMX · Miami</span>
                <span className={styles.radarUpd}  style={{ color: 'rgba(239,68,68,.45)' }}>⚠ 14:38Z</span>
              </div>
              <div className={styles.radarWrap}>
                <svg className={styles.radarSvg} viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                  <defs><clipPath id="wxrc3"><circle cx="100" cy="100" r="98"/></clipPath></defs>
                  <g clipPath="url(#wxrc3)">
                    <rect x="0" y="0" width="200" height="200" fill="#020406"/>
                    <circle cx="100" cy="100" r="25" fill="none" stroke="rgba(239,68,68,.10)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="50" fill="none" stroke="rgba(239,68,68,.12)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="75" fill="none" stroke="rgba(239,68,68,.14)" strokeWidth=".6"/>
                    <circle cx="100" cy="100" r="97" fill="none" stroke="rgba(239,68,68,.18)" strokeWidth=".8"/>
                    <line x1="2"   y1="100" x2="198" y2="100" stroke="rgba(239,68,68,.07)" strokeWidth=".5"/>
                    <line x1="100" y1="2"   x2="100" y2="198" stroke="rgba(239,68,68,.07)" strokeWidth=".5"/>
                    <circle cx="100" cy="100" r="44" fill="rgba(56,189,248,.10)"  filter="url(#wxb10)"/>
                    <circle cx="92"  cy="96"  r="30" fill="rgba(14,165,233,.28)"  filter="url(#wxb7)"/>
                    <circle cx="112" cy="108" r="24" fill="rgba(99,102,241,.42)"  filter="url(#wxb7)"/>
                    <circle cx="88"  cy="118" r="18" fill="rgba(168,85,247,.38)"  filter="url(#wxb4)"/>
                    <circle cx="110" cy="82"  r="16" fill="rgba(99,102,241,.38)"  filter="url(#wxb4)"/>
                    <circle cx="78"  cy="90"  r="12" fill="rgba(14,165,233,.44)"  filter="url(#wxb4)"/>
                    <circle cx="122" cy="126" r="14" fill="rgba(99,102,241,.45)"  filter="url(#wxb4)"/>
                    <circle cx="130" cy="74"  r="10" fill="rgba(239,68,68,.38)"   filter="url(#wxb4)"/>
                    <circle cx="152" cy="112" r="14" fill="rgba(56,189,248,.22)"  filter="url(#wxb7)"/>
                    <circle cx="62"  cy="122" r="12" fill="rgba(14,165,233,.35)"  filter="url(#wxb4)"/>
                    <circle cx="74"  cy="148" r="10" fill="rgba(99,102,241,.30)"  filter="url(#wxb4)"/>
                    <circle cx="140" cy="150" r="8"  fill="rgba(56,189,248,.20)"  filter="url(#wxb4)"/>
                  </g>
                  <circle cx="100" cy="100" r="3" fill="#EF4444" opacity=".90"/>
                  <circle cx="100" cy="100" r="8" fill="none" stroke="#EF4444" strokeWidth="1" opacity=".40"/>
                  <text x="105" y="97" fontSize="8" fill="rgba(239,68,68,.75)" fontFamily="monospace">MIA</text>
                </svg>
                <div className={styles.radarSweep}
                  style={{ background: 'conic-gradient(from 0deg,rgba(239,68,68,0) 305deg,rgba(239,68,68,.05) 335deg,rgba(239,68,68,.18) 352deg,rgba(239,68,68,.26) 360deg)', animationDuration: '3.8s', animationDelay: '-1.2s' }}
                />
                <div className={styles.radarScale} style={{ color: 'rgba(239,68,68,.35)' }}>KAMX · 0.5° PPI</div>
              </div>
            </div>

          </div>{/* end radarGrid */}

          {/* ── 7-DAY FORECAST ── */}
          <div className={styles.secHd}>7-Day Forecast · Seattle, WA</div>
          <div className={styles.forecast}>
            {days.map(d => (
              <div key={d.name} className={cx(styles.dayCard, d.today && styles.dayCardToday)}>
                <div className={styles.dayName}>{d.name}</div>
                <div className={styles.dayIcon}>{d.icon}</div>
                <div className={styles.dayHi}>{d.hi}°</div>
                <div className={styles.dayLo}>{d.lo}°</div>
                <div className={styles.dayPp}>💧 {d.pp}%</div>
              </div>
            ))}
          </div>

          {/* ── HISTORICAL + CONDITIONS ── */}
          <div className={styles.lower}>

            {/* Historical sparkline */}
            <div className={styles.histCard}>
              <div className={styles.cardHdr}>
                <span className={styles.cardTitle}>Historical Temp · Past 7 Days · Seattle</span>
              </div>
              <div className={styles.histBody}>
                <svg className={styles.histSvg} viewBox="0 0 310 72" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="wxfill1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="#0EA5E9" stopOpacity=".26"/>
                      <stop offset="100%" stopColor="#0EA5E9" stopOpacity="0"/>
                    </linearGradient>
                    <linearGradient id="wxfill2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="#38BDF8" stopOpacity=".12"/>
                      <stop offset="100%" stopColor="#38BDF8" stopOpacity="0"/>
                    </linearGradient>
                  </defs>
                  {/* Grid */}
                  <line x1="0"   y1="15" x2="310" y2="15"  stroke="rgba(14,165,233,.07)" strokeWidth=".5"/>
                  <line x1="0"   y1="36" x2="310" y2="36"  stroke="rgba(14,165,233,.07)" strokeWidth=".5"/>
                  <line x1="0"   y1="57" x2="310" y2="57"  stroke="rgba(14,165,233,.07)" strokeWidth=".5"/>
                  <line x1="44"  y1="0"  x2="44"  y2="72"  stroke="rgba(14,165,233,.055)" strokeWidth=".5"/>
                  <line x1="88"  y1="0"  x2="88"  y2="72"  stroke="rgba(14,165,233,.055)" strokeWidth=".5"/>
                  <line x1="132" y1="0"  x2="132" y2="72"  stroke="rgba(14,165,233,.055)" strokeWidth=".5"/>
                  <line x1="176" y1="0"  x2="176" y2="72"  stroke="rgba(14,165,233,.055)" strokeWidth=".5"/>
                  <line x1="220" y1="0"  x2="220" y2="72"  stroke="rgba(14,165,233,.055)" strokeWidth=".5"/>
                  <line x1="264" y1="0"  x2="264" y2="72"  stroke="rgba(14,165,233,.055)" strokeWidth=".5"/>
                  {/* Area fills */}
                  <polygon points={HI_POLY} fill="url(#wxfill1)"/>
                  <polygon points={LO_POLY} fill="url(#wxfill2)"/>
                  {/* Lines */}
                  <polyline points={`0,30 ${HI_LINE}`} fill="none" stroke="#0EA5E9" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  <polyline points={LO_LINE} fill="none" stroke="#38BDF8" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3,2"/>
                  {/* Today marker */}
                  <line x1="310" y1="0" x2="310" y2="72" stroke="rgba(14,165,233,.30)" strokeWidth="1" strokeDasharray="2,2"/>
                  {/* Data dots */}
                  {HI_PTS.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={i === HI_PTS.length - 1 ? 2.5 : 2} fill="#0EA5E9"/>
                  ))}
                  {/* Y labels */}
                  <text x="3" y="14" fontSize="5.5" fill="rgba(14,165,233,.40)" fontFamily="monospace">70°</text>
                  <text x="3" y="35" fontSize="5.5" fill="rgba(14,165,233,.40)" fontFamily="monospace">55°</text>
                  <text x="3" y="56" fontSize="5.5" fill="rgba(14,165,233,.40)" fontFamily="monospace">40°</text>
                </svg>
              </div>
              <div className={styles.histLabels}>
                {['Thu','Fri','Sat','Sun','Mon','Tue'].map(d => (
                  <span key={d} className={styles.histLbl}>{d}</span>
                ))}
                <span className={cx(styles.histLbl, styles.histLblToday)}>Today</span>
              </div>
            </div>

            {/* Current conditions */}
            <div className={styles.condCard}>
              <div className={styles.cardHdr}>
                <span className={styles.cardTitle}>Current Conditions · Seattle, WA</span>
              </div>
              <div className={styles.condGrid}>
                {conditions.map(c => (
                  <div key={c.label} className={styles.condItem}>
                    <span className={styles.condLabel}>{c.label}</span>
                    <span className={cx(styles.condVal, c.green && styles.condValGreen)}>{c.val}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>{/* end lower */}

          {/* ── EMERGENCY WEATHER CENTER ── */}
          <div className={styles.emg}>
            <div className={styles.emgHeader}>
              <div className={styles.emgPulse} />
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0, opacity: .65 }}>
                <path d="M6.5 1L1.5 4.5v6h10v-6L6.5 1Z" stroke="#FCA5A5" strokeWidth="1.2" strokeLinejoin="round"/>
                <line x1="6.5" y1="5.5" x2="6.5" y2="8"   stroke="#FCA5A5" strokeWidth="1.2" strokeLinecap="round"/>
                <circle cx="6.5" cy="9.5" r=".8" fill="#FCA5A5"/>
              </svg>
              <span className={styles.emgTitle}>Emergency Weather Center</span>
              <span className={styles.emgBadge}>14 ACTIVE</span>
            </div>
            <div className={styles.emgTabs}>
              {[['global','🌍 Global'],['national','🇺🇸 US National'],['local','📍 Local']].map(([tab, label]) => (
                <button
                  key={tab}
                  className={cx(styles.emgTab, emgTab === tab && styles.emgTabOn)}
                  onClick={() => setEmgTab(tab)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.emgPane}>
              {ALERTS[emgTab].map((a, i) => (
                <div key={i} className={styles.alert}>
                  <div className={cx(styles.alertBar, SEV_BAR[a.sev])} />
                  <div>
                    <div className={styles.alertName}>{a.name}</div>
                    <div className={styles.alertArea}>{a.area}</div>
                    <div className={styles.alertStamp}>{a.stamp}</div>
                  </div>
                  <span className={cx(styles.alertBadge, SEV_BADGE[a.sev])}>{a.badge}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── WEATHER INTEL FEED ── */}
          <div>
            <div className={styles.newsHdr}>
              <span className={styles.newsTitle}>Live Weather Intel</span>
              <div className={styles.newsTabs}>
                {['national','local'].map(tab => (
                  <button
                    key={tab}
                    className={cx(styles.newsTab, newsTab === tab && styles.newsTabOn)}
                    onClick={() => setNewsTab(tab)}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {NEWS[newsTab].map((item, i) => (
              <div key={i} className={styles.newsItem}>
                <div className={styles.newsHl}>{item.hl}</div>
                <div className={styles.newsMeta}>
                  <span className={styles.newsSrc}>{item.src}</span>
                  <span className={styles.newsTime}>{item.time}</span>
                  <span className={cx(styles.newsTag, TAG_CLS[item.tag])}>{item.tagLabel}</span>
                </div>
              </div>
            ))}
          </div>

        </div>{/* end main */}
      </div>{/* end body */}
    </div>
  );
};

export default WeatherPanel;
