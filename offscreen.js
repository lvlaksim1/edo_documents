"use strict";

async function readClipboardText() {
  let primaryError = null;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      const text = await navigator.clipboard.readText();
      if (typeof text === "string") return text;
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    const area = document.getElementById("clipboard-fallback");
    area.value = "";
    area.focus();
    area.select();
    const ok = document.execCommand("paste");
    if (ok && area.value) return area.value;
  } catch (_) { }

  throw primaryError || new Error("Не удалось прочитать текст из буфера обмена.");
}

function windowsPathToFileUrl(path) {
  const value = String(path || "").trim();
  const match = /^([A-Za-z]:)\\(.*)$/.exec(value);
  if (!match) throw new Error(`Некорректный Windows-путь: ${value}`);
  const drive = match[1];
  const parts = match[2].split("\\").filter((part) => part.length > 0).map((part) => encodeURIComponent(part));
  return `file:///${drive}/${parts.join("/")}`;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fetchLocalArrayBuffer(fileUrl) {
  try {
    const response = await fetch(fileUrl, { cache: "no-store" });
    return {
      buffer: await response.arrayBuffer(),
      type: response.headers.get("content-type") || ""
    };
  } catch (fetchError) {
    return await new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", fileUrl, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
          if (xhr.response instanceof ArrayBuffer) {
            resolve({ buffer: xhr.response, type: xhr.getResponseHeader("content-type") || "" });
          } else {
            reject(fetchError);
          }
        };
        xhr.onerror = () => reject(fetchError);
        xhr.send();
      } catch (_) {
        reject(fetchError);
      }
    });
  }
}

async function readLocalFile(path) {
  const fileUrl = windowsPathToFileUrl(path);
  const loaded = await fetchLocalArrayBuffer(fileUrl);
  const bytes = new Uint8Array(loaded.buffer);
  if (!bytes.length) throw new Error("Файл пуст или недоступен для чтения.");

  const name = String(path).split(/[\\/]/).pop() || "document.pdf";
  return {
    path,
    name,
    mime: loaded.type || "application/pdf",
    size: bytes.length,
    base64: bytesToBase64(bytes)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message?.type === "act:offscreenReadClipboard") {
    readClipboardText()
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "act:offscreenReadLocalFile") {
    readLocalFile(String(message.path || ""))
      .then((file) => sendResponse({ ok: true, file }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});
