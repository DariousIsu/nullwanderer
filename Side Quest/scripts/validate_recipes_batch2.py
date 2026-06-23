"""Live-validate candidate Category-A recipes (batch 2) against the real 8765 server.
Uses db_query with REAL params (FastMCP client => no MCP-harness param stringify).
Run from the Echo repo:  uv run python <path to this file>
"""
import asyncio, json
from fastmcp import Client

URL = "http://127.0.0.1:8765/mcp/"
TOKEN = "nx-echo-dev-admin"

# (name, sql, params)  — each is the EXACT parameterized form a recipe would store.
CANDS = [
    ("entity-facts-search",
     "SELECT ef.entity_id, substr(ef.fact_text,1,90) AS fact FROM entity_facts_fts fts JOIN entity_facts ef ON ef.id=fts.rowid WHERE entity_facts_fts MATCH ? LIMIT ?",
     ["solar tax credit", 3]),
    ("industry-sector",
     "SELECT e.name, ei.subsector, ei.employer FROM entity_industry ei JOIN entities e ON e.id=ei.entity_id WHERE ei.sector=? LIMIT ?",
     ["energy", 3]),
    ("member-committees",
     "SELECT e2.name AS committee, m.Role__c FROM committee_membership__c m JOIN entities e2 ON e2.id=m.Account__c WHERE m.Contact__c IN (SELECT contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 1) AND contact_id IS NOT NULL) LIMIT ?",
     ["Tom Cole", 5]),
    ("bill-detail",
     "SELECT bm.bill_number, bm.state, bm.session, bm.introduced_year, bm.sponsor_count, bm.yea_count, bm.nay_count FROM bill_meta bm WHERE bm.bill_id IN (SELECT rowid FROM bill_search WHERE bill_search MATCH ? ORDER BY rank LIMIT 1)",
     ["immigration"]),
    ("bill-rollcall",
     "SELECT Vote_Value__c, COUNT(*) AS n FROM vote_record__c WHERE Bill_Name__c LIKE '%'||?||'%' GROUP BY Vote_Value__c ORDER BY n DESC",
     ["SB 119"]),
    ("donations-from-donor",
     "SELECT d.Amount__c, d.Donation_Date__c FROM donation__c d WHERE d.Donor_Contact__c IN (SELECT contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 1) AND contact_id IS NOT NULL) ORDER BY d.Donation_Date__c DESC LIMIT ?",
     ["Schumer", 5]),
    ("donation-totals-by-cycle",
     "SELECT d.Cycle__c, SUM(d.Amount__c) AS total, COUNT(*) AS n FROM donation__c d WHERE d.Recipient_Contact__c IN (SELECT contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 1) AND contact_id IS NOT NULL) GROUP BY d.Cycle__c ORDER BY d.Cycle__c DESC",
     ["Schumer"]),
    ("company-pac-candidates",
     "SELECT cand.name AS candidate, COUNT(*) AS n FROM relations r1 JOIN relations r2 ON r2.source_id=r1.target_id JOIN entities cand ON cand.id=r2.target_id WHERE r1.relation_type='AFFILIATED_WITH' AND r2.relation_type='CONTRIBUTED_TO' AND r1.deleted=0 AND r2.deleted=0 AND r1.source_id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='organization' ORDER BY rank LIMIT 1) GROUP BY cand.id ORDER BY n DESC LIMIT ?",
     ["Boeing", 5]),
    ("entity-wikipedia",
     "SELECT n.title, n.url FROM knowledge_graph.kg_node n JOIN knowledge_graph.kg_anchor a ON a.node_id=n.node_id WHERE a.entity_id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? ORDER BY rank LIMIT 1) LIMIT ?",
     ["Chuck Schumer", 5]),
    ("contact-bio-timeline",
     "SELECT b.Kind__c, b.Headline__c FROM bio_event__c b WHERE b.Contact__c IN (SELECT contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 1) AND contact_id IS NOT NULL) AND b.deleted=0 ORDER BY b.Event_Date__c LIMIT ?",
     ["Schumer", 5]),
    ("contact-socials",
     "SELECT s.Platform__c, s.Handle__c, s.Url__c FROM social_handle__c s WHERE s.Contact__c IN (SELECT contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 1) AND contact_id IS NOT NULL) AND s.deleted=0 LIMIT ?",
     ["Lopez", 5]),
    ("contact-aliases",
     "SELECT a.Alias_Name__c, a.Kind__c FROM alias__c a WHERE a.Contact__c IN (SELECT contact_id FROM entities WHERE id IN (SELECT rowid FROM entity_search WHERE entity_search MATCH ? AND entity_type='person' ORDER BY rank LIMIT 1) AND contact_id IS NOT NULL) AND a.deleted=0 LIMIT ?",
     ["Schumer", 5]),
    ("search-vault",
     "SELECT da.title, da.url FROM rainey.documents_articles_fts fts JOIN rainey.documents_articles da ON da.rowid=fts.rowid WHERE rainey.documents_articles_fts MATCH ? LIMIT ?",
     ["weather modification", 5]),
]

async def main():
    async with Client(URL, auth=TOKEN) as c:
        ok_n = bad_n = 0
        for name, sql, params in CANDS:
            try:
                r = await c.call_tool("db_query", {"sql": sql, "params": params})
                d = r.data if hasattr(r, "data") else r
                d = json.loads(d) if isinstance(d, str) else d
                if d.get("ok"):
                    ok_n += 1
                    rows = d.get("rows") or []
                    samp = rows[0] if rows else None
                    print(f"OK   {name:24s} rows={d.get('row_count'):<4} ms={d.get('ms')}  e.g. {samp}")
                else:
                    bad_n += 1
                    print(f"FAIL {name:24s} {d.get('error')}")
            except Exception as e:
                bad_n += 1
                print(f"ERR  {name:24s} {repr(e)[:140]}")
        print(f"\n{ok_n} ok, {bad_n} failed")

asyncio.run(main())
