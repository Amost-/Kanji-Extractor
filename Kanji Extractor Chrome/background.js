// Service worker. We don't need it for extraction (the popup handles that
// directly via chrome.scripting.executeScript), but MV3 requires a background
// entry to be declared if you want the slot, and it gives us a place to add
// install/update hooks later.

chrome.runtime.onInstalled.addListener(() => {
  // No-op for now. Reserved for future setup tasks (defaults, migration).
});
