"""
SEC EDGAR — MCP tool wrapper.

Search US Securities and Exchange Commission filings (10-K, 10-Q, 8-K, etc.).
Completely free, no API key required. Public REST API.
"""

from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)

_EFTS_URL = "https://efts.sec.gov/LATEST/search-index"
_EDGAR_FULL_TEXT = "https://efts.sec.gov/LATEST/search-index"
_EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index"
_COMPANY_URL = "https://www.sec.gov/cgi-bin/browse-edgar"
_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
_FULL_TEXT_SEARCH = "https://efts.sec.gov/LATEST/search-index"

# SEC requires a user-agent header identifying the caller
_HEADERS = {"User-Agent": "AURA/1.0 (aura-agent@gleipnirconsulting.com)"}

TOOL_DEF = {
    "name": "sec_edgar",
    "description": (
        "Search SEC EDGAR for corporate filings (10-K, 10-Q, 8-K, S-1, proxy statements, etc.). "
        "Returns filing metadata including company name, filing type, date, and document URL. "
        "Free public API — no authentication required."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query":       {"type": "string", "description": "Search terms (company name, ticker, or topic)"},
            "filing_type": {"type": "string", "description": "Filing type filter: '10-K', '10-Q', '8-K', 'S-1', etc."},
            "date_from":   {"type": "string", "description": "Start date (YYYY-MM-DD)"},
            "date_to":     {"type": "string", "description": "End date (YYYY-MM-DD)"},
            "limit":       {"type": "integer", "description": "Max results (default 10)", "default": 10},
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    query       = inputs.get("query", "")
    filing_type = inputs.get("filing_type", "")
    date_from   = inputs.get("date_from", "")
    date_to     = inputs.get("date_to", "")
    limit       = inputs.get("limit", 10)

    if not query:
        return {"error": "query is required"}

    try:
        params = {"q": query, "dateRange": "custom", "startdt": date_from, "enddt": date_to}
        if filing_type:
            params["forms"] = filing_type
        # Remove empty params
        params = {k: v for k, v in params.items() if v}
        if "dateRange" in params and not date_from:
            del params["dateRange"]

        async with httpx.AsyncClient(timeout=15.0, headers=_HEADERS) as client:
            # Full-text search endpoint
            r = await client.get("https://efts.sec.gov/LATEST/search-index", params=params)

            if r.status_code == 200:
                data = r.json()
                hits = data.get("hits", {}).get("hits", [])
                filings = []
                for hit in hits[:limit]:
                    src = hit.get("_source", {})
                    accession_no = src.get("accession_no", "")
                    company_name = src.get("display_names", [""])[0] if src.get("display_names") else src.get("entity_name", "")
                    filing_entry = {
                        "company":     company_name,
                        "filing_type": src.get("form_type", ""),
                        "filed_date":  src.get("file_date", ""),
                        "description": src.get("display_date_filed", ""),
                        "url":         f"https://www.sec.gov/Archives/edgar/data/{src.get('entity_id', '')}/{src.get('file_num', '')}",
                        "accession":   accession_no,
                    }
                    filings.append(filing_entry)
                    # Absorb filing metadata into LightRAG knowledge graph (non-blocking)
                    if accession_no:
                        filing_text = (
                            f"SEC Filing — {company_name}\n"
                            f"Type: {filing_entry['filing_type']}  Filed: {filing_entry['filed_date']}\n"
                            f"Accession: {accession_no}\nURL: {filing_entry['url']}"
                        )
                        try:
                            from app.service.lightrag_service import LightRAGService
                            LightRAGService.get_instance().enqueue_ingest(
                                filing_text, accession_no, "legislation"
                            )
                        except Exception as _lg_exc:
                            import logging as _lg; _lg.getLogger(__name__).debug("[sec_edgar] LightRAG enqueue failed: %s", _lg_exc)
                return {"filings": filings, "total": data.get("hits", {}).get("total", {}).get("value", 0), "query": query}

            # Fallback: company search
            r2 = await client.get(
                _COMPANY_URL,
                params={"company": query, "CIK": "", "type": filing_type or "", "dateb": "", "owner": "include", "count": str(limit), "action": "getcompany", "output": "atom"},
            )
            return {"raw": r2.text[:2000], "query": query, "note": "Returned raw EDGAR atom feed"}

    except Exception as exc:
        logger.error("[sec_edgar] %s", exc)
        return {"error": str(exc)}
