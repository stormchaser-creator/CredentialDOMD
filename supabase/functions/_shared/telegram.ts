/**
 * Telegram operator alerts. No-op if TELEGRAM_BOT_TOKEN isn't configured,
 * so functions can call this defensively without try/catch noise.
 *
 * Set in Supabase Edge Function secrets:
 *   TELEGRAM_BOT_TOKEN     — from @BotFather (123456:ABCdef...)
 *   TELEGRAM_OPERATOR_ID   — your personal chat ID (per CLAUDE.md: 5275581824)
 */
export async function notifyOperator(message: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_OPERATOR_ID");

  if (!token || !chatId) {
    // Silent no-op — credentials not configured yet.
    console.log(`[telegram-skip] ${message.slice(0, 100)}`);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[telegram-fail] ${res.status}: ${err.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`[telegram-error] ${(e as Error).message}`);
  }
}
