// content.js — runs on every Coursera page
// Listens for messages from popup.js and responds with transcript data

// ─── Helpers ────────────────────────────────────────────────────────────────

function getVideoTitle() {
  // Try the main heading first, fall back to page title
  const heading = document.querySelector("h1[class*='rc-RenderPlayerSlideSection']")
    || document.querySelector(".video-name")
    || document.querySelector("h1");
  if (heading) return heading.innerText.trim();
  return document.title.split("|")[0].trim() || "Untitled";
}

function getTranscript() {
  const phrases = document.querySelectorAll(".rc-Phrase");
  if (!phrases || phrases.length === 0) return null;
  return Array.from(phrases)
    .map(p => p.innerText.trim())
    .filter(Boolean)
    .join("\n");
}

function isTranscriptTabActive() {
  // Check if the Transcript tab is the currently selected tab
  const transcriptTab = document.querySelector('[aria-label="Transcript"]')
    || Array.from(document.querySelectorAll("button, a")).find(
        el => el.innerText.trim().toLowerCase() === "transcript"
      );
  if (!transcriptTab) return false;
  return transcriptTab.getAttribute("aria-selected") === "true"
    || transcriptTab.classList.contains("active")
    || transcriptTab.classList.contains("selected");
}

function clickTranscriptTab() {
  const transcriptTab = document.querySelector('[aria-label="Transcript"]')
    || Array.from(document.querySelectorAll("button, a")).find(
        el => el.innerText.trim().toLowerCase() === "transcript"
      );
  if (transcriptTab) {
    transcriptTab.click();
    return true;
  }
  return false;
}

function isEndOfCourse() {
  // Check for "Go to My Learning" button which appears on the last page
  const allButtons = Array.from(document.querySelectorAll("a, button"));
  return allButtons.some(el =>
    el.innerText.trim().toLowerCase().includes("go to my learning")
  );
}

function clickNextVideo() {
  // Try multiple selectors for the Next button
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

  // GET_TRANSCRIPT — extract transcript from current page
  if (message.action === "getTranscript") {
    (async () => {
      // Try to click the transcript tab if it's not already active
      if (!isTranscriptTabActive()) {
        clickTranscriptTab();
        await new Promise(r => setTimeout(r, 1000));
      }

      // Wait for transcript to appear
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

  // CHECK_PAGE — check if we're on a video page
  if (message.action === "checkPage") {
    const onCoursera = window.location.hostname === "www.coursera.org";
    const onVideoPage = window.location.href.includes("/lecture/")
      || window.location.href.includes("/learn/");
    sendResponse({
      onCoursera,
      onVideoPage,
      isEndOfCourse: isEndOfCourse()
    });
    return true;
  }

});
