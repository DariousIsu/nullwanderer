# priv/sde — SDE System Coordinate Data

This directory must contain `nullsec_systems.csv` before the plugin can start.
The file is NOT included in the repository (it is ~500 KB and can be regenerated
from any EVE SDE source).

## Generating from Fuzzwork PostgreSQL SDE

1. Download the Fuzzwork Postgres SDE:
   https://www.fuzzwork.co.uk/dump/latest/

2. Import into a local PostgreSQL instance:
   ```bash
   createdb sde
   pg_restore -d sde fuzzwork-sde-latest.dump
   ```

3. Export the nullsec systems:
   ```sql
   \copy (
     SELECT
       s."solarSystemID"    AS "solarSystemID",
       s."solarSystemName"  AS "solarSystemName",
       s.security           AS "security",
       s."regionID"         AS "regionID",
       r."regionName"       AS "regionName",
       s."constellationID"  AS "constellationID",
       c."constellationName" AS "constellationName",
       s.x                  AS "x",
       s.y                  AS "y",
       s.z                  AS "z"
     FROM "mapSolarSystems" s
     JOIN "mapRegions"        r ON r."regionID"         = s."regionID"
     JOIN "mapConstellations" c ON c."constellationID" = s."constellationID"
     WHERE s.security < 0.0
       AND s.security > -1.0
       AND s."solarSystemID" < 31000000
     ORDER BY s."solarSystemID"
   ) TO 'priv/sde/nullsec_systems.csv' CSV HEADER;
   ```

## Generating from Hoboleaks YAML SDE

If you have the YAML SDE (from https://developers.eveonline.com/resource/resources):

```bash
mix run priv/sde/generate_csv.exs
```

(Script not included — parse `sde/fsd/universe/` YAML files manually if needed.)

## Required columns

| Column | Type | Notes |
|--------|------|-------|
| solarSystemID | integer | Primary key |
| solarSystemName | string | Display name |
| security | float | Negative for nullsec |
| regionID | integer | |
| regionName | string | |
| constellationID | integer | |
| constellationName | string | |
| x | float | Metres (raw SDE double) |
| y | float | Metres |
| z | float | Metres |

## Expected row count

Approximately 3,300–3,500 nullsec systems (excluding wormholes and Pochven
depending on filter). Confirm with: `SELECT count(*) FROM ...` using the
query above.

## Coordinate units

SDE stores x/y/z in **metres** (DOUBLE PRECISION).
The plugin converts to light-years: `dist_ly = sqrt(dx²+dy²+dz²) / 9.4607e15`.
