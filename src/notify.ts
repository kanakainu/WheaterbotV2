// src/notify.ts - Telegram Notifications
import https from 'https';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export async function sendTelegram(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    return;
  }
  
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  });
  
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      resolve();
    });
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

export async function notifyTrade(action: 'buy' | 'sell' | 'stop_loss' | 'take_profit', details: {
  question: string;
  price: number;
  size?: number;
  pnl?: number;
  balance?: number;
}): Promise<void> {
  const emoji = action === 'buy' ? '🟢' : action === 'sell' ? '🔴' : action === 'stop_loss' ? '🛑' : '🎯';
  const message = `
${emoji} *Bot Alert: ${action.toUpperCase()}*

Market: ${details.question.slice(0, 60)}...
Price: $${details.price.toFixed(4)}
${details.size ? `Size: $${details.size.toFixed(2)}` : ''}
${details.pnl ? `PnL: ${details.pnl >= 0 ? '+' : ''}$${details.pnl.toFixed(2)}` : ''}
${details.balance ? `Balance: $${details.balance.toFixed(2)}` : ''}
`;
  await sendTelegram(message);
}

export async function notifyError(error: string): Promise<void> {
  await sendTelegram(`❌ *ERROR*: ${error.slice(0, 200)}`);
}

export async function notifyStart(mode: string, balance: number): Promise<void> {
  await sendTelegram(`🚀 *Bot Started* - Mode: ${mode}\nBalance: $${balance.toFixed(2)}`);
}
