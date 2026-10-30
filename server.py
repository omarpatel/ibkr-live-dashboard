"""IBKR Live Dashboard — a live Interactive Brokers account dashboard.

Connects to TWS / IB Gateway through the API socket in read-only mode and
streams account values, positions and PnL to the browser over a WebSocket.

Usage:
    python server.py            # connect to TWS (tries live port 7496, then paper 7497)
    python server.py --demo     # fake data, no TWS needed
    python server.py --port 8399
"""

import argparse
import asyncio
import contextlib
import math
import random
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).parent / "static"

# TWS ports: 7496 live, 7497 paper. IB Gateway: 4001 live, 4002 paper.
IB_PORTS = [(7496, "live"), (7497, "paper"), (4001, "live"), (4002, "paper")]
CLIENT_ID = 17
POLL_SECONDS = 2.0
HISTORY_MAX_POINTS = 4000  # ~2h+ at one point per poll

ACCOUNT_TAGS = [
    "NetLiquidation", "TotalCashValue", "BuyingPower", "GrossPositionValue",
    "AvailableFunds", "ExcessLiquidity", "FullMaintMarginReq", "FullInitMarginReq",
]


def clean(x):
    """IB uses float('nan') for not-yet-known values; JSON can't carry NaN."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


class Feed:
    """Shared state + client broadcast. Subclasses fill in `state`."""

    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.history: list[tuple[float, float]] = []  # (epoch, dailyPnL)
        self.state = {
            "status": "connecting",   # connecting | connected | demo
            "mode": None,             # live | paper | demo
            "account": None,
            "port": None,
            "currency": "USD",
            "summary": {},            # tag -> float
            "pnl": {"daily": None, "unrealized": None, "realized": None},
            "positions": [],
            "history": [],
            "updated": None,
        }

    def record_history(self):
        daily = self.state["pnl"]["daily"]
        if daily is None:
            return
        now = time.time()
        # New trading day (or first sample after a gap) -> start the line over.
        if self.history and now - self.history[-1][0] > 4 * 3600:
            self.history.clear()
        self.history.append((now, daily))
        del self.history[:-HISTORY_MAX_POINTS]
        self.state["history"] = [[round(t, 1), round(v, 2)] for t, v in self.history]

    async def broadcast(self):
        self.state["updated"] = time.time()
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(self.state)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def run(self):
        raise NotImplementedError


class IBFeed(Feed):
    """Live feed from TWS / IB Gateway via ib_async, read-only."""

    def __init__(self):
        super().__init__()
        self.ib = None  # created inside run() so it binds to the server's event loop
        self.pnl_singles = {}  # conId -> PnLSingle

    async def connect(self) -> bool:
        for port, mode in IB_PORTS:
            try:
                await self.ib.connectAsync(
                    "127.0.0.1", port, clientId=CLIENT_ID, readonly=True, timeout=4
                )
            except Exception:
                continue
            account = (self.ib.managedAccounts() or [None])[0]
            if account is None:
                self.ib.disconnect()
                continue
            self.state.update(status="connected", mode=mode, port=port, account=account)
            self.ib.reqPnL(account)
            await self.ib.accountSummaryAsync(account)
            return True
        return False

    def refresh(self):
        account = self.state["account"]

        summary = {}
        for row in self.ib.accountSummary(account):
            if row.tag in ACCOUNT_TAGS:
                summary[row.tag] = clean(row.value)
                if row.tag == "NetLiquidation" and row.currency:
                    self.state["currency"] = row.currency
        self.state["summary"] = summary

        pnls = self.ib.pnl()
        if pnls:
            p = pnls[0]
            self.state["pnl"] = {
                "daily": clean(p.dailyPnL),
                "unrealized": clean(p.unrealizedPnL),
                "realized": clean(p.realizedPnL),
            }

        portfolio = self.ib.portfolio()

        # Keep per-position daily-PnL subscriptions in sync with the portfolio.
        want = {item.contract.conId for item in portfolio if item.position}
        for con_id in want - self.pnl_singles.keys():
            self.pnl_singles[con_id] = self.ib.reqPnLSingle(account, "", con_id)
        for con_id in self.pnl_singles.keys() - want:
            single = self.pnl_singles.pop(con_id)
            with contextlib.suppress(Exception):
                self.ib.cancelPnLSingle(account, "", single.conId)

        positions = []
        for item in portfolio:
            if not item.position:
                continue
            c = item.contract
            single = self.pnl_singles.get(c.conId)
            positions.append({
                "conId": c.conId,
                "symbol": c.symbol,
                "local": c.localSymbol or c.symbol,
                "secType": c.secType,
                "currency": c.currency,
                "qty": clean(item.position),
                "avgCost": clean(item.averageCost),
                "price": clean(item.marketPrice),
                "value": clean(item.marketValue),
                "dayPnl": clean(single.dailyPnL) if single else None,
                "unrlPnl": clean(item.unrealizedPNL),
                "rlzPnl": clean(item.realizedPNL),
            })
        self.state["positions"] = positions

    async def run(self):
        from ib_async import IB
        self.ib = IB()
        while True:
            if not self.ib.isConnected():
                self.state["status"] = "connecting"
                self.pnl_singles.clear()
                if not await self.connect():
                    await self.broadcast()
                    await asyncio.sleep(5)
                    continue
            try:
                self.refresh()
                self.record_history()
            except Exception:
                pass  # transient hiccup; keep the loop alive
            await self.broadcast()
            await asyncio.sleep(POLL_SECONDS)


class DemoFeed(Feed):
    """Random-walk fake data so the UI can be seen without TWS."""

    BOOK = [
        ("AAPL",  120, 191.40), ("NVDA", 200, 118.20), ("MSFT", 60, 428.10),
        ("SPY",   150, 552.70), ("TSLA", -50, 244.90), ("AMZN", 80, 186.30),
        ("META",  40, 517.60), ("GOOGL", 90, 172.80),
    ]

    def __init__(self):
        super().__init__()
        self.prices = {s: p0 * random.uniform(0.97, 1.05) for s, _, p0 in self.BOOK}
        self.opens = dict(self.prices)
        self.realized = random.uniform(-800, 1400)
        self.state.update(status="demo", mode="demo", account="DU0000000")

    def refresh(self):
        positions, gross, day_total, unrl_total = [], 0.0, 0.0, 0.0
        for sym, qty, cost in self.BOOK:
            drift = random.gauss(0, 0.0012)
            self.prices[sym] *= 1 + drift
            px = self.prices[sym]
            value = qty * px
            day = qty * (px - self.opens[sym])
            unrl = qty * (px - cost)
            gross += abs(value)
            day_total += day
            unrl_total += unrl
            positions.append({
                "conId": hash(sym) & 0xFFFF, "symbol": sym, "local": sym,
                "secType": "STK", "currency": "USD",
                "qty": qty, "avgCost": round(cost, 2), "price": round(px, 2),
                "value": round(value, 2), "dayPnl": round(day, 2),
                "unrlPnl": round(unrl, 2), "rlzPnl": 0.0,
            })
        cash = 231_450.0
        net = cash + sum(p["value"] for p in positions)
        self.state["positions"] = positions
        self.state["summary"] = {
            "NetLiquidation": round(net, 2),
            "TotalCashValue": cash,
            "BuyingPower": round(net * 4, 2),
            "GrossPositionValue": round(gross, 2),
            "AvailableFunds": round(net * 0.62, 2),
            "ExcessLiquidity": round(net * 0.68, 2),
            "FullMaintMarginReq": round(gross * 0.28, 2),
        }
        self.state["pnl"] = {
            "daily": round(day_total + self.realized, 2),
            "unrealized": round(unrl_total, 2),
            "realized": round(self.realized, 2),
        }

    async def run(self):
        while True:
            self.refresh()
            self.record_history()
            await self.broadcast()
            await asyncio.sleep(POLL_SECONDS)


def create_app(feed: Feed) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = asyncio.create_task(feed.run())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    app = FastAPI(title="IBKR Live Dashboard", lifespan=lifespan)

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        feed.clients.add(ws)
        await ws.send_json(feed.state)
        try:
            while True:
                await ws.receive_text()  # keepalive pings from the client
        except WebSocketDisconnect:
            pass
        finally:
            feed.clients.discard(ws)

    @app.get("/")
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def main():
    parser = argparse.ArgumentParser(description="IBKR live dashboard")
    parser.add_argument("--demo", action="store_true", help="fake data, no TWS needed")
    parser.add_argument("--port", type=int, default=8399, help="web port (default 8399)")
    args = parser.parse_args()

    feed = DemoFeed() if args.demo else IBFeed()
    app = create_app(feed)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
