// popup.js — controls the popup UI and orchestrates extraction

// ─── Constants ───────────────────────────────────────────────────────────────

const FREE_LIMIT = 20;
const LICENCE_VERIFY_URL = "https://coursescribe-production.up.railway.app/verify";

// ─── State ───────────────────────────────────────────────────────────────────

let isRunning = false;
let shouldStop = false;
let collectedFiles = [];

// ─── DOM References ──────────────────────────────────────────────────────────

const licenceBar = document.getElementById("licenceBar");
const licenceStatus = document.getElementById("licenceStatus");
const videoCountEl = document.getElementById("videoCount");
const unlockBtn = document.getElementById("unlockBtn");
const licenceInputSection = document.getElementById("licenceInputSection");
const licenceKeyInput = document.getElementById("licenceKeyInput");
const verifyBtn = document.getElementById("verifyBtn");
const autoToggle = document.getElementById("autoToggle");
const modeHint = document.getElementById("modeHint");
const extractBtn = document.getElementById("extractBtn");
const nextBtn = document.getElementById("nextBtn");
const stopBtn = document.getElementById("stopBtn");
const logSection = document.getElementById("logSection");
const logBox = document.getElementById("logBox");
const downloadBtn = document.getElementById("downloadBtn");
const clearBtn = document.getElementById("clearBtn");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSelectedFormat() {
  return document.querySelector('input[name="format"]:checked').value;
}

function log(message, type = "normal") {
  logSection.style.display = "block";
  const entry = document.createElement("div");
  entry.textContent = message;
  if (type === "success") entry.className = "log-entry-success";
  if (type === "skip")    entry.className = "log-entry-skip";
  if (type === "error")   entry.className = "log-entry-error";
  logBox.appendChild(entry);
  logBox.scrollTop = logBox.scrollHeight;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "").trim().substring(0, 60);
}

function setButtonState(running) {
  isRunning = running;
  extractBtn.disabled = running;
  stopBtn.style.display = running ? "block" : "none";
  if (autoToggle.checked) {
    nextBtn.style.display = "none";
  } else {
    nextBtn.style.display = running ? "block" : "none";
  }
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

// ─── Collected files persistence ─────────────────────────────────────────────

async function saveCollectedFiles() {
  await setStorage({ collectedFiles: JSON.stringify(collectedFiles) });
}

async function loadCollectedFiles() {
  try {
    const data = await getStorage(["collectedFiles"]);
    if (data.collectedFiles) {
      collectedFiles = JSON.parse(data.collectedFiles);
      if (collectedFiles.length > 0) {
        logSection.style.display = "block";
        logBox.innerHTML = "";
        collectedFiles.forEach(f => {
          log(`✓ ${f.index}. ${sanitizeFilename(f.title)}`, "success");
        });
        log(`\n${collectedFiles.length} file(s) ready — click Download to save.`, "success");
        downloadBtn.style.display = "block";
        clearBtn.style.display = "block";
      }
    }
  } catch {
    collectedFiles = [];
  }
}

// ─── Licence logic ────────────────────────────────────────────────────────────

async function loadLicenceState() {
  const data = await getStorage(["videoCount", "licenceKey", "licenceValid"]);
  const count = data.videoCount || 0;
  const isValid = data.licenceValid || false;

  videoCountEl.textContent = count;

  if (isValid) {
    licenceStatus.innerHTML = "✅ Unlimited — licence active";
    unlockBtn.style.display = "none";
  } else {
    licenceStatus.innerHTML = `🔓 Free — <span id="videoCount">${count}</span> / ${FREE_LIMIT} videos used`;
    unlockBtn.style.display = "block";
  }

  return { count, isValid };
}

async function incrementVideoCount() {
  const data = await getStorage(["videoCount"]);
  const newCount = (data.videoCount || 0) + 1;
  await setStorage({ videoCount: newCount });
  videoCountEl.textContent = newCount;
  return newCount;
}

async function hasReachedFreeLimit() {
  const data = await getStorage(["videoCount", "licenceValid"]);
  if (data.licenceValid) return false;
  return (data.videoCount || 0) >= FREE_LIMIT;
}

// ─── Licence verification ─────────────────────────────────────────────────────

async function verifyLicenceKey(key) {
  try {
    const response = await fetch(LICENCE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key })
    });
    const data = await response.json();
    return data.valid === true;
  } catch (err) {
    console.error("Licence verification error:", err);
    return false;
  }
}

// ─── File generation ──────────────────────────────────────────────────────────

function generateContent(title, transcript) {
  return `${title}\n${"=".repeat(title.length)}\n\n${transcript}`;
}

function getExtension(format) {
  return format;
}

async function generatePdf(title, transcript) {
  const element = document.createElement("div");
  element.style.cssText = `
    font-family: Arial, sans-serif;
    font-size: 12px;
    line-height: 1.6;
    padding: 20px;
    color: #000;
  `;
  element.innerHTML = `
    <h1 style="font-size:18px; font-weight:bold; margin-bottom:16px;">${title}</h1>
    <hr style="margin-bottom:16px;">
    <div>${transcript.split("\n").map(line => 
      line.trim() ? `<p style="margin:4px 0;">${line}</p>` : `<br>`
    ).join("")}</div>
  `;

  const opt = {
    margin: 15,
    filename: `${sanitizeFilename(title)}.pdf`,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  };

  return await html2pdf().set(opt).from(element).outputPdf("blob");
}

// ─── ZIP download ─────────────────────────────────────────────────────────────

async function downloadAsZip(files) {
  if (files.length === 0) return;
  const zip = new JSZip();
  const folder = zip.folder("CourseScribe Transcripts");

  await Promise.all(files.map(async (f) => {
    const prefix = String(f.index).padStart(2, "0");
    const filename = `${prefix} - ${sanitizeFilename(f.title)}.${f.format}`;
    let blob;

    if (f.format === "docx") {
      blob = await generateDocx(f.title, f.content);
    } else if (f.format === "pdf") {
      blob = await generatePdf(f.title, f.content);
    } else {
      blob = new Blob([generateContent(f.title, f.content)], { type: "text/plain" });
    }

    folder.file(filename, blob);
  }));

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "CourseScribe_Transcripts.zip";
  a.click();
  URL.revokeObjectURL(url);
}

// Single file download (manual mode — immediate, no ZIP)
async function downloadSingleFile(title, transcript, format, index) {
  const prefix = String(index).padStart(2, "0");
  const safeName = sanitizeFilename(title);
  let blob;

  if (format === "docx") {
    blob = await generateDocx(title, transcript);
  } else if (format === "pdf") {
    blob = await generatePdf(title, transcript);
  } else {
    blob = new Blob([generateContent(title, transcript)], { type: "text/plain" });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix} - ${safeName}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Core extraction ──────────────────────────────────────────────────────────

async function sendMessageToTab(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        reject(new Error("No active tab found"));
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  });
}

async function extractCurrentVideo(index, silentMode = false) {
  const limitReached = await hasReachedFreeLimit();
  if (limitReached) {
    log("⚠ Free limit reached (20 videos). Please unlock for unlimited use.", "error");
    licenceInputSection.style.display = "block";
    return { success: false, reason: "limit_reached" };
  }

  try {
    const response = await sendMessageToTab({ action: "getTranscript" });

    if (!response) {
      log("✗ Could not connect to page. Make sure you are on a Coursera video page.", "error");
      return { success: false, reason: "no_connection" };
    }

    if (!response.success) {
      if (response.reason === "no_transcript") {
        log("↷ No transcript — skipping.", "skip");
        return { success: false, reason: "no_transcript", isEndOfCourse: response.isEndOfCourse };
      }
    }

    const format = getSelectedFormat();
    const fileIndex = collectedFiles.length + 1;

    collectedFiles.push({
      title: response.title,
      content: response.transcript,
      format,
      index: fileIndex
    });

    // Persist collected files so they survive popup close
    await saveCollectedFiles();

    await incrementVideoCount();
    log(`✓ ${fileIndex}. ${sanitizeFilename(response.title)}`, "success");

    // Only trigger immediate download in manual mode
    if (!silentMode) {
      await downloadSingleFile(response.title, response.transcript, format, fileIndex);
    }

    return { success: true, isEndOfCourse: response.isEndOfCourse };

  } catch (err) {
    log(`✗ Error: ${err.message}`, "error");
    return { success: false, reason: "error" };
  }
}

async function goToNextVideo() {
  try {
    const response = await sendMessageToTab({ action: "nextVideo" });
    if (!response || !response.success) return false;
    await new Promise(r => setTimeout(r, 3500));
    return true;
  } catch {
    return false;
  }
}

// ─── Auto mode loop ───────────────────────────────────────────────────────────

async function runAutoMode() {
  shouldStop = false;
  collectedFiles = [];
  await saveCollectedFiles();
  setButtonState(true);
  log("▶ Auto mode — collecting transcripts silently...");

  let pageIndex = 1;

  while (!shouldStop) {
    const result = await extractCurrentVideo(pageIndex, true);

    if (result.reason === "limit_reached") break;
    if (result.reason === "no_connection") break;

    if (result.isEndOfCourse) {
      log("🏁 Reached end of course.", "success");
      break;
    }

    const advanced = await goToNextVideo();
    if (!advanced) {
      log("✗ Could not find Next button — stopping.", "error");
      break;
    }

    pageIndex++;
  }

  if (shouldStop) log("⏹ Stopped by user.");
  setButtonState(false);

  if (collectedFiles.length > 0) {
    log(`\n✅ ${collectedFiles.length} transcript(s) collected. Click Download to save.`, "success");
    downloadBtn.style.display = "block";
    clearBtn.style.display = "block";
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

unlockBtn.addEventListener("click", () => {
  const isVisible = licenceInputSection.style.display !== "none";
  licenceInputSection.style.display = isVisible ? "none" : "block";
});

verifyBtn.addEventListener("click", async () => {
  const key = licenceKeyInput.value.trim();
  if (!key) { log("Please enter a licence key.", "error"); return; }

  verifyBtn.textContent = "Verifying...";
  verifyBtn.disabled = true;

  const valid = await verifyLicenceKey(key);

  if (valid) {
    await setStorage({ licenceKey: key, licenceValid: true });
    licenceInputSection.style.display = "none";
    licenceStatus.innerHTML = "✅ Unlimited — licence active";
    unlockBtn.style.display = "none";
    log("✅ Licence verified! Unlimited extractions unlocked.", "success");
  } else {
    log("✗ Invalid licence key. Please check and try again.", "error");
  }

  verifyBtn.textContent = "Verify";
  verifyBtn.disabled = false;
});

autoToggle.addEventListener("change", () => {
  if (autoToggle.checked) {
    modeHint.textContent = "Transcripts collected silently — one ZIP downloaded at the end.";
    nextBtn.style.display = "none";
    extractBtn.textContent = "Start Auto Extraction";
  } else {
    modeHint.textContent = 'Click "Next Video" yourself after each extraction.';
    extractBtn.textContent = "Extract This Video";
    nextBtn.style.display = isRunning ? "block" : "none";
  }
});

extractBtn.addEventListener("click", async () => {
  collectedFiles = [];
  await saveCollectedFiles();
  logBox.innerHTML = "";
  downloadBtn.style.display = "none";
  clearBtn.style.display = "none";

  if (autoToggle.checked) {
    await runAutoMode();
  } else {
    setButtonState(true);
    await extractCurrentVideo(1, false); // immediate download, no ZIP
    setButtonState(false);
  }
});

nextBtn.addEventListener("click", async () => {
  nextBtn.disabled = true;
  nextBtn.textContent = "Loading...";
  const advanced = await goToNextVideo();
  if (!advanced) log("✗ Could not find Next button.", "error");
  nextBtn.disabled = false;
  nextBtn.textContent = "Next Video →";
});

stopBtn.addEventListener("click", () => {
  shouldStop = true;
  log("⏹ Stopping after current video...", "skip");
});

downloadBtn.addEventListener("click", async () => {
  downloadBtn.textContent = "⏳ Preparing ZIP...";
  downloadBtn.disabled = true;
  await downloadAsZip(collectedFiles);
  downloadBtn.textContent = "⬇ Download All Files";
  downloadBtn.disabled = false;
});

clearBtn.addEventListener("click", async () => {
  collectedFiles = [];
  await setStorage({ collectedFiles: "[]" });
  logBox.innerHTML = "";
  downloadBtn.style.display = "none";
  clearBtn.style.display = "none";
  log("Cleared. Ready to start again.");
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadLicenceState();
loadCollectedFiles();
