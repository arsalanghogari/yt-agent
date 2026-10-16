// Print-ready study notes. The panel (content.js) saves the rendered notes to storage and opens this page;
// it lays them out and opens Chrome's print dialog, where "Save as PDF" creates the file.
// The notes HTML comes from the panel's own markdown renderer, which escapes everything it's given.

(async () => {
  const { notesPdf: n } = await chrome.storage.local.get("notesPdf");
  const $ = (id) => document.getElementById(id);
  $("print").addEventListener("click", () => window.print());
  if (!n) return;

  document.title = `${n.title} - study notes`; // also the PDF's suggested file name
  $("title").textContent = n.title;

  const meta = $("meta");
  if (n.channel) meta.append(`${n.channel} · `);
  const link = Object.assign(document.createElement("a"), { href: n.url, textContent: n.url.replace(/^https:\/\/www\./, "") });
  meta.append(link);

  $("notes").innerHTML = n.html;
  $("footer").textContent = `Made with Study Pal for YouTube · ${new Date(n.at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;

  // Let the page paint before the print dialog takes over.
  await document.fonts?.ready;
  requestAnimationFrame(() => setTimeout(() => window.print(), 150));
})();
