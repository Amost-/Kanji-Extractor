// Service worker / non-persistent background page.
// The popup performs extraction and output directly, so this script only keeps
// a minimal install hook for future setup tasks.

const api = (typeof browser !== "undefined") ? browser : chrome;

api.runtime.onInstalled.addListener(() => {
  // No-op on install. Hook left intentionally so future versions can run
  // setup tasks here (default settings, migration, etc.).
});
