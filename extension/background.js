// Regret Check: service worker.
// Talks to your backend (which holds the API key), schedules held items and
// the "Do you regret it?" follow-ups that feed the calibration chart.

const API = "http://localhost:8001";
const FOLLOW_UPS_PER_DAY = 5; // keep the questions from becoming noise

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "check") { check(msg.state).then(reply); return true; }
  if (msg.type === "hold") hold(msg.state, sender.tab);
  if (msg.type === "outcome") post("/feedback", msg).catch(() => {});
  if (msg.type === "followup") scheduleFollowUp(msg);
  if (msg.type === "answer") { answer(msg.id, msg.regretted).then(reply); return true; }
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);

async function post(path, body, signal) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function check(state) {
  const { threshold = 60, enabled = true, disabledSites = [] } =
    await chrome.storage.sync.get(["threshold", "enabled", "disabledSites"]);
  if (!enabled || disabledSites.includes(state.site)) return { regret: 0, threshold };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500); // never block a click for long
  try {
    return { ...(await post("/check", state, ctrl.signal)), threshold };
  } catch {
    return { error: true, threshold }; // fail open
  } finally {
    clearTimeout(timer);
  }
}

async function hold(state, tab) {
  const id = `held-${Date.now()}`;
  await chrome.storage.local.set({ [id]: { state, url: tab?.url } });
  chrome.alarms.create(id, { delayInMinutes: 10 });
}

// A click went through: ask later whether it was regretted. Keyed by checkId so the
// answer joins the prediction in checks.jsonl.
async function scheduleFollowUp({ checkId, state, regret }) {
  const { followUpMinutes = 7 * 24 * 60 } = await chrome.storage.sync.get("followUpMinutes");
  if (!checkId || !followUpMinutes) return;

  const day = `fuCount-${new Date().toISOString().slice(0, 10)}`;
  const { [day]: count = 0 } = await chrome.storage.local.get(day);
  if (count >= FOLLOW_UPS_PER_DAY) return;

  const id = `fu-${checkId}`;
  const { site, action, pageTitle } = state;
  await chrome.storage.local.set({
    [day]: count + 1,
    [id]: {
      checkId, regret, at: Date.now(), dueAt: Date.now() + followUpMinutes * 60000,
      state: { site, action, pageTitle },
    },
  });
  chrome.alarms.create(id, { delayInMinutes: followUpMinutes });
}

// Follow-ups whose time has come and that haven't been answered. They stay in storage
// until answered, so a notification Windows dropped or cleared doesn't lose the question.
async function dueFollowUps() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key, item]) => key.startsWith("fu-") && (item.dueAt ?? 0) <= Date.now())
    .map(([id, item]) => ({ id, ...item }));
}

async function updateBadge() {
  const n = (await dueFollowUps()).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#C8553D" });
}

async function answer(id, regretted) {
  const { [id]: item } = await chrome.storage.local.get(id);
  if (!item) return { ok: false };
  try {
    await post("/feedback", {
      type: "followup",
      checkId: item.checkId,
      regret: item.regret,
      regretted,
      askedAfterMinutes: Math.round((Date.now() - item.at) / 60000),
    });
  } catch {
    return { ok: false }; // server down: keep the question for later
  }
  await chrome.storage.local.remove(id);
  chrome.notifications.clear(id);
  updateBadge();
  return { ok: true };
}

function openFollowUps() {
  chrome.tabs.create({ url: chrome.runtime.getURL("followup.html") });
}

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  const { [name]: item } = await chrome.storage.local.get(name);
  if (!item) return;
  if (name.startsWith("held-")) {
    chrome.notifications.create(name, {
      type: "basic",
      iconUrl: "icon.png",
      title: "Still want to do this?",
      message: `${item.state.action} on ${item.state.site}`,
    });
  } else if (name.startsWith("fu-")) {
    const { action, site, pageTitle } = item.state;
    chrome.notifications.create(name, {
      type: "basic",
      iconUrl: "icon.png",
      title: "Do you regret it?",
      message: `${ago(Date.now() - item.at)} you clicked "${action}" on ${site}.`,
      contextMessage: pageTitle,
      buttons: [{ title: "Yes, I regret it" }, { title: "No, glad I did" }],
      requireInteraction: true,
    });
    updateBadge();
  }
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id.startsWith("fu-")) answer(id, index === 0);
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (id.startsWith("fu-")) {
    chrome.notifications.clear(id);
    return openFollowUps(); // the question stays stored until answered on that page
  }
  if (!id.startsWith("held-")) return;
  const { [id]: item } = await chrome.storage.local.get(id);
  if (item?.url) chrome.tabs.create({ url: item.url });
  chrome.notifications.clear(id);
  chrome.storage.local.remove(id);
});
