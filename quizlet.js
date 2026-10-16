// Runs on quizlet.com. When the YouTube panel's "Send to Quizlet" left flashcards waiting, fill in Quizlet's
// create-set page: open its Import box, paste the cards, add a title. The user checks them and clicks Create.
// Quizlet has no public API for creating sets and its page can change, so everything is found by visible
// text and labels, and any failure falls back to "your cards are on the clipboard: Import, then paste".
// This runs in the user's own logged-in browser; no Quizlet login details are read or sent anywhere.

(() => {
  if (window.__ytaQuizletLoaded) return;
  window.__ytaQuizletLoaded = true;

  const FRESH_MS = 10 * 60 * 1000; // ignore cards left over from long ago
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs) {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(300)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  }

  const visible = (e) => !!e && e.offsetParent !== null;
  const label = (e) => `${e.innerText || ""} ${e.getAttribute("aria-label") || ""}`.trim();
  const buttons = (root = document) => [...root.querySelectorAll("button, [role=button]")].filter(visible);

  // React-controlled fields ignore a plain `.value =`; use the native setter and fire the events React listens to.
  function setValue(field, value) {
    if (field.isContentEditable) {
      field.focus();
      document.execCommand("selectAll");
      document.execCommand("insertText", false, value);
      return;
    }
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function banner(text, ok) {
    document.getElementById("yta-quizlet-banner")?.remove();
    const b = document.createElement("div");
    b.id = "yta-quizlet-banner";
    b.setAttribute("role", "status");
    Object.assign(b.style, {
      position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)", zIndex: 2147483647,
      maxWidth: "min(560px, calc(100vw - 32px))", padding: "12px 44px 12px 16px", borderRadius: "12px",
      background: ok ? "#1f7a35" : "#8a5a00", color: "#fff", font: "600 14px/1.45 system-ui, sans-serif",
      boxShadow: "0 8px 24px rgba(0,0,0,.25)"
    });
    b.textContent = text;
    const close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    Object.assign(close.style, {
      position: "absolute", top: "6px", right: "8px", border: "0", background: "transparent",
      color: "#fff", font: "700 20px/1 system-ui, sans-serif", cursor: "pointer", padding: "4px 6px"
    });
    close.onclick = () => b.remove();
    b.append(close);
    document.body.append(b);
  }

  let running = false;

  async function run() {
    if (running || !chrome.runtime?.id) return;
    const { quizletPending: job } = await chrome.storage.local.get("quizletPending");
    if (!job || Date.now() - job.at > FRESH_MS) return;
    if (/\/(login|sign-?up)/.test(location.pathname)) {
      banner("Log in to Quizlet and your flashcards from AI Agent for YouTube will be filled in for you.", true);
      return;
    }
    if (!/create/.test(location.pathname)) return;

    running = true;
    try {
      const importBtn = await waitFor(() => buttons().find((b) => /^\+?\s*import\b/i.test(label(b))), 15000);
      if (!importBtn) throw new Error("Import button not found");
      importBtn.click();

      // The import box: a visible textarea, preferably in a dialog or asking to paste.
      const box = await waitFor(() => {
        const areas = [...document.querySelectorAll("textarea")].filter(visible);
        return areas.find((t) => t.closest("[role=dialog]") || /paste|copy|word/i.test(`${t.placeholder} ${label(t)}`)) || null;
      }, 8000);
      if (!box) throw new Error("Import box not found");
      setValue(box, job.text);
      await sleep(700); // let Quizlet build its preview

      const scope = box.closest("[role=dialog]") || document;
      const confirm = await waitFor(() => buttons(scope).filter((b) => b !== importBtn && /^import\b/i.test(label(b))).at(-1), 5000);
      if (!confirm) throw new Error("Import confirm button not found");
      confirm.click();
      await sleep(800);

      const title = [...document.querySelectorAll("input, textarea, [contenteditable=true]")]
        .find((f) => visible(f) && /title/i.test(`${f.placeholder || ""} ${f.getAttribute("aria-label") || ""} ${f.name || ""}`));
      if (title && !(title.value || title.textContent || "").trim()) setValue(title, job.title);

      banner(`Added ${job.count} flashcards from AI Agent for YouTube. Check them, then click Create.`, true);
    } catch {
      banner("Couldn't fill in Quizlet automatically. Your flashcards are on your clipboard: click Import, paste them (⌘V or Ctrl+V), then click Import.", false);
    } finally {
      await chrome.storage.local.remove("quizletPending");
      running = false;
    }
  }

  run();
  // Quizlet is a single-page app (e.g. login redirecting to the create page), so re-check when the URL changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; run(); }
  }, 1000);
})();
