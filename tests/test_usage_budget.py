import sqlite3
import usage_budget as ub


def mkconn():
    c = sqlite3.connect(":memory:"); c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, tier TEXT DEFAULT 'free', "
              "usage_cents INTEGER DEFAULT 0, usage_period TEXT)")
    c.execute("INSERT INTO users (id, tier) VALUES (1,'free'),(2,'paid')")
    c.commit(); return c


def test_free_user_can_afford_one_image():
    assert ub.can_afford(mkconn(), 1, "image_flux") is True


def test_free_user_blocked_over_cap():
    c = mkconn()
    ub.record_spend(c, 1, "image_flux", qty=25)   # 25*4 = 100c = free cap
    assert ub.can_afford(c, 1, "image_flux") is False


def test_paid_has_higher_cap():
    c = mkconn()
    ub.record_spend(c, 2, "image_flux", qty=25)    # 100c spent
    assert ub.can_afford(c, 2, "image_flux") is True  # paid cap 2000c


def test_cheap_actions_are_free():
    c = mkconn()
    assert ub.can_afford(c, 1, "gemini_text") is True   # not in COST -> free
    ub.record_spend(c, 1, "gemini_text")
    assert ub.usage_summary(c, 1)["used_cents"] == 0


def test_lazy_monthly_reset():
    c = mkconn()
    c.execute("UPDATE users SET usage_cents=90, usage_period='2000-01' WHERE id=1"); c.commit()
    assert ub.usage_summary(c, 1)["used_cents"] == 0
