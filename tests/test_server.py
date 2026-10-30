import math

from fastapi.testclient import TestClient

import server


def test_clean_handles_ib_placeholders():
    assert server.clean(None) is None
    assert server.clean("abc") is None
    assert server.clean(float("nan")) is None
    assert server.clean(math.inf) is None
    assert server.clean("12.5") == 12.5
    assert server.clean(3) == 3.0


def test_demo_feed_refresh_is_consistent():
    feed = server.DemoFeed()
    feed.refresh()
    st = feed.state

    assert st["status"] == "demo"
    assert len(st["positions"]) == len(server.DemoFeed.BOOK)

    position_value = sum(p["value"] for p in st["positions"])
    assert math.isclose(
        st["summary"]["NetLiquidation"],
        st["summary"]["TotalCashValue"] + position_value,
        abs_tol=0.05,
    )
    unrealized = sum(p["unrlPnl"] for p in st["positions"])
    assert math.isclose(st["pnl"]["unrealized"], unrealized, abs_tol=0.05)


def test_record_history_skips_unknown_pnl_and_appends_samples():
    feed = server.DemoFeed()
    feed.record_history()
    assert feed.state["history"] == []

    feed.refresh()
    feed.record_history()
    feed.record_history()
    assert len(feed.state["history"]) == 2


def test_app_serves_page_and_streams_state():
    app = server.create_app(server.DemoFeed())
    with TestClient(app) as client:
        page = client.get("/")
        assert page.status_code == 200
        assert "IBKR Live Dashboard" in page.text

        assert client.get("/static/app.js").status_code == 200

        with client.websocket_connect("/ws") as ws:
            snapshot = ws.receive_json()
            assert snapshot["mode"] == "demo"
            assert {"summary", "pnl", "positions", "history"} <= snapshot.keys()
