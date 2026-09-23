// Regret Check: lists follow-up questions that are due and records the answers.
// Answers go through the service worker, which posts them to the server.

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function render() {
  const all = await chrome.storage.local.get(null);
  const due = Object.entries(all)
    .filter(([key, item]) => key.startsWith("fu-") && (item.dueAt ?? 0) <= Date.now())
    .sort(([, a], [, b]) => a.at - b.at);

  const list = document.getElementById("list");
  list.replaceChildren(...due.map(([id, item]) => row(id, item)));
  document.getElementById("empty").hidden = due.length > 0;
}

function row(id, item) {
  const li = document.createElement("li");

  const what = document.createElement("p");
  what.className = "what";
  what.textContent = `You clicked "${item.state.action}" on ${item.state.site}`;

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [ago(Date.now() - item.at), item.state.pageTitle].filter(Boolean).join(" · ");

  const actions = document.createElement("div");
  actions.className = "actions";
  const status = document.createElement("p");
  status.className = "status";

  const buttons = [
    ["Yes, I regret it", true, "yes"],
    ["No, glad I did", false, "no"],
  ].map(([label, regretted, cls]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = cls;
    b.onclick = async () => {
      buttons.forEach((x) => (x.disabled = true));
      const res = await chrome.runtime.sendMessage({ type: "answer", id, regretted });
      if (res?.ok) {
        li.classList.add("done");
        actions.remove();
        status.textContent = regretted ? "Saved: you regret it." : "Saved: glad you did it.";
      } else {
        buttons.forEach((x) => (x.disabled = false));
        status.className = "status error";
        status.textContent = "Couldn't reach the server. Is it running? Try again.";
      }
    };
    return b;
  });
  actions.append(...buttons);

  li.append(what, meta, actions, status);
  return li;
}

render();
