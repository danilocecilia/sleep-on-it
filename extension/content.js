// Regret Check: content script.
// Intercepts "point of no return" clicks, asks the background worker for a
// regret score, and shows a pause card when the score crosses the threshold.

// English, Portuguese and French, since Canadian sites switch between EN/FR.
const COMMIT_WORDS = new RegExp(
  "\\b(place (your )?order|buy now|checkout|check out|pay now|complete purchase|" +
  "send|reply all|post|tweet|publish|submit|unsubscribe|delete account|accept offer|confirm|" +
  "enviar|comprar|finalizar compra|publicar|envoyer|acheter|publier|commander)\\b",
  "i"
);
const pageLoadedAt = Date.now();
const log = (...args) => console.log("[Regret Check]", ...args);
log("loaded on", location.hostname);

// On/off state is cached here because the click handler must decide synchronously,
// before preventDefault. Off means the click is never touched and nothing is sent.
let active = true;
function applySettings({ enabled = true, disabledSites = [] }) {
  active = enabled && !disabledSites.includes(location.hostname);
}
chrome.storage.sync.get(["enabled", "disabledSites"]).then(applySettings);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !chrome.runtime?.id) return;
  chrome.storage.sync.get(["enabled", "disabledSites"]).then(applySettings);
});
let approvedEl = null;

function labelOf(el) {
  return (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80);
}

function findCommitButton(target) {
  const el = target.closest?.('button, [role="button"], input[type="submit"], a');
  if (!el) return null;
  return COMMIT_WORDS.test(labelOf(el)) ? el : null;
}

// The draft is the longest text field near the button (Gmail's compose box holds
// recipients and subject too; the body is the longest). Walk up until one appears.
function draftText(button) {
  const editable = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
  for (let scope = button.parentElement; scope; scope = scope.parentElement) {
    const texts = [...scope.querySelectorAll(editable)]
      .map((el) => (el.value ?? el.innerText ?? "").trim())
      .filter(Boolean);
    if (texts.length) return texts.sort((a, b) => b.length - a.length)[0].slice(0, 2000);
  }
  return "";
}

function pricesOnPage() {
  const found = document.body.innerText.match(/[$€£]\s?\d[\d,]*(\.\d{2})?/g) || [];
  return [...new Set(found)].slice(0, 5);
}

function buildState(el) {
  return {
    site: location.hostname,
    pageTitle: document.title.slice(0, 120),
    action: labelOf(el),
    draft: draftText(el),
    prices: pricesOnPage(),
    localTime: new Date().toLocaleString(),
    secondsOnPage: Math.round((Date.now() - pageLoadedAt) / 1000),
    cameFrom: document.referrer ? new URL(document.referrer).hostname : "direct",
  };
}

// The click is going through: ask in a while whether it was regretted.
// Only scored clicks (they have a checkId) can be joined to a prediction.
function followUp(state, res) {
  if (res?.checkId) chrome.runtime.sendMessage({ type: "followup", checkId: res.checkId, state, regret: res.regret });
}

function release(el) {
  approvedEl = el;
  el.click(); // synthetic click: isTrusted is false, see README limitations
}

document.addEventListener(
  "click",
  async (e) => {
    if (!active) return;
    const el = findCommitButton(e.target);
    if (!el) return;
    if (el === approvedEl) { approvedEl = null; return; }
    // Extension reloaded or updated: this copy is orphaned and can't reach the worker.
    // Stay out of the way instead of swallowing the click.
    if (!chrome.runtime?.id) return;

    // Must happen synchronously, before any await.
    e.preventDefault();
    e.stopImmediatePropagation();

    const state = buildState(el);
    log("intercepted", JSON.stringify(state.action), "draft:", JSON.stringify(state.draft.slice(0, 120)));
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "check", state });
    } catch (err) {
      log("check failed, letting the click through:", err.message);
    }
    log("score", res);

    // Fail open: if the backend is down or the score is low, let the click through.
    if (!res || res.error || res.regret < res.threshold) {
      followUp(state, res);
      return release(el);
    }
    showCard(el, state, res);
  },
  true // capture phase, so we run before the site's own handlers
);

function showCard(el, state, res) {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const score = Math.round(res.regret);
  const tone = score >= 80 ? "high" : score >= 60 ? "mid" : "low";

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        --ink: #1F2A44; --paper: #FFFFFF; --muted: #5B6478; --track: #E6E9F0;
        --low: #3E8E7E; --mid: #E0A33B; --high: #C8553D;
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
        width: min(320px, calc(100vw - 40px)); box-sizing: border-box;
        padding: 18px; border-radius: 14px; background: var(--paper); color: var(--ink);
        font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 12px 32px rgba(31, 42, 68, .22);
      }
      @media (prefers-color-scheme: dark) {
        .card { --ink: #EDF0F7; --paper: #1B2233; --muted: #A3ABBD; --track: #2C3550; }
      }
      .title { margin: 0 0 12px; font-size: 16px; font-weight: 650; }
      .meter { height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; }
      .fill { height: 100%; width: ${score}%; background: var(--${tone}); }
      .pct { margin: 8px 0 4px; font-weight: 600; }
      .why { margin: 0 0 14px; padding-left: 18px; color: var(--muted); }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      button {
        font: inherit; cursor: pointer; border-radius: 8px; padding: 8px 12px;
        border: 1px solid var(--ink);
      }
      .hold { background: var(--ink); color: var(--paper); }
      .go { background: transparent; color: var(--ink); }
      button:focus-visible { outline: 3px solid var(--mid); outline-offset: 2px; }
    </style>
    <div class="card" role="alertdialog" aria-labelledby="t" aria-describedby="p">
      <p id="t" class="title">Pause for a second?</p>
      <div class="meter" aria-hidden="true"><div class="fill"></div></div>
      <p id="p" class="pct"></p>
      <ul class="why"></ul>
      <div class="actions">
        <button class="hold">Hold 10 minutes</button>
        <button class="go"></button>
      </div>
    </div>`;

  // Dynamic text goes in via textContent, never innerHTML.
  root.querySelector(".pct").textContent = `${score}% regret risk`;
  root.querySelector(".go").textContent = `${state.action || "Continue"} anyway`;
  const why = root.querySelector(".why");
  for (const reason of res.reasons || []) {
    const li = document.createElement("li");
    li.textContent = reason;
    why.append(li);
  }

  const close = (outcome) => {
    host.remove();
    chrome.runtime.sendMessage({ type: "outcome", checkId: res.checkId, state, regret: res.regret, outcome });
  };
  root.querySelector(".hold").onclick = () => {
    chrome.runtime.sendMessage({ type: "hold", state });
    close("held");
  };
  root.querySelector(".go").onclick = () => { close("continued"); followUp(state, res); release(el); };
  root.addEventListener("keydown", (e) => { if (e.key === "Escape") close("dismissed"); });

  document.documentElement.append(host);
  root.querySelector(".hold").focus();
}
