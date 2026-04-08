// polyfill-file.js
// Dynamically import the ESM `fetch-blob` package and set the global File.
if (typeof globalThis.File === "undefined") {
  // Minimal, synchronous File constructor. It intentionally implements only
  // the shape used by `undici`'s WebIDL checks (constructor + prototype).
  class MinimalFile {
    constructor(_bits = [], name = "", options = {}) {
      this.name = String(name);
      this.lastModified = Number(options.lastModified || Date.now());
      this.size = 0;
      this.type = options.type || "";
    }
    // Provide a reasonable toStringTag
    get [Symbol.toStringTag]() {
      return "File";
    }
  }

  try {
    globalThis.File = MinimalFile;
  } catch (err) {
    // If for some reason global assignment fails, log and continue — the
    // app may still behave unpredictably but we avoid crashing here.
    // eslint-disable-next-line no-console
    console.error(
      "polyfill-file: failed to set global File polyfill",
      err && err.message ? err.message : err,
    );
  }
}

// Asynchronously replace with the full implementation from `fetch-blob` if available.
(async () => {
  try {
    const mod = await import("fetch-blob");
    if (mod && mod.File) {
      globalThis.File = mod.File;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.debug(
      "polyfill-file: could not load fetch-blob (optional):",
      err && err.message ? err.message : err,
    );
  }
})();
