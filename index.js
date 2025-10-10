// index.js
require("dotenv").config();
const { Bot, GrammyError, HttpError, InlineKeyboard } = require("grammy");
const { hydrate } = require("@grammyjs/hydrate");
const axios = require("axios");

// ----------------------- НАСТРОЙКИ -----------------------
const bot = new Bot(process.env.BOT_API_KEY);
bot.use(hydrate());

const AIRTABLE_API = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE_ID;
const AIRTABLE_PLACES = process.env.AIRTABLE_PLACES_TABLE_ID;
const AIRTABLE_SMS = process.env.AIRTABLE_SMS_ID;
const AIRTABLE_PNL = process.env.AIRTABLE_PNL_ID;

// Лучше хранить в .env
const SECONDARY_CHAT = Number(process.env.SECONDARY_CHAT_ID || -1002203093713);

// Airtable URLs
const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
const airtablePlacesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_PLACES}`;
const airtableMessagesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SMS}`;
const airtablePnlUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_PNL}`;

// Авторизация пользователей
const allowedIds = []; // при желании добавь свои user_id
const allowedUsers = [
  "Lokatororator",
  "Shaaaaaaat",
  "kapitanstar_coach",
  "Gshakhnazarov",
  "dima_dubinin",
  "e_katrin_al",
];

const BUTTONS_PER_PAGE = 7;

// ----------------------- ХЕЛПЕРЫ -----------------------
const esc = (s = "") =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// --- LOG: простой структурный лог в одну строку ---
const jlog = (ctx, event, extra = {}) => {
  const u = ctx.from || {};
  const base = {
    ts: new Date().toISOString(),
    event,
    uid: u.id,
    uname: u.username || null,
  };
  console.log(JSON.stringify({ ...base, ...extra }));
};

// Мгновенный ответ на клик — лечит "query is too old"
const safeAnswerCb = async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
  } catch (e) {
    if (!(e instanceof GrammyError && e.error_code === 400)) {
      console.error("answerCallbackQuery error:", e);
    }
  }
};

// Парсер дат dd.mm или dd.mm.yyyy с «разумным» годом
const parseDMY = (s = "") => {
  const parts = s.split(".");
  if (parts.length === 3) return new Date(+parts[2], +parts[1] - 1, +parts[0]);
  const [d, m] = parts.map(Number);
  const now = new Date();
  let y = now.getFullYear();
  const candidate = new Date(y, m - 1, d);
  if (candidate > now) y -= 1;
  return new Date(y, m - 1, d);
};
const compareDates = (date1, date2) => parseDMY(date1) >= parseDMY(date2);

// Простой кэш только для второстепенных данных (напр. локации, pnl)
const putCache = (bag, key, val, ttlMs = 5 * 60 * 1000) => {
  bag._cache ??= {};
  bag._cache[key] = { val, exp: Date.now() + ttlMs };
  return val;
};
const getCache = (bag, key) => {
  const rec = bag._cache?.[key];
  return rec && rec.exp > Date.now() ? rec.val : null;
};

// ----------------------- СОСТОЯНИЕ -----------------------
const userStates = {}; // userId -> state

const freshState = () => ({
  buttonTexts: [], // имена (для отображения)
  buttonIds: [], // [{id:'p_0', name:'Иван'}]
  buttonStates: {}, // {'p_0': true/false} — group/personal
  buttonCounters: {}, // {'p_0': 0..n}       — ds
  currentPage: 0,
  selectedDate: "---",
  selectedFormat: "---", // 'ds' | 'group' | 'personal'
  selectedLocation: "---", // meaning
  locations: [], // [{id:'loc_0', label:'...', meaning:'...'}]
  pnlDataCache: [],
  _cache: null,
});
const ensureState = (uid) => (userStates[uid] ??= freshState());
const resetUserState = (uid) => {
  userStates[uid] = freshState();
};

// Подсчёт общего количества выбранных людей
const calcSelectedCount = (st) => {
  if (st.selectedFormat === "ds") {
    return Object.values(st.buttonCounters || {}).reduce(
      (a, b) => a + (b || 0),
      0
    );
  }
  return Object.values(st.buttonStates || {}).filter(Boolean).length;
};

// Единая «шапка» — всегда со строкой 🔢 Кол-во
const buildSummary = (st) => {
  let txt =
    `<b>Введенные данные:</b>\n` +
    `📅 Дата: ${esc(st.selectedDate || "---")}\n` +
    `🤸 Тип тренировки: ${esc(st.selectedFormat || "---")}`;

  if (st.selectedFormat !== "ds") {
    txt += `\n📍 Место: ${esc(st.selectedLocation || "---")}`;
  }

  const totalCount = calcSelectedCount(st);
  txt += `\n🔢 Кол-во: ${totalCount}`;

  if (st.selectedFormat === "ds") {
    const pickedList = Object.entries(st.buttonCounters || {})
      .filter(([, v]) => v > 0)
      .map(
        ([id, v]) =>
          `${v}x ${st.buttonIds.find((x) => x.id === id)?.name || "?"}`
      );
    txt += `\n👥 Люди: ${esc(pickedList.join(", ") || "---")}`;
  } else {
    const pickedNames = Object.entries(st.buttonStates || {})
      .filter(([, v]) => !!v)
      .map(([id]) => st.buttonIds.find((x) => x.id === id)?.name || "?");
    txt += `\n👥 Люди: ${esc(pickedNames.join(", ") || "---")}`;
  }
  return txt;
};

// ----------------------- AIRTABLE -----------------------
const fetchDataFromAirtable = async (username, url) => {
  let records = [];
  let offset = null;
  do {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API}` },
      params: { offset, pageSize: 100 },
    });
    records = records.concat(response.data.records);
    offset = response.data.offset;
  } while (offset);

  return records
    .filter((r) => r.fields.Coach && r.fields.Coach.includes(username))
    .map((r) => ({
      name: r.fields.FIO3,
      place: r.fields.Places,
      meaning: r.fields.Meanings,
    }));
};

const sendMessageToAirtable = async (message) => {
  try {
    await axios.post(
      airtableMessagesUrl,
      { records: [{ fields: { Message: message } }] },
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_API}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "Error sending message to Airtable:",
      error?.response?.data || error
    );
  }
};

const sendMessagesWithPause = async (messages) => {
  for (const message of messages) {
    await sendMessageToAirtable(message);
    await new Promise((r) => setTimeout(r, 10000));
  }
};

const fetchPnlDataFromAirtable = async (username, startDateDM) => {
  let records = [];
  let offset = null;
  const filterFormula = `OR({Coach} = '${username}', {Second_coach} = '${username}')`;
  do {
    const response = await axios.get(airtablePnlUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API}` },
      params: { offset, pageSize: 100, filterByFormula: filterFormula },
    });
    records = records.concat(response.data.records);
    offset = response.data.offset;
  } while (offset);

  return records
    .map((r) => ({
      date: r.fields.Data,
      coach: r.fields.Coach,
      secondCoach: r.fields.Second_coach,
      format: r.fields.Format,
      place: r.fields.Place,
      expense: r.fields.Expenses_coach || 0,
      secondExpense: r.fields.Expenses_second_coach || 0,
    }))
    .filter((rec) => compareDates(rec.date, startDateDM))
    .sort((a, b) => parseDMY(a.date) - parseDMY(b.date));
};

// ----------------------- UI КЛАВИАТУРЫ -----------------------
const createDateKeyboard = () => {
  const kb = new InlineKeyboard();
  const now = new Date();
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    dates.push(`${day}.${month}`);
  }
  kb.text(dates[0], dates[0]).row();
  for (let i = 4; i > 0; i--) kb.text(dates[i], dates[i]);
  kb.row();
  kb.text("🔄 Обновить даты", "refresh_dates").row();
  kb.text("💰 Посмотреть начисления", "view_pnl").row();
  return kb;
};

const createFormatKeyboard = () =>
  new InlineKeyboard()
    .text("ds", "ds")
    .row()
    .text("group", "group")
    .row()
    .text("personal", "personal")
    .row()
    .text("⬅️ Вернуться", "back_to_dates")
    .row();

const createLocationKeyboard = (locations = []) => {
  const kb = new InlineKeyboard();
  for (const loc of locations) {
    const label = loc.label.charAt(0).toUpperCase() + loc.label.slice(1);
    kb.text(label, `location_${loc.id}`).row(); // короткий id в callback_data
  }
  kb.text("⬅️ Вернуться", "back_to_format").row();
  return kb;
};

const createPeopleKeyboard = (userId, format) => {
  const st = ensureState(userId);
  const kb = new InlineKeyboard();
  const total = st.buttonIds.length;
  if (!total) return { keyboard: kb, currentSelection: "Нет данных" };

  const page = st.currentPage || 0;
  const start = page * BUTTONS_PER_PAGE;
  const end = Math.min(start + BUTTONS_PER_PAGE, total);
  const slice = st.buttonIds.slice(start, end);

  if (page > 0 && end < total)
    kb.text("⬅️ Назад", `prev_${page}`)
      .text("Еще люди ➡️", `next_${page}`)
      .row();
  else if (page > 0) kb.text("⬅️ Назад", `prev_${page}`).row();
  else if (end < total) kb.text("Еще люди ➡️", `next_${page}`).row();

  for (const { id, name } of slice) {
    if (format === "ds") {
      const count = st.buttonCounters[id] || 0;
      kb.text("➖", `minus_${id}`)
        .text(`(${count}) ${name}`, `pick_${id}`)
        .row();
    } else {
      const checked = !!st.buttonStates[id];
      kb.text(checked ? `${name} ✅` : name, `pick_${id}`).row();
    }
  }

  kb.text("⬅️ Вернуться", "back_to_location").text("ГОТОВО ✅", "done");

  // Единая «шапка» с Кол-во и списком людей
  const currentSelection = buildSummary(st);
  return { keyboard: kb, currentSelection };
};

// ----------------------- PNL ДАТЫ -----------------------
const getLastEightMondays = () => {
  const dates = [];
  const now = new Date();
  const day = now.getDay(); // 0 вс, 1 пн
  const diff = day === 1 ? 0 : day === 0 ? 6 : day - 1;
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - diff);
  for (let i = 0; i < 8; i++) {
    const d = new Date(lastMonday);
    d.setDate(lastMonday.getDate() - i * 7);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    dates.push(`${dd}.${mm}`);
  }
  return dates.reverse();
};

const createPnlDateKeyboard = () => {
  const kb = new InlineKeyboard();
  const dates = getLastEightMondays();
  for (let i = 0; i < dates.length; i += 4) {
    if (dates[i]) kb.text(dates[i], `pnl_date_${dates[i]}`);
    if (dates[i + 1]) kb.text(dates[i + 1], `pnl_date_${dates[i + 1]}`);
    if (dates[i + 2]) kb.text(dates[i + 2], `pnl_date_${dates[i + 2]}`);
    if (dates[i + 3]) kb.text(dates[i + 3], `pnl_date_${dates[i + 3]}`);
    kb.row();
  }
  kb.text("⬅️ Вернуться", "back_to_dates").row();
  return kb;
};

// ----------------------- ОЧЕРЕДЬ ОТПРАВКИ -----------------------
const messageQueue = [];
let isProcessingQueue = false;

const processMessage = async (message) => {
  const { ctx, responseText, date, format } = message;
  const userId = ctx.from.id;
  const st = ensureState(userId);

  if (format === "ds") {
    const countsArr = Object.values(st.buttonCounters || {});
    const maxCount = countsArr.length ? Math.max(...countsArr) : 0;
    if (maxCount === 0) return;

    const messages = [];
    for (let i = 1; i <= maxCount; i++) {
      const people = Object.keys(st.buttonCounters)
        .filter((id) => st.buttonCounters[id] >= i)
        .map((id) => st.buttonIds.find((x) => x.id === id)?.name || "?");
      if (people.length > 0) {
        messages.push(
          `${ctx.from.username} / ${date} / ${format} // ${people.join(", ")}`
        );
      }
    }
    messages.reverse();
    await sendMessagesWithPause(messages);
  } else {
    await sendMessageToAirtable(responseText);
  }
};

const processQueue = async () => {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      try {
        await processMessage(msg);
      } catch (e) {
        console.error("processMessage error:", e);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    isProcessingQueue = false;
  }
};

// ----------------------- БОТ -----------------------
const initBot = async () => {
  bot.command("start", async (ctx) => {
    // LOG:
    jlog(ctx, "cmd_start");

    const { id, username } = ctx.from;

    if (!(allowedIds.includes(id) || allowedUsers.includes(username))) {
      await ctx.reply("Отказ в доступе к боту");
      return;
    }

    ensureState(id);
    const st = userStates[id];

    const currentSelection = buildSummary(st);
    await ctx.reply(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  const sendDateSelection = async (ctx) => {
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.reply(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  };

  // -------- HANDLERS --------

  // Выбор даты (главное меню)
  bot.callbackQuery(/^\d{2}\.\d{2}$/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pick_date", { date: ctx.match[0] }); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.selectedDate = ctx.match[0];

    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите формат:", {
      reply_markup: createFormatKeyboard(),
      parse_mode: "HTML",
    });
  });

  // Выбор формата (главное меню)
  bot.callbackQuery(/^(ds|group|personal)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pick_format", { format: ctx.match[0] }); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.selectedFormat = ctx.match[0];

    if (st.selectedFormat === "ds") {
      // Всегда свежий список имён
      let names = (
        await fetchDataFromAirtable(ctx.from.username, airtableUrl)
      ).map((r) => r.name);
      names.sort((a, b) => a.localeCompare(b));

      st.buttonTexts = names;
      st.buttonIds = names.map((name, i) => ({ id: `p_${i}`, name }));
      st.buttonStates = {};
      st.buttonCounters = Object.fromEntries(
        st.buttonIds.map(({ id }) => [id, 0])
      );
      st.currentPage = 0;

      const { keyboard, currentSelection } = createPeopleKeyboard(
        id,
        st.selectedFormat
      );
      await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } else {
      // Локации можно кэшировать
      let locs = getCache(st, "locations");
      if (!locs) {
        const raw = await fetchDataFromAirtable(
          ctx.from.username,
          airtablePlacesUrl
        );
        locs = raw.map((r, i) => ({
          id: `loc_${i}`,
          label: r.place,
          meaning: r.meaning,
        }));
        putCache(st, "locations", locs);
      }
      st.locations = locs;

      const currentSelection = buildSummary(st);
      await ctx.editMessageText(currentSelection + "\n\nВыберите локацию:", {
        reply_markup: createLocationKeyboard(locs),
        parse_mode: "HTML",
      });
    }
  });

  // Выбор локации (элемент главного меню в ветке group/personal)
  bot.callbackQuery(/^location_(loc_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const locId = ctx.match[1];
    const loc = (st.locations || []).find((l) => l.id === locId);
    st.selectedLocation = loc?.meaning || "---";

    // LOG:
    jlog(ctx, "pick_location", {
      loc_id: locId,
      loc_meaning: st.selectedLocation,
      loc_label: loc?.label || null,
    });

    // Всегда свежий список имён при входе на экран людей
    let names = (
      await fetchDataFromAirtable(ctx.from.username, airtableUrl)
    ).map((r) => r.name);
    names.sort((a, b) => a.localeCompare(b));

    st.buttonTexts = names;
    st.buttonIds = names.map((name, i) => ({ id: `p_${i}`, name }));
    st.buttonStates = Object.fromEntries(
      st.buttonIds.map(({ id }) => [id, false])
    );
    st.buttonCounters = {};
    st.currentPage = 0;

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Выбор/уменьшение человека (не из главного меню — но тоже полезно логировать)
  bot.callbackQuery(/^pick_(p_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const pid = ctx.match[1];

    if (st.selectedFormat === "ds") {
      st.buttonCounters[pid] = (st.buttonCounters[pid] || 0) + 1;
      jlog(ctx, "person_inc", {
        pid,
        name: st.buttonIds.find((x) => x.id === pid)?.name || "?",
      }); // LOG
    } else {
      st.buttonStates[pid] = !st.buttonStates[pid];
      jlog(ctx, st.buttonStates[pid] ? "person_check_on" : "person_check_off", {
        pid,
        name: st.buttonIds.find((x) => x.id === pid)?.name || "?",
      }); // LOG
    }

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^minus_(p_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const pid = ctx.match[1];

    if ((st.buttonCounters?.[pid] || 0) > 0) st.buttonCounters[pid] -= 1;
    jlog(ctx, "person_dec", {
      pid,
      name: st.buttonIds.find((x) => x.id === pid)?.name || "?",
    }); // LOG

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Пагинация (не главное меню, но полезно)
  bot.callbackQuery(/prev_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "page_prev", { from_page: Number(ctx.match[1]) }); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.currentPage = Math.max(0, parseInt(ctx.match[1], 10) - 1);
    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/next_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "page_next", { from_page: Number(ctx.match[1]) }); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.currentPage = parseInt(ctx.match[1], 10) + 1;
    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Готово — логируем финальное сообщение 1-в-1 с тем, что уходит в чат/Airtable
  bot.callbackQuery("done", async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const username = ctx.from.username || `${ctx.from.id}`;
    const date = st.selectedDate;
    const format = st.selectedFormat;
    const location = st.selectedLocation;

    let responseText = "";
    if (format === "ds") {
      const selectedCounts = Object.entries(st.buttonCounters)
        .filter(([, v]) => v > 0)
        .map(
          ([pid, v]) =>
            `${v}x ${st.buttonIds.find((x) => x.id === pid)?.name || "?"}`
        );
      responseText = `${username} / ${date} / ${format} // ${selectedCounts.join(
        ", "
      )}`;
    } else {
      const selectedNames = Object.entries(st.buttonStates)
        .filter(([, v]) => v)
        .map(([pid]) => st.buttonIds.find((x) => x.id === pid)?.name || "?");
      responseText = `${username} / ${date} / ${format} / ${location} / ${selectedNames.join(
        ", "
      )}`;
    }

    // LOG: финальный payload (точно то, что отправляем)
    jlog(ctx, "done_submit", {
      message: responseText,
      date,
      format,
      location: format === "ds" ? null : location,
    });

    try {
      await ctx.editMessageText(esc(responseText), { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error editing message:", err);
    }

    try {
      await bot.api.sendMessage(SECONDARY_CHAT, responseText.trim());
    } catch (err) {
      console.error("Error sending to secondary chat:", err);
    }

    messageQueue.push({ ctx, responseText, date, format, location });
    processQueue();

    resetUserState(id);
    await sendDateSelection(ctx);
  });

  // Кнопки главного меню: назад/обновить/PNL
  bot.callbackQuery("back_to_start", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_start"); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("back_to_dates", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_dates"); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("back_to_format", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_format"); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите формат:", {
      reply_markup: createFormatKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("back_to_location", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_location"); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    if (st.selectedFormat === "ds") {
      const currentSelection = buildSummary(st);
      await ctx.editMessageText(currentSelection + "\n\nВыберите формат:", {
        reply_markup: createFormatKeyboard(),
        parse_mode: "HTML",
      });
    } else {
      let locs = st.locations;
      if (!locs?.length) {
        const raw = await fetchDataFromAirtable(
          ctx.from.username,
          airtablePlacesUrl
        );
        locs = raw.map((r, i) => ({
          id: `loc_${i}`,
          label: r.place,
          meaning: r.meaning,
        }));
        st.locations = locs;
      }
      const currentSelection = buildSummary(st);
      await ctx.editMessageText(currentSelection + "\n\nВыберите локацию:", {
        reply_markup: createLocationKeyboard(locs),
        parse_mode: "HTML",
      });
    }
  });

  bot.callbackQuery("refresh_dates", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "refresh_dates"); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st._cache = null; // очистка кэша второстепенных данных
    st.selectedDate = "---";
    st.selectedFormat = "---";
    st.selectedLocation = "---";
    st.buttonStates = {};
    st.buttonCounters = {};

    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("view_pnl", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "view_pnl"); // LOG

    await ctx.editMessageText("Выберите дату, с которой начать просмотр:", {
      reply_markup: createPnlDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^pnl_date_(\d{2}\.\d{2})$/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pnl_pick_date", { date: ctx.match[1] }); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const date = ctx.match[1];
    const username = ctx.from.username;

    const cacheKey = `pnl_${date}`;
    let pnl = getCache(st, cacheKey);
    if (!pnl) {
      pnl = await fetchPnlDataFromAirtable(username, date);
      putCache(st, cacheKey, pnl, 2 * 60 * 1000); // TTL 2 минуты
    }
    st.pnlDataCache = pnl;

    const totalRevenue = pnl.reduce((acc, r) => {
      if (r.coach === username) return acc + (r.expense || 0);
      if (r.secondCoach === username) return acc + (r.secondExpense || 0);
      return acc;
    }, 0);

    const kb = new InlineKeyboard()
      .text(`Детальная разбивка (${totalRevenue} ₽)`, "detailed_breakdown")
      .row()
      .text("↩️ Вернуться в главное меню", "back_to_start")
      .row();

    await ctx.editMessageText(
      `Общий заработок с ${esc(date)}: ${totalRevenue} ₽`,
      {
        reply_markup: kb,
        parse_mode: "HTML",
      }
    );
  });

  bot.callbackQuery("detailed_breakdown", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pnl_detailed_breakdown"); // LOG

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const username = ctx.from.username;
    const pnl = st.pnlDataCache || [];

    const asCoach = pnl
      .filter((r) => r.coach === username)
      .map((r) => {
        const loc = r.format !== "ds" ? `, Локация: ${r.place}` : "";
        return `Дата: ${r.date}, Формат: ${r.format}${loc}, Сумма: ${r.expense} ₽`;
      })
      .join("\n");

    const asMentor = pnl
      .filter((r) => r.secondExpense > 0 && r.secondCoach === username)
      .map((r) => {
        const loc = r.format !== "ds" ? `, Локация: ${r.place}` : "";
        return `Дата: ${r.date}, Тренер: ${r.coach}, Формат: ${r.format}${loc}, Сумма: ${r.secondExpense} ₽`;
      })
      .join("\n");

    let text = `Ваши начисления как тренера:\n${asCoach || "Нет данных"}`;
    if (asMentor) text += `\n\nВаши начисления как ментора:\n${asMentor}`;

    const kb = new InlineKeyboard()
      .text("↩️ Вернуться в главное меню", "back_to_start")
      .row();

    await ctx.editMessageText(esc(text), {
      reply_markup: kb,
      parse_mode: "HTML",
    });
  });

  // Глобальный catch
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`, err);
    if (err instanceof GrammyError) {
      console.error("Error in request:", err.description);
    } else if (err instanceof HttpError) {
      console.error("Could not contact Telegram:", err);
    } else {
      console.error("Unknown error:", err);
    }
  });
};

(async () => {
  await initBot();

  const mode = (process.env.BOT_MODE || "polling").toLowerCase();

  if (mode === "polling") {
    // На всякий случай: отключаем вебхук и чистим висящие апдейты,
    // чтобы исключить 409 и конфликты режимов.
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.start();
    console.log("Bot started in POLLING mode");
  } else if (mode === "webhook") {
    const express = require("express");
    const { webhookCallback } = require("grammy");

    const app = express();
    app.use(express.json());

    const url = process.env.WEBHOOK_URL;
    if (!url) throw new Error("WEBHOOK_URL is required in WEBHOOK mode");

    await bot.api.setWebhook({ url });
    app.use("/webhook", webhookCallback(bot, "express"));

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log("Bot started in WEBHOOK mode on", port));
  } else {
    throw new Error(`Unknown BOT_MODE: ${mode}`);
  }
})();
