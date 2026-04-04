"""
stripe_tool.py
───────────────
AURA MCP tool — Stripe payments and customer management.

Manage customers, payment intents, subscriptions, and invoices via Stripe API.
Read-focused operations suitable for CRM and financial analytics workflows.

Requires API key: set AURA_STRIPE_API_KEY in .env (use test key: sk_test_...)
Get key: https://dashboard.stripe.com/apikeys
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "stripe",
    "description": (
        "Stripe payment and customer management. "
        "Operations: list_customers, get_customer, list_charges, list_subscriptions, "
        "get_subscription, list_invoices, create_payment_intent, retrieve_balance. "
        "Use test API key (sk_test_...) for development. "
        "Useful for revenue analysis, customer lookup, and subscription management."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["list_customers", "get_customer", "list_charges",
                         "list_subscriptions", "get_subscription",
                         "list_invoices", "create_payment_intent", "retrieve_balance"],
                "description": "Stripe operation to perform",
            },
            "customer_id": {
                "type": "string",
                "description": "Stripe customer ID, e.g. 'cus_...' (for get_customer, list_charges, list_invoices)",
            },
            "subscription_id": {
                "type": "string",
                "description": "Stripe subscription ID (for get_subscription)",
            },
            "amount": {
                "type": "integer",
                "description": "Amount in smallest currency unit, e.g. cents (for create_payment_intent)",
            },
            "currency": {
                "type": "string",
                "description": "ISO 4217 currency code, e.g. 'usd' (for create_payment_intent)",
                "default": "usd",
            },
            "limit": {
                "type": "integer",
                "description": "Max results for list operations (default: 20, max: 100)",
                "default": 20,
            },
            "email": {
                "type": "string",
                "description": "Filter customers by email (for list_customers)",
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")

    try:
        from app.tools._mcp_wrapper import _get_setting
        api_key = _get_setting("stripe_api_key") or ""
    except Exception:
        import os
        api_key = os.environ.get("AURA_STRIPE_API_KEY", "")

    if not api_key:
        return {
            "error": "Stripe API key not configured",
            "hint":  "Set AURA_STRIPE_API_KEY in .env (use sk_test_... for development)",
        }

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    base    = "https://api.stripe.com/v1"
    headers = {"Authorization": f"Bearer {api_key}"}
    limit   = min(int(inputs.get("limit", 20)), 100)

    def _fmt_list(data: list, fields: list) -> list:
        return [{f: item.get(f, "") for f in fields} for item in data]

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if operation == "retrieve_balance":
                resp = await client.get(f"{base}/balance", headers=headers)
                resp.raise_for_status()
                return resp.json()

            elif operation == "list_customers":
                params = {"limit": limit}
                if inputs.get("email"):
                    params["email"] = inputs["email"]
                resp = await client.get(f"{base}/customers", headers=headers, params=params)
                resp.raise_for_status()
                data = resp.json().get("data", [])
                return {"customers": _fmt_list(data, ["id", "email", "name", "created", "currency"])}

            elif operation == "get_customer":
                cid = inputs.get("customer_id", "")
                if not cid:
                    return {"error": "customer_id required"}
                resp = await client.get(f"{base}/customers/{cid}", headers=headers)
                resp.raise_for_status()
                return resp.json()

            elif operation == "list_charges":
                params = {"limit": limit}
                if inputs.get("customer_id"):
                    params["customer"] = inputs["customer_id"]
                resp = await client.get(f"{base}/charges", headers=headers, params=params)
                resp.raise_for_status()
                data = resp.json().get("data", [])
                return {"charges": _fmt_list(data, ["id", "amount", "currency", "status", "created", "customer"])}

            elif operation == "list_subscriptions":
                params = {"limit": limit}
                if inputs.get("customer_id"):
                    params["customer"] = inputs["customer_id"]
                resp = await client.get(f"{base}/subscriptions", headers=headers, params=params)
                resp.raise_for_status()
                data = resp.json().get("data", [])
                return {"subscriptions": _fmt_list(data, ["id", "status", "current_period_end", "customer", "plan"])}

            elif operation == "get_subscription":
                sid = inputs.get("subscription_id", "")
                if not sid:
                    return {"error": "subscription_id required"}
                resp = await client.get(f"{base}/subscriptions/{sid}", headers=headers)
                resp.raise_for_status()
                return resp.json()

            elif operation == "list_invoices":
                params = {"limit": limit}
                if inputs.get("customer_id"):
                    params["customer"] = inputs["customer_id"]
                resp = await client.get(f"{base}/invoices", headers=headers, params=params)
                resp.raise_for_status()
                data = resp.json().get("data", [])
                return {"invoices": _fmt_list(data, ["id", "amount_due", "amount_paid", "status", "created", "customer"])}

            elif operation == "create_payment_intent":
                amount   = inputs.get("amount")
                currency = inputs.get("currency", "usd")
                if not amount:
                    return {"error": "amount required (in smallest currency unit, e.g. cents)"}
                resp = await client.post(
                    f"{base}/payment_intents",
                    headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
                    data={"amount": str(amount), "currency": currency},
                )
                resp.raise_for_status()
                pi = resp.json()
                return {"id": pi.get("id"), "status": pi.get("status"), "client_secret": pi.get("client_secret")}

    except Exception as exc:
        logger.error("[stripe_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
