// background.js — persistent service worker
// Handles licence verification requests from popup.js
// so they aren't cancelled if the popup closes mid-request

// ─── Constants ───────────────────────────────────────────────────────────────

const LICENCE_VERIFY_URL = "https://coursescribe-production.up.railway.app/verify"; // update after deploying server

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // VERIFY_LICENCE — called by popup.js to verify a licence key
  if (message.action === "verifyLicence") {
    (async () => {
      try {
        const response = await fetch(LICENCE_VERIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: message.key })
        });

        if (!response.ok) {
          sendResponse({ valid: false, reason: "server_error" });
          return;
        }

        const data = await response.json();
        sendResponse({ valid: data.valid === true });

      } catch (err) {
        console.error("Licence verification failed:", err);
        sendResponse({ valid: false, reason: "network_error" });
      }
    })();
    return true; // keep message channel open for async response
  }

  // OPEN_GUMROAD — opens the Gumroad purchase page in a new tab
  if (message.action === "openGumroad") {
    chrome.tabs.create({ url: "https://alexhzwoon.gumroad.com/l/coursescribe" }); // update with your real Gumroad link
    sendResponse({ success: true });
    return true;
  }

});

