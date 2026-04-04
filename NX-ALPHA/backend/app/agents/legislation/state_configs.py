"""
AURA NX-Alpha — State Legislature Configurations

Catalog of all 50 states + DC. Each StateConfig provides:
- The primary URL to scrape for live bill activity
- An enabled flag (user can disable states they don't monitor)
- A cron_offset (minutes from 06:00 daily) to stagger scheduler jobs
  and avoid hammering all targets simultaneously

All states use api_type="website_scrape" in Phase 3.
API-based fetching (CA, IL, NY, TX) is deferred to Phase 4.

Usage:
    from app.agents.legislation.state_configs import STATE_CONFIGS
    config = STATE_CONFIGS["CA"]
    cron = config.default_cron   # e.g. "20 6 * * *"

To create a scheduler task for a state:
    scheduler_service.create_task({
        "name": f"{config.name} Legislature Monitor",
        "task_type": "legislative_digest",
        "schedule": config.default_cron,
        "parameters": {"state_code": config.code, "context": "personal"},
    })
"""

from dataclasses import dataclass, field


@dataclass
class StateConfig:
    code: str               # e.g. "CA"
    name: str               # e.g. "California"
    legislature_url: str    # primary URL scraped for bill activity
    enabled: bool = True    # set False to skip this state entirely
    cron_offset: int = 0    # minutes from 06:00; used to stagger daily jobs

    @property
    def default_cron(self) -> str:
        """5-field cron string for this state's default daily run time.

        Offsets are 5 minutes apart, spreading 51 jobs across ~4 hours
        (06:00 AM → 10:10 AM) to avoid thundering-herd scrape traffic.
        """
        total_minutes = 6 * 60 + self.cron_offset
        hour = total_minutes // 60
        minute = total_minutes % 60
        return f"{minute} {hour} * * *"


# ── 50 States + DC — alphabetical, 5-minute stagger ───────────────────────────
# All use website_scrape in Phase 3. cron_offset = index * 5 (minutes from 06:00).

STATE_CONFIGS: dict[str, StateConfig] = {
    "AL": StateConfig("AL", "Alabama",
                      "https://alison.legislature.state.al.us",
                      cron_offset=0),
    "AK": StateConfig("AK", "Alaska",
                      "https://www.akleg.gov",
                      cron_offset=5),
    "AZ": StateConfig("AZ", "Arizona",
                      "https://www.azleg.gov",
                      cron_offset=10),
    "AR": StateConfig("AR", "Arkansas",
                      "https://www.arkleg.state.ar.us",
                      cron_offset=15),
    "CA": StateConfig("CA", "California",
                      "https://leginfo.legislature.ca.gov",
                      cron_offset=20),
    "CO": StateConfig("CO", "Colorado",
                      "https://leg.colorado.gov",
                      cron_offset=25),
    "CT": StateConfig("CT", "Connecticut",
                      "https://www.cga.ct.gov",
                      cron_offset=30),
    "DE": StateConfig("DE", "Delaware",
                      "https://legis.delaware.gov",
                      cron_offset=35),
    "FL": StateConfig("FL", "Florida",
                      "https://www.flsenate.gov",
                      cron_offset=40),
    "GA": StateConfig("GA", "Georgia",
                      "https://www.legis.ga.gov",
                      cron_offset=45),
    "HI": StateConfig("HI", "Hawaii",
                      "https://www.capitol.hawaii.gov",
                      cron_offset=50),
    "ID": StateConfig("ID", "Idaho",
                      "https://legislature.idaho.gov",
                      cron_offset=55),
    "IL": StateConfig("IL", "Illinois",
                      "https://www.ilga.gov",
                      cron_offset=60),
    "IN": StateConfig("IN", "Indiana",
                      "https://iga.in.gov",
                      cron_offset=65),
    "IA": StateConfig("IA", "Iowa",
                      "https://www.legis.iowa.gov",
                      cron_offset=70),
    "KS": StateConfig("KS", "Kansas",
                      "https://www.kslegislature.org",
                      cron_offset=75),
    "KY": StateConfig("KY", "Kentucky",
                      "https://legislature.ky.gov",
                      cron_offset=80),
    "LA": StateConfig("LA", "Louisiana",
                      "https://www.legis.la.gov",
                      cron_offset=85),
    "ME": StateConfig("ME", "Maine",
                      "https://legislature.maine.gov",
                      cron_offset=90),
    "MD": StateConfig("MD", "Maryland",
                      "https://mgaleg.maryland.gov",
                      cron_offset=95),
    "MA": StateConfig("MA", "Massachusetts",
                      "https://malegislature.gov",
                      cron_offset=100),
    "MI": StateConfig("MI", "Michigan",
                      "https://www.legislature.mi.gov",
                      cron_offset=105),
    "MN": StateConfig("MN", "Minnesota",
                      "https://www.revisor.mn.gov",
                      cron_offset=110),
    "MS": StateConfig("MS", "Mississippi",
                      "https://www.legislature.ms.gov",
                      cron_offset=115),
    "MO": StateConfig("MO", "Missouri",
                      "https://www.house.mo.gov",
                      cron_offset=120),
    "MT": StateConfig("MT", "Montana",
                      "https://leg.mt.gov",
                      cron_offset=125),
    "NE": StateConfig("NE", "Nebraska",
                      "https://nebraskalegislature.gov",
                      cron_offset=130),
    "NV": StateConfig("NV", "Nevada",
                      "https://www.leg.state.nv.us",
                      cron_offset=135),
    "NH": StateConfig("NH", "New Hampshire",
                      "https://www.gencourt.state.nh.us",
                      cron_offset=140),
    "NJ": StateConfig("NJ", "New Jersey",
                      "https://www.njleg.state.nj.us",
                      cron_offset=145),
    "NM": StateConfig("NM", "New Mexico",
                      "https://www.nmlegis.gov",
                      cron_offset=150),
    "NY": StateConfig("NY", "New York",
                      "https://www.nysenate.gov",
                      cron_offset=155),
    "NC": StateConfig("NC", "North Carolina",
                      "https://www.ncleg.gov",
                      cron_offset=160),
    "ND": StateConfig("ND", "North Dakota",
                      "https://www.ndlegis.gov",
                      cron_offset=165),
    "OH": StateConfig("OH", "Ohio",
                      "https://www.legislature.ohio.gov",
                      cron_offset=170),
    "OK": StateConfig("OK", "Oklahoma",
                      "https://www.oklegislature.gov",
                      cron_offset=175),
    "OR": StateConfig("OR", "Oregon",
                      "https://www.oregonlegislature.gov",
                      cron_offset=180),
    "PA": StateConfig("PA", "Pennsylvania",
                      "https://www.legis.state.pa.us",
                      cron_offset=185),
    "RI": StateConfig("RI", "Rhode Island",
                      "https://www.rilegislature.gov",
                      cron_offset=190),
    "SC": StateConfig("SC", "South Carolina",
                      "https://www.scstatehouse.gov",
                      cron_offset=195),
    "SD": StateConfig("SD", "South Dakota",
                      "https://sdlegislature.gov",
                      cron_offset=200),
    "TN": StateConfig("TN", "Tennessee",
                      "https://www.tn.gov/legislature.html",
                      cron_offset=205),
    "TX": StateConfig("TX", "Texas",
                      "https://capitol.texas.gov",
                      cron_offset=210),
    "UT": StateConfig("UT", "Utah",
                      "https://le.utah.gov",
                      cron_offset=215),
    "VT": StateConfig("VT", "Vermont",
                      "https://legislature.vermont.gov",
                      cron_offset=220),
    "VA": StateConfig("VA", "Virginia",
                      "https://lis.virginia.gov",
                      cron_offset=225),
    "WA": StateConfig("WA", "Washington",
                      "https://app.leg.wa.gov",
                      cron_offset=230),
    "WV": StateConfig("WV", "West Virginia",
                      "https://www.wvlegislature.gov",
                      cron_offset=235),
    "WI": StateConfig("WI", "Wisconsin",
                      "https://legis.wisconsin.gov",
                      cron_offset=240),
    "WY": StateConfig("WY", "Wyoming",
                      "https://www.wyoleg.gov",
                      cron_offset=245),
    "DC": StateConfig("DC", "District of Columbia",
                      "https://lims.dccouncil.gov",
                      cron_offset=250),
}
