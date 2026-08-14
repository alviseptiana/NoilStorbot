require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

const app = express();
app.use(express.json());

const token = process.env.BOT_TOKEN;
// Menggunakan mode Webhook murni (tanpa polling)
const bot = new TelegramBot(token);

const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME ? (process.env.CHANNEL_USERNAME.startsWith('@') ? process.env.CHANNEL_USERNAME : `@${process.env.CHANNEL_USERNAME}`) : '';

let clientEmail = '';
let privateKey = '';

try {
  let creds;
  if (process.env.GOOGLE_CREDENTIALS) {
    creds = typeof process.env.GOOGLE_CREDENTIALS === 'string' 
      ? JSON.parse(process.env.GOOGLE_CREDENTIALS) 
      : process.env.GOOGLE_CREDENTIALS;
  } else if (fs.existsSync('./credentials.json')) {
    creds = JSON.parse(fs.readFileSync('./credentials.json'));
  }
  
  if (creds) {
    clientEmail = creds.client_email;
    privateKey = creds.private_key ? creds.private_key.replace(/\\n/g, '\n') : '';
  }
} catch (e) {
  console.error("Credentials error:", e.message);
}

const serviceAccountAuth = new JWT({
  email: clientEmail,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

async function getSheets() {
  await doc.loadInfo();
  return {
    usersSheet: doc.sheetsByTitle['Users'],
    taskSheet: doc.sheetsByTitle['Task_History'],
    wdSheet: doc.sheetsByTitle['Withdrawal_History'],
    settingsSheet: doc.sheetsByTitle['Settings'],
  };
}

async function getSettings() {
  const { settingsSheet } = await getSheets();
  const rows = await settingsSheet.getRows();
  if (rows.length === 0) {
    return {
      reward_per_task: 1000,
      min_wd: 10000,
      task_title: 'Tugas Harian',
      task_desc: 'Selesaikan tugas...',
      info_text: 'Informasi Bot',
      proof_keyword: '@tahun.baru',
    };
  }
  return {
    reward_per_task: parseInt(rows[0].get('reward_per_task')) || 0,
    min_wd: parseInt(rows[0].get('min_wd')) || 0,
    task_title: rows[0].get('task_title') || '',
    task_desc: rows[0].get('task_desc') || '',
    info_text: rows[0].get('info_text') || '',
    proof_keyword: rows[0].get('proof_keyword') || '',
  };
}

async function checkChannelMembership(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (error) {
    return false;
  }
}

async function isUserBanned(userId) {
  try {
    const { usersSheet } = await getSheets();
    const rows = await usersSheet.getRows();
    const user = rows.find(r => r.get('user_id') == userId.toString());
    return user ? user.get('status') === 'banned' : false;
  } catch (err) {
    return false;
  }
}

async function calculateUserBalance(userId) {
  const { taskSheet, wdSheet } = await getSheets();
  const settings = await getSettings();

  const taskRows = await taskSheet.getRows();
  const approvedTasks = taskRows.filter(r => r.get('user_id') == userId.toString() && r.get('status') === 'Approve').length;
  const totalEarned = approvedTasks * settings.reward_per_task;

  const wdRows = await wdSheet.getRows();
  const totalWithdrawn = wdRows
    .filter(r => r.get('user_id') == userId.toString() && ['Pending', 'Sukses'].includes(r.get('status')))
    .reduce((sum, r) => sum + (parseInt(r.get('amount')) || 0), 0);

  return totalEarned - totalWithdrawn;
}

const userState = {};

const getMainMenu = (userId) => {
  const keyboard = [
    [{ text: '👤 Profil', callback_data: 'menu_profil' }, { text: '📋 Task', callback_data: 'menu_task' }],
    [{ text: '📜 History & Status', callback_data: 'menu_history' }, { text: '💰 Saldo', callback_data: 'menu_saldo' }],
    [{ text: '🏧 Riwayat Penarikan', callback_data: 'menu_wd_history' }],
    [{ text: 'ℹ️ Info', callback_data: 'menu_info' }, { text: '❓ Help', callback_data: 'menu_help' }]
  ];
  if (userId === ADMIN_ID) {
    keyboard.push([{ text: '👑 Panel Admin', callback_data: 'admin_panel' }]);
  }
  return { reply_markup: { inline_keyboard: keyboard } };
};

const getBackButton = () => ({
  reply_markup: {
    inline_keyboard: [[{ text: '🔙 Kembali ke Menu Utama', callback_data: 'menu_main' }]]
  }
});

async function handleUpdate(update) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || '';

    if (await isUserBanned(userId)) return;

    if (text === '/start') {
      const isMember = await checkChannelMembership(userId);
      if (!isMember) {
        const channelUrl = `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`;
        return bot.sendMessage(chatId, 'Jika ingin menggunakan bot ini harap mengikuti channel ini terlebih dahulu.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📢 Join Channel', url: channelUrl }],
              [{ text: '✅ Selesai', callback_data: 'verify_join' }]
            ]
          }
        });
      }

      const { usersSheet } = await getSheets();
      const rows = await usersSheet.getRows();
      let user = rows.find(r => r.get('user_id') == userId.toString());
      if (!user) {
        await usersSheet.addRow({
          user_id: userId.toString(),
          username: msg.from.username || msg.from.first_name,
          join_date: new Date().toLocaleString('id-ID'),
          status: 'active'
        });
      }

      return bot.sendMessage(chatId, `🎉 Selamat datang! Silahkan pilih menu di bawah ini:`, getMainMenu(userId));
    }

    if (userState[userId] && userState[userId].step === 'AWAIT_REK_NUMBER') {
      if (!text.startsWith('08')) {
        return bot.sendMessage(chatId, '❌ Nomor rekening harus berawalan "08". Silahkan coba lagi:');
      }
      userState[userId].account_number = text;
      userState[userId].step = 'CONFIRM_WD';
      return bot.sendMessage(chatId, `📌 **Konfirmasi Penarikan**\n\nMetode: ${userState[userId].method}\nNo Rekening: ${text}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Konfirmasi Penarikan', callback_data: 'wd_confirm' }],
            [{ text: '❌ Batalkan Penarikan', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    const settings = await getSettings();
    const keyword = settings.proof_keyword.toLowerCase();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const matchedLines = lines.filter(line => line.toLowerCase().includes(keyword));

    if (matchedLines.length > 0) {
      const { taskSheet } = await getSheets();
      const currentDate = new Date().toLocaleString('id-ID');
      for (const proof of matchedLines) {
        await taskSheet.addRow({
          task_id: 'TSK-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          user_id: userId.toString(),
          username: msg.from.username || msg.from.first_name,
          proof_text: proof,
          date: currentDate,
          status: 'Pending'
        });
      }
      return bot.sendMessage(chatId, `✅ **${matchedLines.length} Bukti Tugas Terkirim!** Status: *Pending*`, { parse_mode: 'Markdown', ...getBackButton() });
    }
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (await isUserBanned(userId)) return;
    await bot.answerCallbackQuery(query.id);

    if (data === 'menu_main') {
      delete userState[userId];
      return bot.sendMessage(chatId, '📋 Menu Utama:', getMainMenu(userId));
    }

    if (data === 'menu_profil') {
      const text = `👤 **Profil Pengguna**\n\n🆔 ID: \`${userId}\`\n👤 Nama: ${query.from.first_name}\n🏷 Username: @${query.from.username || '-'}`;
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...getBackButton() });
    }

    if (data === 'menu_task') {
      const settings = await getSettings();
      const text = `📌 **${settings.task_title}**\n\n${settings.task_desc}\n\n💵 Reward: Rp ${settings.reward_per_task}\n🔑 Inisial Bukti: \`${settings.proof_keyword}\`\n\n👇 *Kirimkan pesan bukti tugas langsung di chat ini.*`;
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...getBackButton() });
    }

    if (data === 'menu_saldo') {
      const balance = await calculateUserBalance(userId);
      const settings = await getSettings();
      return bot.sendMessage(chatId, `💰 **Informasi Saldo**\n\nSaldo Aktif: Rp ${balance.toLocaleString('id-ID')}\nMinimum Penarikan: Rp ${settings.min_wd.toLocaleString('id-ID')}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏧 Tarik Saldo', callback_data: 'wd_start' }],
            [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    if (data === 'wd_start') {
      const balance = await calculateUserBalance(userId);
      const settings = await getSettings();
      if (balance < settings.min_wd) {
        return bot.sendMessage(chatId, '❌ Saldo tidak mencukupi.', getBackButton());
      }
      return bot.sendMessage(chatId, '💳 Pilih e-wallet:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'DANA', callback_data: 'wd_method_DANA' }, { text: 'OVO', callback_data: 'wd_method_OVO' }],
            [{ text: 'GoPay', callback_data: 'wd_method_GoPay' }],
            [{ text: '❌ Batal', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    if (data.startsWith('wd_method_')) {
      const method = data.split('_')[2];
      userState[userId] = { step: 'AWAIT_REK_NUMBER', method };
      return bot.sendMessage(chatId, `Kirim nomor rekening ${method} kamu (berawalan 08...):`);
    }

    if (data === 'wd_confirm') {
      const state = userState[userId];
      if (!state || !state.account_number) return bot.sendMessage(chatId, 'Sesi kadaluarsa.', getBackButton());
      const balance = await calculateUserBalance(userId);
      const { wdSheet } = await getSheets();
      await wdSheet.addRow({
        wd_id: 'WD-' + Date.now(),
        user_id: userId.toString(),
        method: state.method,
        account_number: state.account_number,
        amount: balance,
        date: new Date().toLocaleString('id-ID'),
        status: 'Pending'
      });
      delete userState[userId];
      return bot.sendMessage(chatId, '⏳ Penarikan sedang diproses oleh admin.', getBackButton());
    }
  }
}

// Endpoint Vercel Serverless Hook
app.post('*', async (req, res) => {
  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Vercel Webhook Error:", err);
  }
  res.status(200).send('OK');
});

app.get('*', (req, res) => {
  res.send('Serverless Vercel Active!');
});

module.exports = app;
