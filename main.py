"""Regret Check backend.

Keeps the OpenRouter/TypeSafe API key off the client. Run with:
    python -m uvicorn main:app --port 8001
"""

import json
import math
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))  # TYPESAFE_* settings; must run before the client is built

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, Score

jev: AsyncTypeSafeClient  # set at startup: the client's connection pool is bound to the server's event loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    global jev
    async with AsyncTypeSafeClient() as jev:
        yield


app = FastAPI(lifespan=lifespan)
HERE = Path(__file__).parent
CHECKS = HERE / "checks.jsonl"  # every scored click, with Jev's full probabilities
OUTCOMES = HERE / "outcomes.jsonl"  # what the person chose on the pause card


class PageState(BaseModel):
    site: str
    pageTitle: str
    action: str
    draft: str = ""
    prices: list[str] = []
    localTime: str
    secondsOnPage: int
    cameFrom: str


# The API allows at most 10 levels per score. Jev reports the level index (0-9); we show 1-10.
LEVELS = ["1: not at all"] + [str(n) for n in range(2, 10)] + ["10: extremely"]

QUESTIONS = {
    # A yes/no question, so Jev returns a calibrated probability: the number the
    # calibration chart compares against what people later say.
    "regret": Noul(
        instructions="A week from now, will this person wish they had not done this?",
    ),
    "kind": Choice(
        instructions="What kind of commitment is this click about to make?",
        criteria={
            "purchase": "Buying or paying for something",
            "message": "Sending a message or email to specific people",
            "public_post": "Posting or publishing something publicly",
            "account_change": "Deleting, cancelling or changing an account or subscription",
            "other": None,
        },
    ),
    "impulse": Score(
        instructions="How impulsive does this look? Consider very little time on the page, "
        "arriving from an ad or sale, late-night timing and urgency language.",
        criteria=LEVELS,
    ),
    "heat": Score(
        instructions="How emotionally heated is the draft text compared with what the "
        "situation calls for? 1 if there is no draft.",
        criteria=LEVELS,
    ),
    "exposure": Score(
        instructions="How many people could see this, and how hard is it to take back? "
        "Reply-all and public posts are high; a private purchase is low.",
        criteria=LEVELS,
    ),
}

# Fixed copy for the card. Jev returns no text, so the reasons come from the scores.
REASONS = [
    ("impulse", 6, "This looks like an impulse move"),
    ("heat", 6, "The tone runs hotter than the situation needs"),
    ("exposure", 6, "A lot of people will see this, and it's hard to undo"),
]


def render(s: PageState) -> str:
    lines = [
        f'Someone is about to click "{s.action}" on {s.site} (page: {s.pageTitle}).',
        f"Local time: {s.localTime}. Time on this page: {s.secondsOnPage}s. "
        f"Arrived from: {s.cameFrom}.",
    ]
    if s.prices:
        lines.append("Prices visible on the page: " + ", ".join(s.prices))
    if s.draft:
        lines.append(f'Text they are about to send:\n"""\n{s.draft}\n"""')
    return "\n".join(lines)


def append(path: Path, record: dict) -> None:
    record["ts"] = datetime.now(timezone.utc).isoformat()
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


@app.post("/check")
async def check(state: PageState):
    response = await jev.system_one(state=render(state), questions=QUESTIONS)
    scores = {name: 1 + response.scores[name].score for name in ("impulse", "heat", "exposure")}
    check_id = uuid.uuid4().hex
    append(CHECKS, {
        "checkId": check_id,
        "state": state.model_dump(),
        "model": response.model,
        "answers": {name: a.model_dump() for name, a in response.answers.items()},
    })
    return {
        "checkId": check_id,
        "regret": round(response.nouls["regret"].noul * 100, 1),
        "kind": response.choices["kind"].choice,
        "reasons": [text for name, cut, text in REASONS if scores[name] >= cut],
    }


@app.post("/feedback")
async def feedback(payload: dict):
    # Joined to checks.jsonl by checkId for the calibration chart.
    append(OUTCOMES, payload)
    return {"ok": True}


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% interval for a rate of k out of n; honest at small n, unlike +/- 2 SE."""
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def calibration_data() -> dict:
    """Join follow-up answers to Jev's predictions and bin them by predicted regret."""
    checks = {c["checkId"]: c for c in read_jsonl(CHECKS)}
    answers = {}  # checkId -> latest answer
    for o in read_jsonl(OUTCOMES):
        if o.get("type") == "followup" and o.get("checkId") in checks:
            answers[o["checkId"]] = o["regretted"]

    points = [{"p": checks[cid]["answers"]["regret"]["noul"], "regretted": bool(r)} for cid, r in answers.items()]
    bins = []
    for i in range(5):
        lo, hi = i / 5, (i + 1) / 5
        inside = [pt for pt in points if lo <= pt["p"] < hi or (i == 4 and pt["p"] == 1)]
        n, k = len(inside), sum(pt["regretted"] for pt in inside)
        b = {"lo": lo, "hi": hi, "n": n, "regretted": k}
        if n:
            b["predicted"] = sum(pt["p"] for pt in inside) / n
            b["actual"] = k / n
            b["ciLow"], b["ciHigh"] = wilson(k, n)
        bins.append(b)

    return {
        "checks": len(checks),
        "answered": len(points),
        "regretted": sum(pt["regretted"] for pt in points),
        # Mean squared gap between prediction and outcome: 0 is perfect, 0.25 is a coin flip.
        "brier": sum((pt["p"] - pt["regretted"]) ** 2 for pt in points) / len(points) if points else None,
        "bins": bins,
    }


@app.get("/calibration", response_class=HTMLResponse)
async def calibration():
    page = (HERE / "calibration.html").read_text(encoding="utf-8")
    # "</" escaped so nothing in the data can close the <script> tag it sits in.
    return page.replace("__DATA__", json.dumps(calibration_data()).replace("</", r"<\/"))
