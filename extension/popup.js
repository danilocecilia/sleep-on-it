// Regret Check: toolbar popup. Settings live in chrome.storage.sync;
// content.js and background.js read the same keys.

const DEFAULTS = { threshold: 60, enabled: true, disabledSites: [], followUpMinutes: 7 * 24 * 60 };
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let site = null; // hostname of the active tab, if it's a normal web page

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url ?? "");
    if (url.protocol === "http:" || url.protocol === "https:") site = url.hostname;
  } catch {}

  $("enabled").onchange = (e) => save({ enabled: e.target.checked });
  $("site-on").onchange = (e) => setSite(site, e.target.checked);
  $("threshold").oninput = (e) => { $("threshold-value").textContent = `${e.target.value}%`; };
  $("threshold").onchange = (e) => save({ threshold: Number(e.target.value) });
  $("follow-up").onchange = (e) => save({ followUpMinutes: Number(e.target.value) });
  render();
  showWaiting();
}

// Unanswered "Do you regret it?" questions, same rule as background.js.
async function showWaiting() {
  const all = await chrome.storage.local.get(null);
  const n = Object.entries(all)
    .filter(([key, item]) => key.startsWith("fu-") && (item.dueAt ?? 0) <= Date.now()).length;
  const btn = $("waiting");
  btn.hidden = n === 0;
  $("waiting-text").replaceChildren(
    Object.assign(document.createElement("strong"), { textContent: "Do you regret it?" }),
    Object.assign(document.createElement("small"), { textContent: `${n} question${n === 1 ? "" : "s"} waiting` }),
  );
  btn.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("followup.html") });
}

function save(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.sync.set(patch);
  render();
}

function setSite(host, on) {
  const rest = settings.disabledSites.filter((s) => s !== host);
  save({ disabledSites: on ? rest : [...rest, host].sort() });
}

function render() {
  $("enabled").checked = settings.enabled;
  $("main").classList.toggle("off", !settings.enabled);
  const siteOff = site && settings.disabledSites.includes(site);
  $("status").textContent = !settings.enabled
    ? "Off everywhere · nothing is sent"
    : siteOff
      ? "Off on this site"
      : `On · pausing at ${settings.threshold}% risk or more`;

  const siteOn = site && !settings.disabledSites.includes(site);
  $("site").textContent = site ?? "this page";
  $("site-on").checked = Boolean(siteOn);
  $("site-on").disabled = !site || !settings.enabled;
  $("site-hint").textContent = !site ? "Only works on web pages." : !settings.enabled ? "Turned off everywhere." : "";
  $("site-hint").hidden = !$("site-hint").textContent;

  $("threshold").value = settings.threshold;
  $("threshold-value").textContent = `${settings.threshold}%`;
  $("follow-up").value = String(settings.followUpMinutes);

  const list = $("paused");
  list.replaceChildren(
    ...settings.disabledSites.map((host) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = host;
      const btn = document.createElement("button");
      btn.textContent = "Turn on";
      btn.setAttribute("aria-label", `Turn on for ${host}`);
      btn.onclick = () => setSite(host, true);
      li.append(name, btn);
      return li;
    })
  );
  $("paused-group").hidden = settings.disabledSites.length === 0;
}

init();
