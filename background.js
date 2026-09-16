"use strict";

const DEBUGGER_VERSION = "1.3";
const OFFSCREEN_PATH = "offscreen.html";
let creatingOffscreen = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendDebuggerCommand = (target, method, params = {}) => new Promise((resolve, reject) => {
  chrome.debugger.sendCommand(target, method, params, (result) => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(new Error(error.message));
      return;
    }
    resolve(result || {});
  });
});

const attachDebugger = (target) => new Promise((resolve, reject) => {
  chrome.debugger.attach(target, DEBUGGER_VERSION, () => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(new Error(error.message));
      return;
    }
    resolve();
  });
});

const detachDebugger = (target) => new Promise((resolve) => {
  chrome.debugger.detach(target, () => {
    void chrome.runtime.lastError;
    resolve();
  });
});

async function withDebugger(tabId, worker) {
  const target = { tabId };
  let attached = false;
  try {
    await attachDebugger(target);
    attached = true;
    await sendDebuggerCommand(target, "DOM.enable");
    await sendDebuggerCommand(target, "Runtime.enable");
    return await worker(target);
  } finally {
    if (attached) await detachDebugger(target);
  }
}

async function getDocumentNodeId(target) {
  const result = await sendDebuggerCommand(target, "DOM.getDocument", { depth: 2, pierce: true });
  const nodeId = result?.root?.nodeId;
  if (!nodeId) throw new Error("Не удалось получить DOM страницы.");
  return nodeId;
}

async function queryNode(target, rootNodeId, selector, errorText) {
  const result = await sendDebuggerCommand(target, "DOM.querySelector", {
    nodeId: rootNodeId,
    selector
  });
  if (!result?.nodeId) throw new Error(errorText || `Элемент не найден: ${selector}`);
  return result.nodeId;
}

async function focusNode(target, nodeId) {
  try {
    await sendDebuggerCommand(target, "DOM.scrollIntoViewIfNeeded", { nodeId });
  } catch (_) { }
  await sendDebuggerCommand(target, "DOM.focus", { nodeId });
}

async function selectAllAndClear(target) {
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
}

async function typeTextTrusted(target, text) {
  // Input.insertText генерирует браузерный ввод в сфокусированный control.
  // В отличие от dispatchEvent из content-script он проходит через реальный editing pipeline Chromium.
  await sendDebuggerCommand(target, "Input.insertText", { text: String(text) });
}

async function pressTab(target) {
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9
  });
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9
  });
}

async function replaceTextTrusted(target, rootNodeId, selector, text, options = {}) {
  const nodeId = await queryNode(target, rootNodeId, selector, options.errorText);
  await focusNode(target, nodeId);
  await selectAllAndClear(target);
  await typeTextTrusted(target, text);
  if (options.commit !== false) await pressTab(target);
  return nodeId;
}

async function evaluateValue(target, expression) {
  const result = await sendDebuggerCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false
  });
  if (result?.exceptionDetails) throw new Error("Ошибка выполнения кода в контексте страницы.");
  return result?.result?.value;
}

async function setControlledValueInPage(target, selector, value, errorText) {
  const selectorJson = JSON.stringify(String(selector));
  const valueJson = JSON.stringify(String(value));
  const result = await evaluateValue(target, `(() => {
    const selector = ${selectorJson};
    const value = ${valueJson};
    const element = document.querySelector(selector);
    if (!element) return { ok: false, reason: "not-found" };

    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    const previous = element.value;

    element.focus();
    if (setter) setter.call(element, value);
    else element.value = value;

    if (element._valueTracker && typeof element._valueTracker.setValue === "function") {
      element._valueTracker.setValue(previous);
    }

    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    element.blur();

    return { ok: true, value: element.value };
  })()`);

  if (!result?.ok) throw new Error(errorText || `Элемент не найден: ${selector}`);
  return String(result.value ?? "");
}

async function clickPoint(target, x, y) {
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none"
  });
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
}

async function ensureCheckboxTrusted(target, name) {
  const state = await evaluateValue(target, `(() => {
    const checkbox = document.querySelector('input[name="${name}"][type="checkbox"]');
    if (!checkbox) return { exists: false };
    if (checkbox.checked) return { exists: true, checked: true };
    let clickable = checkbox;
    if (checkbox.id) {
      const label = document.querySelector('label[for="' + CSS.escape(checkbox.id) + '"]');
      if (label) clickable = label;
    }
    const rect = clickable.getBoundingClientRect();
    return {
      exists: true,
      checked: false,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      visible: rect.width > 0 && rect.height > 0
    };
  })()`);

  if (!state?.exists) throw new Error(`Флажок ${name} не найден.`);
  if (state.checked) return;
  if (!state.visible) throw new Error(`Флажок ${name} скрыт.`);

  await clickPoint(target, state.x, state.y);
  await sleep(120);
  const checked = await evaluateValue(target, `Boolean(document.querySelector('input[name="${name}"][type="checkbox"]')?.checked)`);
  if (!checked) throw new Error(`Не удалось установить флажок ${name}.`);
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["CLIPBOARD"],
    justification: "Прочитать данные из буфера обмена и локальный PDF для заполнения ЭДО-документа."
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function readClipboard() {
  await ensureOffscreenDocument();

  return await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "act:offscreenReadClipboard"
    }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Не удалось прочитать буфер обмена."));
        return;
      }
      resolve(String(response.text ?? ""));
    });
  });
}


async function readLocalFileCandidates(paths) {
  const candidates = Array.from(new Set((paths || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())));
  if (!candidates.length) throw new Error("Не сформирован путь к PDF-файлу.");

  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  if (!allowed) {
    throw new Error("Расширению запрещён доступ к локальным файлам. В настройках расширения включите «Разрешить доступ к URL файлов».");
  }

  await ensureOffscreenDocument();
  let lastError = null;

  for (const path of candidates) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "act:offscreenReadLocalFile",
          path
        }, (result) => {
          const error = chrome.runtime.lastError;
          if (error) { reject(new Error(error.message)); return; }
          if (!result?.ok) { reject(new Error(result?.error || "Не удалось прочитать локальный файл.")); return; }
          resolve(result.file);
        });
      });
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("PDF-файл не удалось прочитать с диска.");
}

async function selectAllByRange(target, selector) {
  const selectorJson = JSON.stringify(String(selector));
  const result = await evaluateValue(target, `(() => {
    const element = document.querySelector(${selectorJson});
    if (!element) return false;
    element.focus();
    if (typeof element.setSelectionRange === "function") {
      element.setSelectionRange(0, String(element.value || "").length);
    }
    return true;
  })()`);
  if (!result) throw new Error(`Элемент не найден: ${selector}`);
}

async function pressBackspace(target) {
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
}

async function typeTextByCharacters(target, text, delay = 25) {
  for (const char of String(text)) {
    await sendDebuggerCommand(target, "Input.insertText", { text: char });
    if (delay > 0) await sleep(delay);
  }
}

async function readInputValue(target, selector) {
  const selectorJson = JSON.stringify(String(selector));
  return String(await evaluateValue(target, `String(document.querySelector(${selectorJson})?.value || "")`) || "");
}

function dateDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

async function setDateTrusted(target, selector, dateText) {
  const expectedDigits = dateDigits(dateText);
  const compactDigits = expectedDigits;
  const attempts = [
    { text: compactDigits, charByChar: true },
    { text: dateText, charByChar: false },
    { text: dateText, charByChar: true }
  ];

  let lastValue = "";
  for (const attempt of attempts) {
    await selectAllByRange(target, selector);
    await pressBackspace(target);
    await sleep(80);

    if (attempt.charByChar) await typeTextByCharacters(target, attempt.text, 28);
    else await typeTextTrusted(target, attempt.text);

    await sleep(120);
    await pressTab(target);
    await sleep(180);

    lastValue = await readInputValue(target, selector);
    if (dateDigits(lastValue) === expectedDigits) {
      return { ok: true, value: lastValue };
    }
  }

  return { ok: false, value: lastValue };
}

async function ensureDocumentExchangeMode(target, timeout = 15000) {
  // При автозапуске из новой вкладки React может уже показать поля формы,
  // но переключатель режима дорисовать чуть позже. Поэтому здесь тоже ждём
  // кнопку независимо от проверки готовности в content-script.
  const started = Date.now();
  let info = null;

  while (Date.now() - started < timeout) {
    info = await evaluateValue(target, `(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find((item) => String(item.textContent || "").replace(/\s+/g, " ").trim() === "Отправить через Документооборот");
      if (!button) return { exists: false };
      const rect = button.getBoundingClientRect();
      return {
        exists: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        visible: rect.width > 0 && rect.height > 0
      };
    })()`);

    if (info?.exists && info.visible) break;
    await sleep(100);
  }

  if (!info?.exists) throw new Error("Кнопка «Отправить через Документооборот» не появилась после загрузки формы.");
  if (!info.visible) throw new Error("Кнопка «Отправить через Документооборот» осталась скрыта после загрузки формы.");

  await clickPoint(target, info.x, info.y);
  await sleep(250);
}


async function clickChooseFileButtonTrusted(target) {
  const info = await evaluateValue(target, `(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((item) => normalize(item.textContent) === "выберите файл");
    if (!button) return { exists: false };

    try { button.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) {}
    const rect = button.getBoundingClientRect();
    return {
      exists: true,
      visible: rect.width > 0 && rect.height > 0,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  })()`);

  if (!info?.exists) throw new Error("Кнопка «выберите файл» не найдена.");
  if (!info.visible) throw new Error("Кнопка «выберите файл» скрыта.");

  await sleep(120);
  await clickPoint(target, info.x, info.y);
  await sleep(120);
}



function digitKeyInfo(char) {
  const code = `Digit${char}`;
  const vk = String(char).charCodeAt(0);
  return { key: String(char), code, vk };
}

async function typeDigitsAsRealKeys(target, digits, delay = 55) {
  for (const char of String(digits)) {
    if (!/\d/.test(char)) continue;
    const info = digitKeyInfo(char);
    await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      text: info.key,
      unmodifiedText: info.key
    });
    await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk
    });
    if (delay > 0) await sleep(delay);
  }
}

async function waitForPartnerSuggestion(target, inn, timeout = 12000) {
  const innJson = JSON.stringify(String(inn));
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await evaluateValue(target, `(() => {
      const inn = ${innJson};
      const normalizeDigits = (value) => String(value || "").replace(/\\D/g, "");
      const items = Array.from(document.querySelectorAll("li.suggestion-item, .suggestion-item"));
      const exact = items
        .filter((item) => {
          const rect = item.getBoundingClientRect();
          if (!(rect.width > 0 && rect.height > 0)) return false;
          const text = String(item.textContent || "");
          return normalizeDigits(text).includes(inn);
        })
        .map((item) => {
          const rect = item.getBoundingClientRect();
          return {
            text: String(item.textContent || "").replace(/\\s+/g, " ").trim(),
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          };
        });
      return { count: exact.length, first: exact[0] || null };
    })()`);

    if (result?.first) return result;
    await sleep(100);
  }
  return { count: 0, first: null };
}

async function selectPartnerByInnTrusted(target, inn) {
  const normalizedInn = String(inn || "").replace(/\D/g, "");
  if (!/^\d{10}$|^\d{12}$/.test(normalizedInn)) {
    throw new Error(`Некорректный ИНН: ${inn}.`);
  }

  const selector = 'input[name="partner"].autocomplete-input:not([form="filters"])';
  const selectorJson = JSON.stringify(selector);

  const nodeInfo = await evaluateValue(target, `(() => {
    const input = document.querySelector(${selectorJson});
    if (!input) return { exists: false };
    const rect = input.getBoundingClientRect();
    return {
      exists: true,
      visible: rect.width > 0 && rect.height > 0,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      value: String(input.value || "")
    };
  })()`);

  if (!nodeInfo?.exists) throw new Error("Поле «Получатель» не найдено.");
  if (!nodeInfo.visible) throw new Error("Поле «Получатель» скрыто.");

  // Реальный клик, затем очистка и реальные keyDown/keyUp для каждой цифры.
  // Это принципиально отличается от прежнего Input.insertText: autocomplete
  // Сбера реагирует на клавиатурную цепочку и после debounce вызывает getPartners().
  await clickPoint(target, nodeInfo.x, nodeInfo.y);
  await sleep(120);
  await selectAllByRange(target, selector);
  await pressBackspace(target);
  await sleep(120);
  await typeDigitsAsRealKeys(target, normalizedInn, 55);

  // В логе POST /partner/ucourier/list появляется после debounce ~0.7 с.
  const suggestions = await waitForPartnerSuggestion(target, normalizedInn, 12000);
  if (!suggestions.first) {
    const current = await readInputValue(target, selector);
    throw new Error(`Штатный поиск не показал список для ИНН ${normalizedInn}. Значение поля: «${current}».`);
  }

  // Если один ИНН соответствует нескольким записям, выбираем первую — ровно так
  // был выбран ООО "ИЛЦ" в записанной сессии.
  await clickPoint(target, suggestions.first.x, suggestions.first.y);

  const started = Date.now();
  let value = "";
  while (Date.now() - started < 8000) {
    value = await readInputValue(target, selector);
    if (value && String(value).replace(/\D/g, "") !== normalizedInn && value !== normalizedInn) break;
    await sleep(100);
  }

  if (!value || value === normalizedInn) {
    throw new Error(`Строка контрагента была нажата, но форма не зафиксировала получателя для ИНН ${normalizedInn}.`);
  }

  // Даём форме закончить штатные запросы partner/{id}, attributes и ediCode.
  await sleep(700);
  return {
    name: value,
    matches: Number(suggestions.count || 1),
    suggestionText: String(suggestions.first.text || "")
  };
}

async function fillFormTrusted(tabId, data) {
  return await withDebugger(tabId, async (target) => {
    const documentCode = String(data.documentCode || "ACT").toUpperCase();
    if (documentCode !== "ACT" && documentCode !== "AGREEMENT" && documentCode !== "ACCOUNT") {
      throw new Error(`Неподдерживаемый код документа: ${documentCode}.`);
    }

    let rootNodeId = await getDocumentNodeId(target);
    const warnings = [];
    let partner = null;

    // У АКТА и ДОГОВОРА есть переключатель режима отправки.
    // В форме СЧЁТА (ACCOUNT, «Счет (неструктурированный)») этого переключателя нет,
    // поэтому для ACCOUNT этот шаг нужно пропустить.
    if (documentCode !== "ACCOUNT") {
      await ensureDocumentExchangeMode(target);
    }

    try {
      partner = await selectPartnerByInnTrusted(target, data.inn);
    } catch (error) {
      warnings.push(`Получатель по ИНН ${data.inn} не выбран автоматически: ${error?.message || String(error)}`);
    }

    // Выбор контрагента перерисовывает часть формы.
    rootNodeId = await getDocumentNodeId(target);

    await replaceTextTrusted(target, rootNodeId, 'input[name="number"].input-element', data.number, {
      errorText: "Поле «Номер документа» не найдено."
    });

    // Сумма есть у АКТА и СЧЁТА. У ДОГОВОРА этого поля нет и мы его не трогаем.
    if (documentCode === "ACT" || documentCode === "ACCOUNT") {
      await replaceTextTrusted(target, rootNodeId, 'input[name="sum"].numeric-text-box-input', data.amount, {
        errorText: "Поле «Сумма» не найдено."
      });
    }

    await ensureCheckboxTrusted(target, "senderSignatureRequired");
    // В записи заполнения СЧЁТА включался только флажок «Отправителем».
    // Для АКТА и ДОГОВОРА сохраняем прежнюю рабочую механику с двумя подписями.
    if (documentCode !== "ACCOUNT") {
      await ensureCheckboxTrusted(target, "receiverSignatureRequired");
    }

    const dateResult = await setDateTrusted(
      target,
      'input.datepicker-input:not([form="filters"])',
      data.date
    );
    if (!dateResult.ok) {
      warnings.push(`Дата ${data.date} не принята маской. В поле осталось: ${dateResult.value || "пусто"}.`);
    }

    const verification = await evaluateValue(target, `(() => ({
      number: String(document.querySelector('input[name="number"].input-element')?.value || ""),
      amount: String(document.querySelector('input[name="sum"].numeric-text-box-input')?.value || ""),
      sender: Boolean(document.querySelector('input[name="senderSignatureRequired"][type="checkbox"]')?.checked),
      receiver: Boolean(document.querySelector('input[name="receiverSignatureRequired"][type="checkbox"]')?.checked),
      date: String(document.querySelector('input.datepicker-input:not([form="filters"])')?.value || "")
    }))()`);

    if (!String(verification?.number || "").includes(data.number)) {
      throw new Error("Штатная форма не сохранила номер документа.");
    }

    if (documentCode === "ACT" || documentCode === "ACCOUNT") {
      const expectedAmount = String(data.amount).replace(/\s/g, "").replace(",", ".");
      const actualAmount = String(verification?.amount || "").replace(/\s/g, "").replace(",", ".");
      if (!actualAmount.startsWith(expectedAmount)) {
        throw new Error(`Штатная форма не сохранила сумму ${data.amount}.`);
      }
    }

    if (!verification?.sender || (documentCode !== "ACCOUNT" && !verification?.receiver)) {
      throw new Error("Штатная форма не сохранила флажки подписания.");
    }

    if (dateDigits(verification?.date) !== dateDigits(data.date) && !warnings.length) {
      warnings.push(`Дата ${data.date} не сохранилась. В поле: ${verification?.date || "пусто"}.`);
    }

    return {
      ok: true,
      warnings,
      dateValue: String(verification?.date || ""),
      fileDialogOpened: false,
      partnerSelected: Boolean(partner),
      partnerName: partner?.name || "",
      partnerMatches: partner?.matches || 0
    };
  });
}

function waitForFileChooserOpened(tabId, timeout = 7000) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(onEvent);
    };

    const onEvent = (source, method, params) => {
      if (source?.tabId !== tabId || method !== "Page.fileChooserOpened") return;
      cleanup();
      resolve(params || {});
    };

    chrome.debugger.onEvent.addListener(onEvent);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Chromium не сообщил об открытии штатного окна выбора файла."));
    }, timeout);
  });
}

async function setFileInput(tabId, paths) {
  const candidates = Array.from(new Set((paths || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())));
  if (!candidates.length) throw new Error("Не сформирован путь к PDF-файлу.");

  return await withDebugger(tabId, async (target) => {
    await sendDebuggerCommand(target, "Page.enable");
    await sendDebuggerCommand(target, "Page.setInterceptFileChooserDialog", { enabled: true });

    try {
      const chooserPromise = waitForFileChooserOpened(tabId, 7000);

      // Нажимаем именно штатную кнопку сайта. При включенном interception
      // системный диалог не показывается, а Chromium присылает Page.fileChooserOpened.
      await clickChooseFileButtonTrusted(target);
      const chooser = await chooserPromise;
      const backendNodeId = chooser?.backendNodeId;
      if (!backendNodeId) {
        throw new Error("Chromium открыл file chooser, но не вернул backendNodeId поля файла.");
      }

      let lastError = null;
      for (const path of candidates) {
        try {
          await sendDebuggerCommand(target, "DOM.setFileInputFiles", {
            backendNodeId,
            files: [path]
          });
          return { ok: true, path };
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error("PDF-файл не удалось выбрать.");
    } finally {
      try {
        await sendDebuggerCommand(target, "Page.setInterceptFileChooserDialog", { enabled: false });
      } catch (_) { }
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "act:readClipboard") {
    readClipboard()
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "act:fillFormTrusted") {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Не определена активная вкладка." });
      return false;
    }
    fillFormTrusted(tabId, {
      documentCode: String(message.documentCode || "ACT"),
      inn: String(message.inn || ""),
      number: String(message.number || ""),
      date: String(message.date || ""),
      amount: String(message.amount || "")
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "act:readLocalFile") {
    readLocalFileCandidates(message.paths)
      .then((file) => sendResponse({ ok: true, file }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener((tab) => {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) return;

  chrome.tabs.sendMessage(tabId, { type: "act:run" }, () => {
    void chrome.runtime.lastError;
  });
});
