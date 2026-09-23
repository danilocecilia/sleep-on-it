# Regret Check

A Chrome extension that pauses you before clicks you might regret, scored by Jev.

## How it fits together

```
 page click (capture phase)
        │  content.js: is this a "commit" button? grab page state
        ▼
 background.js ──POST /check──▶ main.py ──typesafe_sdk──▶ OpenRouter ──▶ Jev
        │   ◀── { regret, kind, reasons } ──┘
        ▼
 regret < threshold → release the click
 regret ≥ threshold → pause card: "Hold 10 minutes" or "Continue anyway"
        │
 Hold → chrome.alarms → notification 10 min later → reopens the tab
 Click went through → follow-up later: "Do you regret it?" Yes / No (at most 5 a day)
 Every check → checks.jsonl · every choice → POST /feedback → outcomes.jsonl
```

The API key lives only on the server. Never put it in the extension; anyone can unzip a .crx.

## Run it

1. Server (Python 3.14):
   ```
   pip install -r requirements.txt
   # Put your OpenRouter key in .env (TYPESAFE_API_KEY=sk-or-...); main.py loads it.
   # Jev is reached through OpenRouter; the SDK still reads the TYPESAFE_* names.
   python -m uvicorn main:app --port 8001
   ```
2. Extension: open `chrome://extensions`, turn on
   Developer mode, choose "Load unpacked" and pick the `extension` folder.
3. Calibration chart: `http://localhost:8001/calibration` (also linked from the popup). It bins
   answered follow-ups by Jev's predicted regret and plots how many were actually regretted.
4. Click the toolbar icon to set the threshold (default 60), switch checking off everywhere,
   or switch it off for the current site. Switched-off sites send nothing to the server.

## Known limits (read before building further)

- **Data files.** `checks.jsonl` holds every scored click with Jev's full probabilities;
  `outcomes.jsonl` holds card choices (`type: "outcome"`) and follow-up answers
  (`type: "followup"`, `regretted: true/false`), both joined to the check by `checkId`.
  `outcomes-old-scale.jsonl` is from the earlier `jev` package version (averaged 0–100 scores),
  kept apart because it is not comparable.
- **Synthetic clicks.** `release()` calls `el.click()`, so `isTrusted` is false. Gmail's Send
  accepts it (tested). Some checkouts
  (payment iframes, anti-bot flows) will ignore it. Fallback idea: on "Continue anyway", disable
  interception for that element and ask the user to click once more.
- **Not caught yet:** Enter / Ctrl+Enter submits, buttons inside cross-origin iframes, button
  labels outside the EN/PT/FR word list.
- **Privacy.** Draft text and page info go to your server, OpenRouter and TypeSafe. Before shipping,
  add a clear opt-in screen (the per-site on/off list is in the popup).
- **Score levels.** The Jev API allows at most 10 levels per score, so `impulse`, `heat` and
  `exposure` are asked on a 1–10 scale. `regret` is a yes/no question: its probability of "yes"
  is the percentage on the card.
- **Tested so far:** Gmail only, end to end through OpenRouter (pause card, Hold with
  notification, Continue anyway, popup switches and threshold). No checkout sites yet.

## Next steps worth doing

- Batch mode: use `.map` to score every open cart tab at once.
