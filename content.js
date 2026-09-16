(() => {
  "use strict";

  const CONTROLS_ID = "einv-edo-controls";
  const POSITION_STORAGE_KEY = "einvActButtonPosition";
  const PAGE_MARGIN = 8;
  const DRAG_THRESHOLD = 4;
  const TARGET_HASHES = {
    ACT: "#/document/create/ACT",
    AGREEMENT: "#/document/create/AGREEMENT",
    ACCOUNT: "#/document/create/ACCOUNT"
  };
  const AUTO_LINK_MARKER = "#__edo__?";
  const DEFAULT_TEXT = "ЭДО";

  if (document.getElementById(CONTROLS_ID)) return;

  const controls = document.createElement("div");
  controls.id = CONTROLS_ID;
  Object.assign(controls.style, {
    position: "fixed",
    left: "24px",
    top: "24px",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "stretch",
    fontFamily: "Arial, sans-serif",
    userSelect: "none",
    touchAction: "none"
  });

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = DEFAULT_TEXT;
  button.title = "Заполнить ЭДО-документ. При нажатии кнопки данные читаются из буфера; при запуске специальной ссылкой — из самой ссылки. Поддерживаются АКТ, ДОГОВОР и СЧЁТ. Получатель выбирается автоматически по ИНН, PDF загружается по полному пути. После завершения фокус устанавливается в поле «Комментарий». Кнопку можно перетаскивать.";
  Object.assign(button.style, {
    minWidth: "78px",
    padding: "10px 16px",
    border: "1px solid rgba(0, 0, 0, 0.22)",
    borderRadius: "10px",
    background: "#ffffff",
    color: "#111111",
    fontFamily: "Arial, sans-serif",
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "1.2",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.22)",
    cursor: "grab",
    transition: "background-color 120ms ease, color 120ms ease, border-color 120ms ease"
  });

  controls.appendChild(button);
  document.documentElement.appendChild(controls);

  let drag = null;
  let suppressNextClick = false;
  let running = false;
  let resetTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  const sendMessage = (message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });

  const applyPosition = (left, top) => {
    const maxLeft = window.innerWidth - controls.offsetWidth - PAGE_MARGIN;
    const maxTop = window.innerHeight - controls.offsetHeight - PAGE_MARGIN;
    controls.style.left = `${clamp(left, PAGE_MARGIN, maxLeft)}px`;
    controls.style.top = `${clamp(top, PAGE_MARGIN, maxTop)}px`;
  };

  const savePosition = () => {
    const rect = controls.getBoundingClientRect();
    chrome.storage.local.set({
      [POSITION_STORAGE_KEY]: {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }
    });
  };

  chrome.storage.local.get(POSITION_STORAGE_KEY, (result) => {
    const saved = result?.[POSITION_STORAGE_KEY];
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      applyPosition(saved.left, saved.top);
    }
  });

  const setButtonState = (state, detail = "") => {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }

    button.disabled = state === "working";
    button.style.cursor = state === "working" ? "wait" : "grab";

    if (state === "working") {
      button.textContent = "Заполняю…";
      button.style.background = "#e8eaed";
      button.style.color = "#5f6368";
      button.style.borderColor = "#c4c7c5";
      button.title = detail || "Заполняется штатная форма Сбер Документооборота.";
      return;
    }


    if (state === "warn") {
      button.textContent = "Ошибка";
      button.style.background = "#d93025";
      button.style.color = "#ffffff";
      button.style.borderColor = "#b3261e";
      button.title = detail || "Документ заполнен не полностью.";
      resetTimer = setTimeout(() => setButtonState("idle"), 5000);
      return;
    }

    if (state === "error") {
      button.textContent = "Ошибка";
      button.style.background = "#d93025";
      button.style.color = "#ffffff";
      button.style.borderColor = "#b3261e";
      button.title = detail || "Не удалось заполнить форму.";
      resetTimer = setTimeout(() => setButtonState("idle"), 5000);
      return;
    }

    button.textContent = DEFAULT_TEXT;
    button.style.background = "#ffffff";
    button.style.color = "#111111";
    button.style.borderColor = "rgba(0, 0, 0, 0.22)";
    button.title = "Заполнить ЭДО-документ. При нажатии кнопки данные читаются из буфера; при запуске специальной ссылкой — из самой ссылки. Поддерживаются АКТ, ДОГОВОР и СЧЁТ. Получатель выбирается автоматически по ИНН, PDF загружается по полному пути. После завершения фокус устанавливается в поле «Комментарий». Кнопку можно перетаскивать.";
    button.disabled = false;
  };

  const isDateText = (value) => /^\d{2}\.\d{2}\.\d{4}$/.test(String(value || ""));

  const parseClipboard = (text) => {
    const lines = String(text ?? "")
      .replace(/\uFEFF/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (!lines.length) throw new Error("Буфер обмена пуст.");

    const type = lines[0].toUpperCase();

    if (type === "СЧЁТ" || type === "СЧЕТ") {
      if (lines.length !== 6) {
        throw new Error(`Для СЧЁТА в буфере должно быть ровно 6 непустых строк: тип, ИНН, номер, дата, сумма, полный путь к PDF. Сейчас: ${lines.length}.`);
      }
      return {
        raw: String(text ?? ""),
        lines,
        type: "СЧЁТ",
        code: "ACCOUNT",
        targetHash: TARGET_HASHES.ACCOUNT,
        inn: lines[1],
        number: lines[2],
        date: lines[3],
        amount: lines[4],
        filePath: lines[5]
      };
    }

    if (type === "АКТ") {
      if (lines.length !== 6) {
        throw new Error(`Для АКТА в буфере должно быть ровно 6 непустых строк: тип, ИНН, номер, дата, сумма, полный путь к PDF. Сейчас: ${lines.length}.`);
      }
      return {
        raw: String(text ?? ""),
        lines,
        type,
        code: "ACT",
        targetHash: TARGET_HASHES.ACT,
        inn: lines[1],
        number: lines[2],
        date: lines[3],
        amount: lines[4],
        filePath: lines[5]
      };
    }

    if (type === "ДОГОВОР") {
      if (lines.length !== 5) {
        throw new Error(`Для ДОГОВОРА в буфере должно быть ровно 5 непустых строк: тип, ИНН, номер, дата, полный путь к PDF. Сейчас: ${lines.length}.`);
      }
      return {
        raw: String(text ?? ""),
        lines,
        type,
        code: "AGREEMENT",
        targetHash: TARGET_HASHES.AGREEMENT,
        inn: lines[1],
        number: lines[2],
        date: lines[3],
        amount: "",
        filePath: lines[4]
      };
    }

    throw new Error(`Неизвестный тип документа в первой строке: «${lines[0]}». Допустимо: АКТ, ДОГОВОР, СЧЁТ.`);
  };

  const parseLinkData = (hash) => {
    const value = String(hash || "");
    const markerIndex = value.indexOf(AUTO_LINK_MARKER);
    if (markerIndex < 0) return null;

    const routeHash = markerIndex > 0 ? value.slice(0, markerIndex) : "";
    const params = new URLSearchParams(value.slice(markerIndex + AUTO_LINK_MARKER.length));
    const rawType = String(params.get("type") || "").trim().toUpperCase();
    const typeMap = {
      "АКТ": { type: "АКТ", code: "ACT", targetHash: TARGET_HASHES.ACT },
      "ACT": { type: "АКТ", code: "ACT", targetHash: TARGET_HASHES.ACT },
      "ДОГОВОР": { type: "ДОГОВОР", code: "AGREEMENT", targetHash: TARGET_HASHES.AGREEMENT },
      "AGREEMENT": { type: "ДОГОВОР", code: "AGREEMENT", targetHash: TARGET_HASHES.AGREEMENT },
      "СЧЁТ": { type: "СЧЁТ", code: "ACCOUNT", targetHash: TARGET_HASHES.ACCOUNT },
      "СЧЕТ": { type: "СЧЁТ", code: "ACCOUNT", targetHash: TARGET_HASHES.ACCOUNT },
      "ACCOUNT": { type: "СЧЁТ", code: "ACCOUNT", targetHash: TARGET_HASHES.ACCOUNT }
    };

    const meta = typeMap[rawType];
    if (!meta) {
      throw new Error(`В ссылке не указан поддерживаемый type. Допустимо: АКТ, ДОГОВОР, СЧЁТ.`);
    }

    const data = {
      raw: value,
      lines: [],
      routeHash,
      ...meta,
      inn: String(params.get("inn") || "").trim(),
      number: String(params.get("number") || "").trim(),
      date: String(params.get("date") || "").trim(),
      amount: String(params.get("amount") || "").trim(),
      filePath: String(params.get("file") || "").trim()
    };

    return data;
  };

  const validateData = (data, source) => {
    const sourceText = source === "link" ? "В ссылке" : "В буфере";
    if (!/^\d{10}$|^\d{12}$/.test(String(data.inn || "").replace(/\D/g, ""))) {
      throw new Error(`${sourceText} ИНН должен содержать 10 или 12 цифр.`);
    }
    if (!data.number) throw new Error(`${sourceText} отсутствует номер документа (${data.type}).`);
    if (!isDateText(data.date)) throw new Error(`${sourceText} дата документа должна иметь формат ДД.ММ.ГГГГ.`);
    if ((data.code === "ACT" || data.code === "ACCOUNT") && !/^\d+(?:[.,]\d+)?$/.test(String(data.amount || "").replace(/\s/g, ""))) {
      throw new Error(`${sourceText} сумма документа «${data.type}» должна быть числом.`);
    }
    if (!data.filePath) throw new Error(`${sourceText} отсутствует полный путь к PDF-файлу.`);
    if (!/^[A-Za-z]:\\.+\.pdf$/i.test(data.filePath)) {
      throw new Error(`${sourceText} должен быть указан полный Windows-путь к PDF-файлу, например C:\\...\\file.pdf.`);
    }
  };

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };

  const waitFor = async (producer, timeout = 12000, interval = 80, errorText = "Элемент не найден") => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = producer();
      if (value) return value;
      await sleep(interval);
    }
    throw new Error(errorText);
  };

  const nativeValueSetter = (element) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(prototype, "value")?.set || null;
  };

  const setControlledValue = (element, value, { change = true } = {}) => {
    if (!element) throw new Error("Поле формы не найдено.");
    const previous = element.value;
    const setter = nativeValueSetter(element);
    if (setter) setter.call(element, String(value));
    else element.value = String(value);

    if (element._valueTracker && typeof element._valueTracker.setValue === "function") {
      element._valueTracker.setValue(previous);
    }

    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (change) element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };

  const clickElement = (element) => {
    if (!element) return;
    try { element.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) { }
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  };

  const navigateToDocument = async (data) => {
    const targetHash = data.targetHash;
    if (location.hash !== targetHash) {
      location.hash = targetHash;
    }
    const formName = data.code === "AGREEMENT"
      ? "Договор"
      : data.code === "ACCOUNT"
        ? "Счет (неструктурированный)"
        : "Акт выполненных работ";

    // SPA дорисовывает форму поэтапно. Одного появления поля partner недостаточно:
    // при запуске из новой вкладки оно появляется раньше переключателя режима и
    // остальных контролов. Ждём реальную готовность конкретной формы.
    await waitFor(
      () => {
        if (location.hash !== targetHash) return false;

        const partner = document.querySelector('input[name="partner"].autocomplete-input:not([form="filters"])');
        const number = document.querySelector('input[name="number"].input-element');
        const date = findDateInput();
        if (!partner || !number || !date || !isVisible(partner) || !isVisible(number) || !isVisible(date)) return false;

        if (data.code === "ACT" || data.code === "ACCOUNT") {
          const sum = document.querySelector('input[name="sum"].numeric-text-box-input');
          if (!sum || !isVisible(sum)) return false;
        }

        if (data.code === "ACT" || data.code === "AGREEMENT") {
          const exchangeButton = Array.from(document.querySelectorAll("button")).find((item) =>
            String(item.textContent || "").replace(/\s+/g, " ").trim() === "Отправить через Документооборот" && isVisible(item)
          );
          if (!exchangeButton) return false;
        }

        return true;
      },
      20000,
      100,
      `Штатная форма «${formName}» не успела полностью загрузиться.`
    );

    // Даём React завершить последний цикл обновления состояния после рендера.
    await sleep(250);
  };

  const findDateInput = () => {
    const named = [
      'input[name="date"]',
      'input[name="documentDate"]',
      'input[name="docDate"]'
    ];
    for (const selector of named) {
      const found = document.querySelector(selector);
      if (found && isVisible(found)) return found;
    }

    const dateInputs = Array.from(document.querySelectorAll("input.datepicker-input"))
      .filter((input) => input.getAttribute("form") !== "filters" && isVisible(input));
    return dateInputs[0] || null;
  };

  const fillBasicFields = async (data) => {
    const response = await sendMessage({
      type: "act:fillFormTrusted",
      documentCode: data.code,
      inn: data.inn,
      number: data.number,
      date: data.date,
      amount: (data.code === "ACT" || data.code === "ACCOUNT") ? data.amount.replace(/\s/g, "").replace(",", ".") : ""
    });
    if (!response?.ok) throw new Error(response?.error || "Не удалось заполнить реквизиты документа.");
    return {
      warnings: Array.isArray(response.warnings) ? response.warnings : [],
      partnerSelected: Boolean(response.partnerSelected),
      partnerName: String(response.partnerName || ""),
      partnerMatches: Number(response.partnerMatches || 0)
    };
  };

  const ensureCheckbox = async (name) => {
    const checkbox = await waitFor(
      () => document.querySelector(`input[name="${name}"][type="checkbox"]`),
      5000,
      80,
      `Флажок ${name} не найден.`
    );
    if (!checkbox.checked) clickElement(checkbox);
    await sleep(80);
    if (!checkbox.checked) throw new Error(`Не удалось установить флажок ${name}.`);
  };

  const deriveFileCandidates = (data) => {
    const original = data.filePath.trim();
    const candidates = [original];

    // Частая ошибка буфера: между последней папкой и именем файла пропущен "\".
    // Сначала всегда пробуем путь ровно из буфера. Затем — безопасный fallback
    // только для известного шаблона имени акта.
    const marker = "Акт оказанных услуг";
    const markerIndex = original.lastIndexOf(marker);
    if (markerIndex > 2 && original[markerIndex - 1] !== "\\") {
      candidates.push(original.slice(0, markerIndex) + "\\" + original.slice(markerIndex));
    }

    return Array.from(new Set(candidates));
  };

  const base64ToBytes = (base64) => {
    const binary = atob(String(base64 || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const attachFile = async (data) => {
    const input = await waitFor(
      () => document.querySelector('input[name="file"][type="file"]'),
      8000,
      80,
      "Штатное поле загрузки PDF не найдено."
    );

    const response = await sendMessage({ type: "act:readLocalFile", paths: deriveFileCandidates(data) });
    if (!response?.ok || !response.file) throw new Error(response?.error || "Не удалось прочитать PDF-файл с диска.");

    const info = response.file;
    const bytes = base64ToBytes(info.base64);
    const file = new File([bytes], info.name || "document.pdf", {
      type: info.mime || "application/pdf",
      lastModified: Date.now()
    });

    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;

    // В записи сессии именно штатный change на input[name=file] через 6 мс
    // запускает uploadFile() сайта и POST /api/import. Поэтому не делаем
    // собственный HTTP-запрос: отдаём File штатному обработчику страницы.
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await waitFor(() => {
      const text = document.body?.innerText || "";
      return /Файл\s+".+"\s+загружен/i.test(text);
    }, 15000, 120, "Файл передан штатному полю, но сайт не подтвердил /api/import.");

    return info.path;
  };

  const focusCommentField = async () => {
    const comment = await waitFor(
      () => {
        const element = document.querySelector('textarea[name="comment"]');
        return element && isVisible(element) ? element : null;
      },
      5000,
      80,
      "Поле «Комментарий» не найдено для установки фокуса."
    );

    try { comment.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) { }
    comment.focus();
    if (typeof comment.setSelectionRange === "function") {
      const end = String(comment.value || "").length;
      comment.setSelectionRange(end, end);
    }
    await sleep(50);
    if (document.activeElement !== comment) {
      throw new Error("Не удалось установить фокус в поле «Комментарий».");
    }
  };

  const showMessage = (text, isError = false) => {
    let box = document.getElementById("einv-edo-message");
    if (!box) {
      box = document.createElement("div");
      box.id = "einv-edo-message";
      Object.assign(box.style, {
        position: "fixed",
        zIndex: "2147483647",
        maxWidth: "520px",
        padding: "10px 14px",
        borderRadius: "8px",
        fontFamily: "Arial, sans-serif",
        fontSize: "13px",
        lineHeight: "1.35",
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.24)",
        whiteSpace: "pre-wrap"
      });
      document.documentElement.appendChild(box);
    }

    const rect = controls.getBoundingClientRect();
    box.style.left = `${Math.max(PAGE_MARGIN, Math.min(rect.left, window.innerWidth - 540))}px`;
    box.style.top = `${Math.min(window.innerHeight - 80, rect.bottom + 8)}px`;
    box.style.background = isError ? "#fce8e6" : "#e6f4ea";
    box.style.color = isError ? "#b3261e" : "#137333";
    box.style.border = `1px solid ${isError ? "#f28b82" : "#81c995"}`;
    box.textContent = text;
    box.hidden = false;
    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => { box.hidden = true; }, isError ? 12000 : 5000);
  };

  const readClipboard = async () => {
    const response = await sendMessage({ type: "act:readClipboard" });
    if (!response?.ok) throw new Error(response?.error || "Не удалось прочитать буфер обмена.");
    const text = String(response.text ?? "");
    if (!text.trim()) throw new Error("Буфер обмена пуст.");
    return text;
  };

  const run = async (linkData = null) => {
    if (running) return;
    running = true;
    setButtonState(
      "working",
      linkData
        ? "Читаю данные из ссылки, открываю штатную форму и заполняю реквизиты."
        : "Читаю буфер, определяю тип ЭДО-документа, открываю штатную форму и заполняю реквизиты."
    );

    try {
      const data = linkData || parseClipboard(await readClipboard());
      validateData(data, linkData ? "link" : "clipboard");
      await navigateToDocument(data);
      const fillResult = await fillBasicFields(data);
      const fieldWarnings = fillResult.warnings;

      let loadedPath = "";
      try {
        loadedPath = await attachFile(data);
      } catch (fileError) {
        const fileMessage = `Поля заполнены, но PDF не загружен: ${fileError?.message || String(fileError)}\nПуть: ${data.filePath}`;
        setButtonState("warn", fileMessage);
        showMessage(fileMessage, true);
        return;
      }

      await focusCommentField();

      if (fieldWarnings.length) {
        const warningText = `Документ и PDF заполнены с предупреждениями: ${fieldWarnings.join(" ")}\nФайл: ${loadedPath}`;
        setButtonState("warn", warningText);
        showMessage(warningText, true);
      } else {
        // При успешном завершении никаких сообщений не показываем.
        setButtonState("idle");
      }
    } catch (error) {
      console.error("[EDO documents]", error);
      const message = error?.message || String(error);
      setButtonState("error", message);
      showMessage(`Ошибка: ${message}`, true);
    } finally {
      running = false;
    }
  };

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || button.disabled) return;
    const rect = controls.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false
    };
    button.setPointerCapture(event.pointerId);
    button.style.cursor = "grabbing";
    event.preventDefault();
  });

  button.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) drag.moved = true;
    if (drag.moved) applyPosition(drag.left + dx, drag.top + dy);
    event.preventDefault();
  });

  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    try { button.releasePointerCapture(event.pointerId); } catch (_) { }
    drag = null;
    button.style.cursor = running ? "wait" : "grab";
    if (moved) {
      suppressNextClick = true;
      savePosition();
    }
  };

  button.addEventListener("pointerup", finishDrag);
  button.addEventListener("pointercancel", finishDrag);

  button.addEventListener("click", (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      return;
    }
    void run();
  });

  window.addEventListener("resize", () => {
    const rect = controls.getBoundingClientRect();
    applyPosition(rect.left, rect.top);
  });

  // Запуск по ссылке. Сначала в fragment идёт валидный штатный route формы,
  // затем служебный маркер расширения и параметры. Сервер fragment не получает.
  // Буфер при таком запуске не читается.
  // Формат:
  // #/document/create/ACT#__edo__?type=АКТ&inn=...&number=...&date=...&amount=...&file=...
  // #/document/create/AGREEMENT#__edo__?type=ДОГОВОР&inn=...&number=...&date=...&file=...
  // #/document/create/ACCOUNT#__edo__?type=СЧЁТ&inn=...&number=...&date=...&amount=...&file=...
  const handleAutoLaunch = () => {
    let data = null;
    try {
      data = parseLinkData(location.hash);
    } catch (error) {
      const message = error?.message || String(error);
      setButtonState("error", message);
      showMessage(`Ошибка: ${message}`, true);
      return;
    }
    if (!data) return;

    // type является источником истины для сценария. Если route в ссылке
    // ошибочно не совпал с type, всё равно переводим SPA на нужную форму.
    // Одновременно удаляем служебные параметры и исключаем повторный запуск.
    if (location.hash !== data.targetHash) {
      location.hash = data.targetHash;
    }
    setTimeout(() => { void run(data); }, 0);
  };

  window.addEventListener("hashchange", handleAutoLaunch);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "act:run") void run();
  });

  // Обрабатываем специальную ссылку и при первоначальной загрузке страницы.
  handleAutoLaunch();
})();
