from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional
import httpx

AEGIS_BASE = "https://platform.aegis-hedging.com"
_TOKEN: Optional[str] = None
_TOKEN_EXPIRY: float = 0.0

def _quote_csv(text: str) -> str:
    return ",".join([p.strip() for p in text.split(",") if p.strip()])

async def get_token() -> str:
    global _TOKEN, _TOKEN_EXPIRY
    if _TOKEN and time.time() < _TOKEN_EXPIRY:
        return _TOKEN

    client_id = os.getenv("AEGIS_CLIENT_ID")
    client_secret = os.getenv("AEGIS_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("Missing AEGIS_CLIENT_ID / AEGIS_CLIENT_SECRET")

    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            f"{AEGIS_BASE}/api/token",
            json={"client_id": client_id, "client_secret": client_secret},
            headers={"Content-Type": "application/json"},
        )
        res.raise_for_status()
        data = res.json()

    _TOKEN = data["access_token"]
    expires_in = int(data.get("expires_in", 3600))
    _TOKEN_EXPIRY = time.time() + max(60, expires_in - 300)
    return _TOKEN

async def aegis_get(path: str) -> Dict[str, Any]:
    token = await get_token()
    async with httpx.AsyncClient(timeout=60.0) as client:
        res = await client.get(
            f"{AEGIS_BASE}{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        res.raise_for_status()
        return res.json()

async def ping() -> Dict[str, Any]:
    client_id = os.getenv("AEGIS_CLIENT_ID")
    return {"ok": True, "has_creds": bool(client_id)}

async def entities() -> Dict[str, Any]:
    return await aegis_get("/odata/Entities")

async def combined_curves(as_of_date: str, product_codes: str, start_date: str, end_date: str) -> Dict[str, Any]:
    codes = _quote_csv(product_codes)
    path = (
        f"/odata/CombinedCurves.ForDateRange("
        f"asOfDate={as_of_date},productCodes='{codes}',startDate={start_date},endDate={end_date})"
    )
    return await aegis_get(path)

def normalize_combined_curves(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = payload.get("value", []) if isinstance(payload, dict) else []
    out: List[Dict[str, Any]] = []
    for row in rows:
        out.append({
            "product_code": row.get("ProductCode"),
            "date": row.get("Date"),
            "settlement_price": row.get("SettlementPrice"),
            "forward_price": row.get("ForwardPrice"),
            "price": row.get("ForwardPrice") if row.get("ForwardPrice") is not None else row.get("SettlementPrice"),
            "is_forward": row.get("ForwardPrice") is not None,
        })
    return out
