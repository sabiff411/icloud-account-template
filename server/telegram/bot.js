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
} from "./views.js";

/* Telegram bot template built on grammY.
 *
 * Shows the three patterns a control bot needs:
 *   - inline keyboards and callback queries
 *   - paginated lists with Prev / Next
 *   - editing the current message in place (store-like navigation)
 *
 * It shares the same Store instance as Socket.IO, so a change made here is
 * pushed to every admin socket, and a submission from the site shows up here.
 */

export function startBot({ store }) {
  if (!config.telegram.enabled) {
    console.log("[telegram] disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_ENABLED)");
    return null;
  }

  const bot = new Bot(config.telegram.token);

  // Optional allow-list of Telegram user ids.
  if (config.telegram.allowedUsers.length > 0) {
    bot.use(async (ctx, next) => {
      const id = String(ctx.from?.id ?? "");
      if (!config.telegram.allowedUsers.includes(id)) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery("Not allowed");
        return;
      }
      await next();
    });
  }

  async function show(ctx, view) {
    const options = {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
      link_preview_options: { is_disabled: true },
    };
    try {
      await ctx.editMessageText(view.text, options);
    } catch {
      await ctx.reply(view.text, options);
    }
  }

  bot.command("start", (ctx) => {
    const view = menuView();
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  bot.command("list", (ctx) => {
    const view = listView(store.page({ page: 1, pageSize: PAGE_SIZE }));
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  bot.command("stats", (ctx) => {
    const view = statsView(store.stats());
    return ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  });

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, menuView());
  });

  bot.callbackQuery("stats", async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, statsView(store.stats()));
  });

  bot.callbackQuery(/^list:(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    const data = store.page({ page, pageSize: PAGE_SIZE });
    await ctx.answerCallbackQuery();
    await show(ctx, listView(data));
  });

  bot.callbackQuery(/^item:(.+)$/, async (ctx) => {
    const item = store.get(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery();
    await show(ctx, itemView(item));
  });

  bot.callbackQuery(/^set:([^:]+):(new|reviewed|done)$/, async (ctx) => {
    const [, id, status] = ctx.match;
    const item = store.update(id, { status });
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery(`Marked ${status}`);
    await show(ctx, itemView(item));
  });

  bot.callbackQuery(/^delask:(.+)$/, async (ctx) => {
    const item = store.get(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery();
    await show(ctx, confirmDeleteView(item));
  });

  bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
    const item = store.remove(ctx.match[1]);
    if (!item) return ctx.answerCallbackQuery("No longer exists");
    await ctx.answerCallbackQuery("Deleted");
    await show(ctx, listView(store.page({ page: 1, pageSize: PAGE_SIZE })));
  });

  bot.callbackQuery("close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  bot.catch((error) => {
    console.error("[telegram]", error.error ?? error);
  });

  // New submission -> notify the configured chat.
  if (config.telegram.chatId) {
    store.on("add", (item) => {
      const text = [
        "📥 <b>New submission</b>",
        `${escapeHtml(item.email || "(no email)")}`,
        `Code: <code>${escapeHtml(item.code || "—")}</code>`,
        `Country: ${escapeHtml(item.country || "—")}`,
      ].join("\n");
      bot.api
        .sendMessage(config.telegram.chatId, text, { parse_mode: "HTML" })
        .catch((error) => console.error("[telegram] notify", error.message));
    });
  }

  bot
    .start({
      onStart: (info) => console.log(`[telegram] @${info.username} polling`),
    })
    .catch((error) => console.error("[telegram] start", error));

  return bot;
}
