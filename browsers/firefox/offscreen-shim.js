// Firefox has no chrome.offscreen, and needs none: its event-page background
// already has a DOM. background.js drives narration through
// offscreen.html/offscreen.js by message, so this fills in the three
// chrome.offscreen calls it makes by hosting that same page in a hidden iframe
// of the background document. The iframe is a separate extension context, so
// runtime.sendMessage from the background reaches offscreen.js exactly as it
// does in Chrome.
export function installOffscreenShim(api = globalThis.chrome, doc = globalThis.document) {
  if (!api || api.offscreen) return;
  let frame = null;
  api.offscreen = {
    async hasDocument() {
      return !!frame;
    },
    async createDocument({ url }) {
      if (frame) throw new Error("Only a single offscreen document may be created.");
      const f = doc.createElement("iframe");
      f.hidden = true;
      f.src = api.runtime.getURL(url);
      // `load` waits for the page's module script, so offscreen.js's message
      // listener exists once this resolves.
      const loaded = new Promise((resolve, reject) => {
        f.addEventListener("load", resolve, { once: true });
        f.addEventListener("error", () => reject(new Error("offscreen document failed to load: " + url)), { once: true });
      });
      doc.body.appendChild(f);
      frame = f;
      try {
        await loaded;
      } catch (err) {
        f.remove(); // don't leave a dead frame that blocks every later attempt
        frame = null;
        throw err;
      }
    },
    async closeDocument() {
      if (!frame) throw new Error("No current offscreen document.");
      frame.remove();
      frame = null;
    },
  };
}
