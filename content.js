// content.js — runs on every Coursera lesson page
// Listens for messages from popup.js and responds with transcript / reading data
//
// Note on the 2024+ Coursera redesign:
// The Transcript / Notes / Files controls now live in a right-hand side panel.
// The active tab is indicated with aria-pressed (it used to be aria-selected),
// and re-clicking the active tab toggles the panel closed — so we must only
// click the Transcript tab when it is NOT already active.

// ─── Helpers ────────────────────────────────────────────────────────────────

function isReadingPage() {
  // Reading / summary pages live under /supplement/
  return window.location.href.includes("/supplement/");
}

function cleanText(str) {
  // Strip zero-width spaces injected into the transcript markup, normalise nbsp
  return str.replace(/​/g, "").replace(/ /g, " ").trim();
}

function getVideoTitle() {
  const heading = document.querySelector(".video-name")
    || document.querySelector("#main-container h1")
    || document.querySelector("h1");
  if (heading) return heading.innerText.trim();
  return document.title.split("|")[0].trim() || "Untitled";
}

function getReadingTitle() {
  // The reading title is the first heading inside the main content area
  const heading = document.querySelector("#main-container h1")
    || document.querySelector('[role="main"] h1')
    || document.querySelector("h1");
  if (heading) return heading.innerText.trim();
  return document.title.split("|")[0].trim() || "Untitled";
}

function getTranscript() {
  const phrases = document.querySelectorAll(".rc-Phrase");
  if (!phrases || phrases.length === 0) return null;
  const text = Array.from(phrases)
    .map(p => cleanText(p.innerText))
    .filter(Boolean)
    .join("\n");
  return text || null;
}

function getReadingContent() {
  // Coursera renders reading bodies as CML (Coursera Markup Language)
  const selectors = [
    '[data-testid="cml-viewer"]',
    ".rc-CML",
    ".rc-DesktopSupplement .rc-CML",
    ".item-page-content .rc-CML",
  ];
  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length) {
      const text = Array.from(nodes)
        .map(n => cleanText(n.innerText))
        .filter(Boolean)
        .join("\n\n");
      if (text) return text;
    }
  }
  return null;
}

// ─── Transcript tab (right-hand side panel) ──────────────────────────────────

function getTranscriptTab() {
  return document.querySelector('[data-testid="item-tool-panel-button-transcript"]')
    || document.querySelector('button[aria-label="Transcript"]')
    || Array.from(document.querySelectorAll("button")).find(
        el => el.innerText.trim().toLowerCase() === "transcript"
      );
}

function isTranscriptTabActive() {
  // The transcript phrases being present in the DOM is the real signal that the
  // panel is open and showing the transcript.
  if (document.querySelector(".rc-Phrase")) return true;

  const tab = getTranscriptTab();
  if (!tab) return false;
  // New UI uses aria-pressed; keep aria-selected/class checks for safety.
  return tab.getAttribute("aria-pressed") === "true"
    || tab.getAttribute("aria-selected") === "true"
    || tab.classList.contains("active")
    || tab.classList.contains("selected");
}

function openTranscriptTab() {
  // Only click when the transcript isn't already showing — clicking an already
  // active tab in the new UI collapses the panel.
  if (isTranscriptTabActive()) return true;
  const tab = getTranscriptTab();
  if (tab) {
    tab.click();
    return true;
  }
  return false;
}

function isEndOfCourse() {
  // "Go to My Learning" appears on the last page of a course
  const allButtons = Array.from(document.querySelectorAll("a, button"));
  return allButtons.some(el =>
    el.innerText.trim().toLowerCase().includes("go to my learning")
  );
}

function clickNextVideo() {
  const selectors = [
    '[data-track-component="next_item"]',
    'button[aria-label="Go to next item"]',
    'a[aria-label="Go to next item"]',
  ];

  for (const selector of selectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.click();
      return true;
    }
  }

  // Fallback: find by text content
  const allButtons = Array.from(document.querySelectorAll("a, button"));
  const nextBtn = allButtons.find(el =>
    el.innerText.trim().toLowerCase().includes("go to next item")
  );
  if (nextBtn) {
    nextBtn.click();
    return true;
  }

  return false;
}

function waitForTranscript(timeout = 8000) {
  // Returns a promise that resolves when transcript phrases appear
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const phrases = document.querySelectorAll(".rc-Phrase");
      if (phrases.length > 0) {
        clearInterval(interval);
        resolve(true);
      }
      if (Date.now() - start > timeout) {
        clearInterval(interval);
        resolve(false); // timed out — no transcript on this page
      }
    }, 300);
  });
}

// ─── Message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // PING — check if content script is loaded on this page
  if (message.action === "ping") {
    sendResponse({ success: true });
    return true;
  }

  // GET_TRANSCRIPT — extract transcript (video) or content (reading) from page
  if (message.action === "getTranscript") {
    (async () => {

      // ── Reading / summary pages ──────────────────────────────────────────
      if (isReadingPage()) {
        const content = getReadingContent();
        if (!content) {
          sendResponse({
            success: false,
            reason: "no_transcript",
            isEndOfCourse: isEndOfCourse()
          });
          return;
        }
        sendResponse({
          success: true,
          title: getReadingTitle(),
          transcript: content,
          isEndOfCourse: isEndOfCourse()
        });
        return;
      }

      // ── Video pages ──────────────────────────────────────────────────────
      // Open the Transcript tab in the right-hand panel if it isn't already.
      if (!isTranscriptTabActive()) {
        openTranscriptTab();
        await new Promise(r => setTimeout(r, 1000));
      }

      const found = await waitForTranscript(8000);

      if (!found) {
        sendResponse({
          success: false,
          reason: "no_transcript",
          isEndOfCourse: isEndOfCourse()
        });
        return;
      }

      const transcript = getTranscript();
      const title = getVideoTitle();

      if (!transcript) {
        sendResponse({
          success: false,
          reason: "no_transcript",
          isEndOfCourse: isEndOfCourse()
        });
        return;
      }

      sendResponse({
        success: true,
        title: title,
        transcript: transcript,
        isEndOfCourse: isEndOfCourse()
      });
    })();
    return true; // keep message channel open for async response
  }

  // NEXT_VIDEO — click the next button
  if (message.action === "nextVideo") {
    if (isEndOfCourse()) {
      sendResponse({ success: false, reason: "end_of_course" });
      return true;
    }
    const clicked = clickNextVideo();
    sendResponse({ success: clicked });
    return true;
  }

  // CHECK_PAGE — check if we're on a lesson page
  if (message.action === "checkPage") {
    const onCoursera = window.location.hostname === "www.coursera.org";
    const onVideoPage = window.location.href.includes("/lecture/")
      || window.location.href.includes("/supplement/")
      || window.location.href.includes("/learn/");
    sendResponse({
      onCoursera,
      onVideoPage,
      isEndOfCourse: isEndOfCourse()
    });
    return true;
  }

});
