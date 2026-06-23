"""Batch-2 fixups: fix search-vault (FTS alias in MATCH) + entity-wikipedia (kg table location),
confirm positive rows for the 3 zero-hit recipes. Run: uv run python <this>"""
import asyncio, json
from fastmcp import Client
URL = "http://127.0.0.1:8765/mcp/"; TOKEN = "nx-echo-dev-admin"

PROBES = [
    # locate kg tables
    ("where-kg", "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('kg_node','kg_anchor') UNION SELECT 'main.'||name FROM main.sqlite_master WHERE name LIKE 'kg_%'", []),
    # search-vault v2: alias the FTS table in MATCH
    ("search-vault", "SELECT da.title, da.url FROM rainey.documents_articles_fts fts JOIN rainey.documents_articles da ON da.rowid=fts.rowid WHERE fts MATCH ? LIMIT ?", ["weather modification", 5]),
    # member-committees resolve debug
    ("debug-tomcole", "SELECT id,name,contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 3)", ["Tom Cole"]),
    # contact-socials with a federal figure likely to have official handles
    ("contact-socials", "SELECT s.Platform__c, s.Handle__c FROM social_handle__c s WHERE s.Contact__c IN (SELECT contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 1) AND contact_id IS NOT NULL) AND s.deleted=0 LIMIT ?", ["Schumer", 5]),
    # donations-from-donor: try an org donor via Donor_Account__c path instead
    ("donations-from-donor-acct", "SELECT d.Amount__c, d.Donation_Date__c FROM donation__c d WHERE d.Donor_Account__c IS NOT NULL ORDER BY d.Donation_Date__c DESC LIMIT ?", [3]),
]
async def main():
    async with Client(URL, auth=TOKEN) as c:
        for name, sql, params in PROBES:
            try:
                r = await c.call_tool("db_query", {"sql": sql, "params": params})
                d = r.data if hasattr(r, "data") else r
                d = json.loads(d) if isinstance(d, str) else d
                if d.get("ok"):
                    print(f"OK   {name:26s} rows={d.get('row_count')}  {(d.get('rows') or [])[:3]}")
                else:
                    print(f"FAIL {name:26s} {d.get('error')}")
            except Exception as e:
                print(f"ERR  {name:26s} {repr(e)[:120]}")
asyncio.run(main())
