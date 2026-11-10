(() => {
  const cfg = window.BUDGET_CONFIG;
  const HASH_KEY = "budgetTracker.passHash";
  const SALT = "budgettracker:";
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const $ = (id) => document.getElementById(id);

  const state = { entries: [], caps: [], weekStart: mondayOf(todayStr()), selectedDay: null };

  // ---------- Dates (local timezone, YYYY-MM-DD strings) ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function toStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function todayStr() { return toStr(new Date()); }
  function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return toStr(d); }
  function mondayOf(s) { const d = parse(s); return addDays(s, -((d.getDay() + 6) % 7)); }
  function fmtDay(s, opts) { return parse(s).toLocaleDateString("en-AU", opts); }

  function sheetDate(value, field, row) {
    let date = value;
    if (typeof value === "string") {
      const legacy = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: .*)?$/.exec(value);
      if (legacy) {
        const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(legacy[1]) + 1;
        date = `${legacy[3]}-${pad(month)}-${pad(legacy[2])}`;
      }
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || toStr(parse(date)) !== date) {
      throw new Error(`Invalid ${field} in record ${row}. Check the date in Google Sheets.`);
    }
    return date;
  }

  // ---------- API ----------
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function api(action, payload = {}, hash = localStorage.getItem(HASH_KEY)) {
    if (!cfg.API_URL) throw new Error("Set API_URL in config.js");
    // text/plain avoids a CORS preflight, which Apps Script can't answer.
    const res = await fetch(cfg.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, hash, ...payload }),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(data.error || "Request failed");
      err.code = data.code;
      throw err;
    }
    return data;
  }

  function setStatus(text, isError) {
    const chip = $("statusChip");
    chip.textContent = text;
    chip.classList.toggle("error-chip", !!isError);
  }

  // ---------- Calculations ----------
  function capFor(weekStart) {
    let cap = cfg.DEFAULT_CAP;
    for (const c of state.caps) if (c.effectiveWeek <= weekStart) cap = c.cap;
    return cap;
  }

  function weekSpent(weekStart) {
    const end = addDays(weekStart, 6);
    return state.entries
      .filter((e) => e.date >= weekStart && e.date <= end)
      .reduce((sum, e) => sum + e.amount, 0);
  }

  function dayEntries(day) { return state.entries.filter((e) => e.date === day); }
  function sum(list) { return list.reduce((s, e) => s + e.amount, 0); }

  // ---------- Rendering ----------
  function render() {
    renderWeek();
    renderHistory();
  }

  function renderWeek() {
    const ws = state.weekStart;
    const cap = capFor(ws);
    const spent = weekSpent(ws);
    const remaining = cap - spent;
    const thisWeek = mondayOf(todayStr());

    $("weekLabel").textContent = `${fmtDay(ws, { day: "numeric", month: "short" })} – ${fmtDay(addDays(ws, 6), { day: "numeric", month: "short" })}`;
    $("thisWeek").hidden = ws === thisWeek;
    $("spentValue").textContent = money.format(spent);
    $("capBtn").textContent = money.format(cap);
    $("remainingLabel").textContent = remaining >= 0 ? "Under limit" : "Over limit";
    const rv = $("remainingValue");
    rv.textContent = money.format(Math.abs(remaining));
    rv.className = remaining >= 0 ? "good" : "bad";

    const pct = cap > 0 ? Math.min(100, Math.max(0, (spent / cap) * 100)) : spent > 0 ? 100 : 0;
    const fill = $("meterFill");
    fill.style.width = pct + "%";
    fill.classList.toggle("over", spent > cap);

    const list = $("dayList");
    list.textContent = "";
    for (let i = 0; i < 7; i++) {
      const day = addDays(ws, i);
      const entries = dayEntries(day);
      const btn = document.createElement("button");
      btn.className = "day" + (day === todayStr() ? " today" : "");
      btn.innerHTML = `<span><strong></strong><div class="sub"></div></span><span class="amt"></span>`;
      btn.querySelector("strong").textContent = fmtDay(day, { weekday: "long" });
      btn.querySelector(".sub").textContent =
        fmtDay(day, { day: "numeric", month: "short" }) + (entries.length ? ` · ${entries.length} item${entries.length > 1 ? "s" : ""}` : "");
      btn.querySelector(".amt").textContent = money.format(sum(entries));
      btn.addEventListener("click", () => openDay(day));
      list.appendChild(btn);
    }
  }

  function historyRows() {
    if (!state.entries.length) return [];
    const first = mondayOf(state.entries.reduce((m, e) => (e.date < m ? e.date : m), state.entries[0].date));
    const last = mondayOf(todayStr());
    const rows = [];
    let running = 0;
    for (let w = first; w <= last; w = addDays(w, 7)) {
      const cap = capFor(w);
      const spent = weekSpent(w);
      running += cap - spent;
      rows.push({ week: w, spent, cap, diff: cap - spent, running });
    }
    return rows;
  }

  function renderHistory() {
    const rows = historyRows();
    const running = rows.length ? rows[rows.length - 1].running : 0;
    const rv = $("runningValue");
    rv.textContent = (running >= 0 ? "+" : "−") + money.format(Math.abs(running));
    rv.className = running >= 0 ? "good" : "bad";
    $("runningHint").textContent = running >= 0 ? "under limit overall" : "over limit overall";

    const maxVal = Math.max(1, ...rows.map((r) => Math.max(r.spent, r.cap)));
    const chart = $("historyChart");
    chart.textContent = "";
    for (const r of rows) {
      const bar = document.createElement("div");
      bar.className = "bar" + (r.spent > r.cap ? " over" : "");
      bar.style.height = Math.max(2, (r.spent / maxVal) * 100) + "%";
      bar.title = `${r.week}: ${money.format(r.spent)} of ${money.format(r.cap)}`;
      chart.appendChild(bar);
    }
    chart.scrollLeft = chart.scrollWidth;

    const body = $("historyBody");
    body.textContent = "";
    for (const r of [...rows].reverse()) {
      const tr = document.createElement("tr");
      const cells = [
        fmtDay(r.week, { day: "numeric", month: "short", year: "2-digit" }),
        money.format(r.spent),
        money.format(r.cap),
        (r.diff >= 0 ? "+" : "−") + money.format(Math.abs(r.diff)),
        (r.running >= 0 ? "+" : "−") + money.format(Math.abs(r.running)),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 3) td.className = r.diff >= 0 ? "good" : "bad";
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
  }

  // ---------- Dialogs ----------
  function fillUsers(select) {
    select.textContent = "";
    for (const u of cfg.USERS) select.add(new Option(u, u));
    select.value = cfg.USERS[0];
  }

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function openAdd(date = todayStr()) {
    $("addForm").reset();
    $("addDate").value = date;
    $("addUser").value = cfg.USERS[0];
    $("receiptFile").value = "";
    $("receiptSuggestions").textContent = "";
    $("receiptSuggestions").hidden = true;
    $("receiptStatus").textContent = "";
    $("receiptStatus").hidden = true;
    for (const c of $("addNotes").children) c.classList.remove("selected");
    showError("addError");
    $("addDialog").showModal();
    $("addAmount").focus();
  }

  function receiptAmounts(text) {
    const candidates = new Map();
    const excluded = /\b(sub.?total|change|cash|visa|mastercard|eftpos|gst|tax)\b/i;
    const total = /\b(grand\s+total|amount\s+due|total\s+due|total)\b/i;
    for (const line of text.split(/\r?\n/)) {
      const amounts = line.matchAll(/(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d+)[.,](\d{2})\b/g);
      for (const match of amounts) {
        const amount = Number(`${match[1].replace(/,/g, "")}.${match[2]}`);
        if (!(amount > 0) || !Number.isFinite(amount)) continue;
        const key = amount.toFixed(2);
        const score = (total.test(line) ? 2 : 0) - (excluded.test(line) ? 1 : 0);
        const existing = candidates.get(key);
        if (!existing || score > existing.score) candidates.set(key, { amount, score });
      }
    }
    return [...candidates.values()].sort((a, b) => b.score - a.score || b.amount - a.amount).slice(0, 5);
  }

  async function scanReceipt(file) {
    const status = $("receiptStatus");
    const suggestions = $("receiptSuggestions");
    const scanButton = $("scanReceiptBtn");
    suggestions.textContent = "";
    suggestions.hidden = true;
    status.hidden = false;
    showError("addError");

    if (!window.Tesseract) {
      status.textContent = "Receipt scanning could not load. Check your internet connection and try again.";
      return;
    }

    scanButton.disabled = true;
    status.textContent = "Preparing receipt scanner…";
    let worker;
    try {
      worker = await window.Tesseract.createWorker("eng", 1, {
        logger: (progress) => {
          if (progress.status === "recognizing text" && Number.isFinite(progress.progress)) {
            status.textContent = `Reading receipt… ${Math.round(progress.progress * 100)}%`;
          }
        },
      });
      const result = await worker.recognize(file);
      const amounts = receiptAmounts(result.data.text);
      if (!amounts.length) {
        status.textContent = "No clear amounts found. You can enter the total manually.";
        return;
      }

      status.textContent = "Choose the receipt total to fill in the amount:";
      for (const [index, candidate] of amounts.entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "receipt-suggestion";
        button.textContent = `${money.format(candidate.amount)}${index === 0 ? " · most likely" : ""}`;
        button.addEventListener("click", () => {
          $("addAmount").value = candidate.amount.toFixed(2);
          suggestions.hidden = true;
          status.textContent = "Amount filled in. Check it against the receipt before saving.";
          $("addAmount").focus();
        });
        suggestions.appendChild(button);
      }
      suggestions.hidden = false;
    } catch (err) {
      status.textContent = "Could not read that image. Try a clearer photo or enter the total manually.";
      console.error("Receipt OCR failed:", err);
    } finally {
      try {
        if (worker) await worker.terminate();
      } catch (err) {
        console.error("Could not stop the receipt OCR worker:", err);
        suggestions.hidden = true;
        status.textContent = "Receipt scanner cleanup failed. Reload the app before scanning again.";
      } finally {
        scanButton.disabled = false;
      }
    }
  }

  function openDay(day) {
    state.selectedDay = day;
    const entries = dayEntries(day);
    $("dayTitle").textContent = fmtDay(day, { weekday: "long", day: "numeric", month: "long" });
    $("dayTotal").textContent = money.format(sum(entries));
    const ul = $("dayEntries");
    ul.textContent = "";
    if (!entries.length) {
      const li = document.createElement("li");
      li.textContent = "No entries yet.";
      ul.appendChild(li);
    }
    for (const e of entries) {
      const li = document.createElement("li");
      const left = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = (e.type === "adjustment" ? "Adjustment: " : "") + (e.note || "Expense");
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = e.user;
      left.append(title, sub);
      const amt = document.createElement("strong");
      amt.textContent = money.format(e.amount);
      li.append(left, amt);
      ul.appendChild(li);
    }
    $("dayDialog").showModal();
  }

  function openAdjustment(day) {
    $("adjForm").reset();
    $("adjDate").value = day;
    $("adjUser").value = cfg.USERS[0];
    showError("adjError");
    $("adjDialog").showModal();
  }

  async function submitEntry(form, entry, errorId, dialog) {
    const buttons = form.querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    showError(errorId);
    try {
      const data = await api("add", { entry });
      state.entries.push(data.entry);
      dialog.close();
      state.weekStart = mondayOf(entry.date);
      render();
      setStatus("Saved");
    } catch (err) {
      handleError(err, errorId);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function handleError(err, errorId) {
    if (err.code === "unauthorized") {
      localStorage.removeItem(HASH_KEY);
      location.reload();
      return;
    }
    showError(errorId, err.message === "Failed to fetch" ? "Offline or unreachable. Nothing was saved." : err.message);
  }

  // ---------- Events ----------
  function bindEvents() {
    document.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", () => b.closest("dialog").close())
    );
    document.querySelectorAll("dialog").forEach((d) =>
      d.addEventListener("click", (e) => { if (e.target === d) d.close(); })
    );

    $("prevWeek").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, -7); renderWeek(); });
    $("nextWeek").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, 7); renderWeek(); });
    $("thisWeek").addEventListener("click", () => { state.weekStart = mondayOf(todayStr()); renderWeek(); });
    $("fabAdd").addEventListener("click", () => openAdd());
    $("scanReceiptBtn").addEventListener("click", () => $("receiptFile").click());
    $("receiptFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) scanReceipt(file);
    });

    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((x) => x.classList.toggle("active", x === b));
        $("tab-week").hidden = b.dataset.tab !== "week";
        $("tab-history").hidden = b.dataset.tab !== "history";
        $("fabAdd").hidden = b.dataset.tab !== "week";
        if (b.dataset.tab === "history") renderHistory();
      })
    );

    // Note presets
    const notes = $("addNotes");
    for (const label of cfg.NOTE_PRESETS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip-btn";
      chip.textContent = label;
      chip.addEventListener("click", () => {
        const on = !chip.classList.contains("selected");
        for (const c of notes.children) c.classList.remove("selected");
        chip.classList.toggle("selected", on);
        $("addNote").value = on ? label : "";
      });
      notes.appendChild(chip);
    }

    $("addForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const amount = parseFloat($("addAmount").value);
      if (!(amount > 0)) return showError("addError", "Enter an amount above 0.");
      submitEntry(
        e.target,
        { date: $("addDate").value, user: $("addUser").value, amount, type: "spend", note: $("addNote").value.trim() },
        "addError",
        $("addDialog")
      );
    });

    $("dayAdjustBtn").addEventListener("click", () => {
      const day = state.selectedDay;
      $("dayDialog").close();
      openAdjustment(day);
    });

    $("adjForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const raw = parseFloat($("adjAmount").value);
      if (!(raw > 0)) return showError("adjError", "Enter an amount above 0.");
      const sign = e.target.elements.adjType.value === "subtract" ? -1 : 1;
      submitEntry(
        e.target,
        { date: $("adjDate").value, user: $("adjUser").value, amount: sign * raw, type: "adjustment", note: $("adjNote").value.trim() },
        "adjError",
        $("adjDialog")
      );
    });

    $("capBtn").addEventListener("click", () => {
      $("capInput").value = capFor(state.weekStart);
      showError("capError");
      $("capDialog").showModal();
    });

    $("capForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const cap = parseFloat($("capInput").value);
      if (!(cap >= 0)) return showError("capError", "Enter a valid limit.");
      try {
        const data = await api("setCap", { effectiveWeek: state.weekStart, cap });
        state.caps = data.caps;
        $("capDialog").close();
        render();
      } catch (err) {
        handleError(err, "capError");
      }
    });
  }

  // ---------- Boot ----------
  async function load() {
    setStatus("Loading");
    showError("loadError");
    try {
      const data = await api("getAll");
      const entries = data.entries.map((entry, index) => ({
        ...entry,
        date: sheetDate(entry.date, "entry date", index + 1),
      }));
      const caps = data.caps.map((cap, index) => ({
        ...cap,
        effectiveWeek: sheetDate(cap.effectiveWeek, "limit date", index + 1),
      })).sort((a, b) => (a.effectiveWeek < b.effectiveWeek ? -1 : 1));
      state.entries = entries;
      state.caps = caps;
      render();
      setStatus("Synced");
    } catch (err) {
      if (err.code === "unauthorized") return showLock();
      setStatus("Load failed", true);
      showError("loadError", err.message === "Failed to fetch"
        ? "Could not load entries. Check your connection and refresh."
        : `Could not load entries: ${err.message}`);
      console.error("Could not load budget data:", err);
      render();
    }
  }

  function showLock() {
    localStorage.removeItem(HASH_KEY);
    $("appView").hidden = true;
    $("lockView").hidden = false;
    $("passInput").focus();
  }

  async function start() {
    fillUsers($("addUser"));
    fillUsers($("adjUser"));
    bindEvents();

    $("lockForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      showError("lockError");
      try {
        const hash = await sha256($("passInput").value.trim());
        await api("getAll", {}, hash);
        localStorage.setItem(HASH_KEY, hash);
        $("passInput").value = "";
        $("lockView").hidden = true;
        $("appView").hidden = false;
        load();
      } catch (err) {
        showError("lockError", err.code === "unauthorized" ? "Wrong passcode." : err.message);
      }
    });

    if (localStorage.getItem(HASH_KEY)) {
      $("appView").hidden = false;
      load();
    } else {
      $("lockView").hidden = false;
    }

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  start();
})();
