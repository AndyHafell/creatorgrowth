# usage_budget.py — one cents-budget per user. Every paid AI action decrements it.
# Tiers differ ONLY by cap size. Cheap surfaces (Gemini text, Whisper) are absent = free.
from datetime import datetime, timezone

TIER_CAP = {"free": 100, "paid": 2000}  # cents/month. Tunable dials. free=$1.00, paid=$20.00


def current_period(now=None):
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m")  # e.g. "2026-06"


def _next_period_label(period):
    y, m = (int(x) for x in period.split("-"))
    y2, m2 = (y + 1, 1) if m == 12 else (y, m + 1)
    return f"{y2:04d}-{m2:02d}-01"


def _ensure_period(conn, uid):
    """Lazy monthly reset: stored period != this month -> zero the usage."""
    row = conn.execute("SELECT usage_cents, usage_period FROM users WHERE id=?", (uid,)).fetchone()
    period = current_period()
    if row is None:
        return 0, period
    if row["usage_period"] != period:
        conn.execute("UPDATE users SET usage_cents=0, usage_period=? WHERE id=?", (period, uid))
        conn.commit()
        return 0, period
    return (row["usage_cents"] or 0), period


def tier_of(conn, uid):
    row = conn.execute("SELECT tier FROM users WHERE id=?", (uid,)).fetchone()
    return (row["tier"] if row and row["tier"] else "free")


def cap_for(conn, uid):
    return TIER_CAP.get(tier_of(conn, uid), TIER_CAP["free"])


# Approximate cost per AI action, in cents. Estimates — the cap is generous, precision is noise.
COST = {
    "image_flux":    4,    # Replicate Flux 1.1 Pro / Fill Pro thumbnail
    "image_pro":     20,   # Gemini 3 Pro Image (pixel-face / hi-res)
    "tts_voiceover": 30,   # ElevenLabs SAY-doc narration (per generation)
    "claude_review": 8,    # Claude Sonnet AI Final Review (per call)
}


def can_afford(conn, uid, action, qty=1):
    cost = COST.get(action, 0) * qty
    if cost == 0:
        return True
    used, _ = _ensure_period(conn, uid)
    return (used + cost) <= cap_for(conn, uid)


def record_spend(conn, uid, action, qty=1):
    cost = COST.get(action, 0) * qty
    if cost == 0:
        return
    used, period = _ensure_period(conn, uid)
    conn.execute("UPDATE users SET usage_cents=?, usage_period=? WHERE id=?",
                 (used + cost, period, uid))
    conn.commit()


def usage_summary(conn, uid):
    used, period = _ensure_period(conn, uid)
    cap = cap_for(conn, uid)
    return {
        "tier": tier_of(conn, uid),
        "used_cents": used,
        "cap_cents": cap,
        "remaining_cents": max(0, cap - used),
        "period": period,
        "resets": _next_period_label(period),
    }
