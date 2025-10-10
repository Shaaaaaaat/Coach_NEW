require("dotenv").config();
const { Bot, GrammyError, HttpError, InlineKeyboard } = require("grammy");
const { hydrate } = require("@grammyjs/hydrate");
const axios = require("axios");

// ----------------------- БАЗОВАЯ НАСТРОЙКА -----------------------
const bot = new Bot(process.env.BOT_API_KEY);
bot.use(hydrate());

const AIRTABLE_API = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE_ID;
const AIRTABLE_PLACES = process.env.AIRTABLE_PLACES_TABLE_ID;
const AIRTABLE_SMS = process.env.AIRTABLE_SMS_ID;
const AIRTABLE_PNL = process.env.AIRTABLE_PNL_ID;

// CHANGED: чат вынесен в .env (было захардкожено)
const SECONDARY_CHAT = Number(process.env.SECONDARY_CHAT_ID || -1002203093713);

const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
const airtablePlacesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_PLACES}`;
const airtableMessagesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SMS}`;
const airtablePnlUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_PNL}`;

// CHANGED: авторизация по id предпочтительнее username
const allowedIds = []; // NEW: заполни вашими числовыми user_id, например [123, 456]
const allowedUsers = [
  "Lokatororator",
  "Shaaaaaaat",
  "kapitanstar_coach",
  "Gshakhnazarov",
  "dima_dubinin",
  "e_katrin_al",
];

const BUTTONS_PER_PAGE = 7;

// ----------------------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ -----------------------

// NEW: безопасное экранирование под HTML (мы ушли с Markdown на HTML)
const esc = (s = "") =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// NEW: мгновенный ответ на клик (лечит "query is too old")
// вызываем ПЕРВОЙ строкой в каждом callback-хэндлере
const safeAnswerCb = async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
  } catch (e) {
    // NOTE: "query is too old" (400) — это нормальная ситуация, если пользователь успел нажать раньше/позже
    if (!(e instanceof GrammyError && e.error_code === 400)) {
      console.error("answerCallbackQuery error:", e);
    }
  }
};

// NEW: корректный парсер дат dd.mm и dd.mm.yyyy с логикой года
// (старая compareDates подставляла 2000 и ломалась на Новом Годе)
const parseDMY = (s = "") => {
  const parts = s.split(".");
  if (parts.length === 3) return new Date(+parts[2], +parts[1] - 1, +parts[0]); // dd.mm.yyyy
  const [d, m] = parts.map(Number);
  const now = new Date();
  let y = now.getFullYear();
  const candidate = new Date(y, m - 1, d);
  if (candidate > now) y -= 1; // не допускаем будущие даты
  return new Date(y, m - 1, d);
};
const compareDates = (date1, date2) => parseDMY(date1) >= parseDMY(date2);

// NEW: простой кэш на пользователя (уменьшает задержки и таймауты)
const putCache = (bag, key, val, ttlMs = 5 * 60 * 1000) => {
  bag._cache ??= {};
  bag._cache[key] = { val, exp: Date.now() + ttlMs };
  return val;
};
const getCache = (bag, key) => {
  const rec = bag._cache?.[key];
  return rec && rec.exp > Date.now() ? rec.val : null;
};

// ----------------------- СОСТОЯНИЕ ПОЛЬЗОВАТЕЛЕЙ -----------------------
const userStates = {}; // userId -> state

// NEW: единообразное состояние
const freshState = () => ({
  buttonTexts: [], // список имён (для отображения)
  buttonIds: [], // [{id:'p_0', name:'Иванов Иван'}]
  buttonStates: {}, // {'p_0': true/false} — для group/personal
  buttonCounters: {}, // {'p_0': 0..n}       — для ds
  currentPage: 0,
  selectedDate: "---",
  selectedFormat: "---", // 'ds' | 'group' | 'personal'
  selectedLocation: "---", // значение meaning (нормализованная локация)
  locations: [], // [{id:'loc_0', label:'...', meaning:'...'}]
  pnlDataCache: [],
  _cache: null, // внутренний кэш (имена, локации, pnl)
});
const ensureState = (uid) => (userStates[uid] ??= freshState());
const resetUserState = (uid) => {
  userStates[uid] = freshState();
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

  // CHANGED: логика прежняя, просто компактнее
  const filteredRecords = records
    .filter(
      (record) => record.fields.Coach && record.fields.Coach.includes(username)
    )
    .map((record) => ({
      name: record.fields.FIO3,
      place: record.fields.Places,
      meaning: record.fields.Meanings,
    }));

  return filteredRecords;
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
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
};

const fetchPnlDataFromAirtable = async (username, startDateDM) => {
  let records = [];
  let offset = null;

  // NOTE: как и было — фильтрация по Coach/Second_coach
  const filterFormula = `OR({Coach} = '${username}', {Second_coach} = '${username}')`;
  do {
    const response = await axios.get(airtablePnlUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API}` },
      params: { offset, pageSize: 100, filterByFormula: filterFormula },
    });
    records = records.concat(response.data.records);
    offset = response.data.offset;
  } while (offset);

  // CHANGED: фильтруем/сортируем по нормальным датам (parseDMY)
  const filtered = records
    .map((r) => ({
      date: r.fields.Data, // 'dd.mm' или 'dd.mm.yyyy'
      coach: r.fields.Coach,
      secondCoach: r.fields.Second_coach,
      format: r.fields.Format,
      place: r.fields.Place,
      expense: r.fields.Expenses_coach || 0,
      secondExpense: r.fields.Expenses_second_coach || 0,
    }))
    .filter((rec) => compareDates(rec.date, startDateDM))
    .sort((a, b) => parseDMY(a.date) - parseDMY(b.date));

  return filtered;
};

// ----------------------- UI: КНОПКИ -----------------------

// CHANGED: верстка на HTML вместо Markdown
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
    // NEW: в callback_data кладём КОРОТКИЙ ID (а не весь текст)
    kb.text(label, `location_${loc.id}`).row();
  }
  kb.text("⬅️ Вернуться", "back_to_format").row();
  return kb;
};

// NEW: универсальный генератор клавиатуры людей с пагинацией и резюме
// — используется и для ds (счётчики), и для group/personal (галочки)
const createPeopleKeyboard = (userId, format) => {
  const st = ensureState(userId);
  const kb = new InlineKeyboard();

  const total = st.buttonIds.length;
  if (!total) {
    return { keyboard: kb, currentSelection: "Нет данных" };
  }

  const page = st.currentPage || 0;
  const start = page * BUTTONS_PER_PAGE;
  const end = Math.min(start + BUTTONS_PER_PAGE, total);
  const slice = st.buttonIds.slice(start, end);

  // CHANGED: кнопки навигации страницы
  if (page > 0 && end < total)
    kb.text("⬅️ Назад", `prev_${page}`)
      .text("Еще люди ➡️", `next_${page}`)
      .row();
  else if (page > 0) kb.text("⬅️ Назад", `prev_${page}`).row();
  else if (end < total) kb.text("Еще люди ➡️", `next_${page}`).row();

  // CHANGED: в callback_data — короткий ID (p_0, p_1, ...)
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

  // NEW: красивое резюме выбора
  let currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
    st.selectedDate || "---"
  )}\n🤸 Тип тренировки: ${esc(st.selectedFormat || "---")}`;
  if (st.selectedFormat !== "ds")
    currentSelection += `\n📍 Место: ${esc(st.selectedLocation || "---")}`;

  if (st.selectedFormat === "ds") {
    const picked = Object.entries(st.buttonCounters)
      .filter(([, v]) => v > 0)
      .map(
        ([id, v]) =>
          `${v}x ${st.buttonIds.find((x) => x.id === id)?.name || "?"}`
      );
    currentSelection += `\n👥 Люди: ${esc(picked.join(", ") || "---")}`;
  } else {
    const picked = Object.entries(st.buttonStates)
      .filter(([, v]) => !!v)
      .map(([id]) => st.buttonIds.find((x) => x.id === id)?.name || "?");
    currentSelection += `\n👥 Люди: ${esc(picked.join(", ") || "---")}`;
  }

  return { keyboard: kb, currentSelection };
};

// ----------------------- PNL ДАТЫ -----------------------
const getLastEightMondays = () => {
  const dates = [];
  const now = new Date();
  const day = now.getDay(); // 0 вс, 1 пн
  const diff = day === 1 ? 0 : day === 0 ? 6 : day - 1; // сколько дней назад был понедельник
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

// CHANGED: очередь обёрнута try/finally, чтобы флаг не залипал
const processMessage = async (message) => {
  const { ctx, responseText, date, format, location } = message;
  const userId = ctx.from.id;
  const st = ensureState(userId);

  if (format === "ds") {
    const countsArr = Object.values(st.buttonCounters || {});
    const maxCount = countsArr.length ? Math.max(...countsArr) : 0; // NEW: защита от -Infinity
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

// ----------------------- ЗАПУСК БОТА -----------------------
const initBot = async () => {
  bot.command("start", async (ctx) => {
    const { id, username } = ctx.from;

    // CHANGED: проверяем id И/ИЛИ username (на ваш выбор)
    if (!(allowedIds.includes(id) || allowedUsers.includes(username))) {
      await ctx.reply("Отказ в доступе к боту");
      return;
    }

    ensureState(id);
    const st = userStates[id];

    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;

    // CHANGED: HTML вместо Markdown
    await ctx.reply(currentSelection + "<br><br>Выберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  const sendDateSelection = async (ctx) => {
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;
    await ctx.reply(currentSelection + "<br><br>Выберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  };

  // ----------------------- HANDLERS -----------------------

  // CHANGED: в каждом callback-хэндлере — первой строкой safeAnswerCb(ctx)

  // Выбор даты dd.mm
  bot.callbackQuery(/^\d{2}\.\d{2}$/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const date = ctx.match[0];
    st.selectedDate = date;

    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;

    await ctx.editMessageText(currentSelection + "<br><br>Выберите формат:", {
      reply_markup: createFormatKeyboard(),
      parse_mode: "HTML",
    });
  });

  // Выбор формата
  bot.callbackQuery(/^(ds|group|personal)$/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const format = ctx.match[0];
    st.selectedFormat = format;

    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;

    if (format === "ds") {
      // NEW: кэш имён
      let names = getCache(st, "names");
      if (!names) {
        names = (
          await fetchDataFromAirtable(ctx.from.username, airtableUrl)
        ).map((r) => r.name);
        names.sort((a, b) => a.localeCompare(b));
        putCache(st, "names", names);
      }

      // NEW: короткие ID вместо текста в callback_data
      st.buttonTexts = names;
      st.buttonIds = names.map((name, i) => ({ id: `p_${i}`, name }));
      st.buttonStates = {}; // не используется в ds
      st.buttonCounters = Object.fromEntries(
        st.buttonIds.map(({ id }) => [id, 0])
      );
      st.currentPage = 0;

      const { keyboard, currentSelection: sel } = createPeopleKeyboard(
        id,
        format
      );
      await ctx.editMessageText(sel + "<br><br>Выберите людей:", {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } else {
      // NEW: кэш локаций
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

      await ctx.editMessageText(
        currentSelection + "<br><br>Выберите локацию:",
        {
          reply_markup: createLocationKeyboard(locs),
          parse_mode: "HTML",
        }
      );
    }
  });

  // Выбор локации
  bot.callbackQuery(/^location_(loc_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const locId = ctx.match[1];
    const loc = (st.locations || []).find((l) => l.id === locId);
    st.selectedLocation = loc?.meaning || "---";

    // имена (кэш)
    let names = getCache(st, "names");
    if (!names) {
      names = (await fetchDataFromAirtable(ctx.from.username, airtableUrl)).map(
        (r) => r.name
      );
      names.sort((a, b) => a.localeCompare(b));
      putCache(st, "names", names);
    }

    st.buttonTexts = names;
    st.buttonIds = names.map((name, i) => ({ id: `p_${i}`, name }));
    st.buttonStates = Object.fromEntries(
      st.buttonIds.map(({ id }) => [id, false])
    );
    st.buttonCounters = {}; // не используется здесь
    st.currentPage = 0;

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "<br><br>Выберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Клик по человеку (увеличить счётчик в ds или переключить галочку)
  bot.callbackQuery(/^pick_(p_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const pid = ctx.match[1];

    if (st.selectedFormat === "ds") {
      st.buttonCounters[pid] = (st.buttonCounters[pid] || 0) + 1;
    } else {
      st.buttonStates[pid] = !st.buttonStates[pid];
    }

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "<br><br>Выберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Уменьшение счётчика (ds)
  bot.callbackQuery(/^minus_(p_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const pid = ctx.match[1];

    if ((st.buttonCounters?.[pid] || 0) > 0) st.buttonCounters[pid] -= 1;

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "<br><br>Выберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Навигация по страницам
  bot.callbackQuery(/prev_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.currentPage = Math.max(0, parseInt(ctx.match[1], 10) - 1);
    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "<br><br>Выберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/next_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.currentPage = parseInt(ctx.match[1], 10) + 1;
    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "<br><br>Выберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Готово
  bot.callbackQuery("done", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const username = ctx.from.username || `${ctx.from.id}`;
    const date = st.selectedDate;
    const format = st.selectedFormat;
    const location = st.selectedLocation;

    // CHANGED: формируем сообщение из ID → имена
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

    // Покажем пользователю (экранируем для HTML)
    try {
      await ctx.editMessageText(esc(responseText), { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error editing message:", err);
    }

    // И отправим в сторонний чат
    try {
      await bot.api.sendMessage(SECONDARY_CHAT, responseText.trim());
    } catch (err) {
      console.error("Error sending message to secondary chat:", err);
    }

    // В очередь на Airtable
    messageQueue.push({ ctx, responseText, date, format, location });
    processQueue();

    // Сброс состояния и возврат в начало
    resetUserState(id);
    await sendDateSelection(ctx);
  });

  // Навигация назад
  bot.callbackQuery("back_to_start", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;
    try {
      await ctx.editMessageText(currentSelection + "<br><br>Выберите дату:", {
        reply_markup: createDateKeyboard(),
        parse_mode: "HTML",
      });
    } catch (err) {
      console.error("Error editing message:", err);
    }
  });

  bot.callbackQuery("back_to_dates", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;
    try {
      await ctx.editMessageText(currentSelection + "<br><br>Выберите дату:", {
        reply_markup: createDateKeyboard(),
        parse_mode: "HTML",
      });
    } catch (err) {
      console.error("Error editing message:", err);
    }
  });

  bot.callbackQuery("back_to_format", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;
    try {
      await ctx.editMessageText(currentSelection + "<br><br>Выберите формат:", {
        reply_markup: createFormatKeyboard(),
        parse_mode: "HTML",
      });
    } catch (err) {
      console.error("Error editing message:", err);
    }
  });

  bot.callbackQuery("back_to_location", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    if (st.selectedFormat === "ds") {
      const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
        st.selectedDate
      )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
        st.selectedLocation
      )}\n👥 Люди: ---`;
      await ctx.editMessageText(currentSelection + "<br><br>Выберите формат:", {
        reply_markup: createFormatKeyboard(),
        parse_mode: "HTML",
      });
    } else {
      // показать список локаций заново (берём из кэша или заново)
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
      const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
        st.selectedDate
      )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
        st.selectedLocation
      )}\n👥 Люди: ---`;
      await ctx.editMessageText(
        currentSelection + "<br><br>Выберите локацию:",
        {
          reply_markup: createLocationKeyboard(locs),
          parse_mode: "HTML",
        }
      );
    }
  });

  // Обновить даты (сброс выбора)
  bot.callbackQuery("refresh_dates", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.selectedDate = "---";
    st.selectedFormat = "---";
    st.selectedLocation = "---";

    const currentSelection = `<b>Введенные данные:</b>\n📅 Дата: ${esc(
      st.selectedDate
    )}\n🤸 Тип тренировки: ${esc(st.selectedFormat)}\n📍 Место: ${esc(
      st.selectedLocation
    )}\n👥 Люди: ---`;
    try {
      await ctx.editMessageText(currentSelection + "<br><br>Выберите дату:", {
        reply_markup: createDateKeyboard(),
        parse_mode: "HTML",
      });
    } catch (err) {
      console.error("Error editing message:", err);
    }
  });

  // Просмотр PNL
  bot.callbackQuery("view_pnl", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    try {
      await ctx.editMessageText("Выберите дату, с которой начать просмотр:", {
        reply_markup: createPnlDateKeyboard(),
        parse_mode: "HTML",
      });
    } catch (err) {
      console.error("Error editing message:", err);
    }
  });

  bot.callbackQuery(/^pnl_date_(\d{2}\.\d{2})$/, async (ctx) => {
    await safeAnswerCb(ctx); // NEW
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const date = ctx.match[1];
    const username = ctx.from.username;

    const cacheKey = `pnl_${date}`;
    let pnl = getCache(st, cacheKey);
    if (!pnl) {
      pnl = await fetchPnlDataFromAirtable(username, date);
      putCache(st, cacheKey, pnl, 2 * 60 * 1000); // NEW: TTL 2 мин на PnL
    }
    st.pnlDataCache = pnl;

    // CHANGED: суммируем и тренерские, и менторские начисления
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

    try {
      await ctx.editMessageText(
        `Общий заработок с ${esc(date)}: ${totalRevenue} ₽`,
        {
          reply_markup: kb,
          parse_mode: "HTML",
        }
      );
    } catch (err) {
      console.error("Error editing message:", err);
    }
  });

  bot.callbackQuery("detailed_breakdown", async (ctx) => {
    await safeAnswerCb(ctx); // NEW
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

    try {
      await ctx.editMessageText(esc(text), {
        reply_markup: kb,
        parse_mode: "HTML",
      });
    } catch (err) {
      console.error("Error editing message:", err);
    }
  });

  // ----------------------- ГЛОБАЛЬНЫЙ CATCH -----------------------
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

  bot.start();
};

initBot();
