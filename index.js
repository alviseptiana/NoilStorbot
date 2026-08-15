require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');

const app = express();
app.use(express.json());

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token);

const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME ? (process.env.CHANNEL_USERNAME.startsWith('@') ? process.env.CHANNEL_USERNAME : `@${process.env.CHANNEL_USERNAME}`) : '';

function getCredentials() {
  let clientEmail = process.env.GOOGLE_CLIENT_EMAIL || '';
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || '';

  if (!clientEmail || !privateKey) {
    if (process.env.GOOGLE_CREDENTIALS) {
      try {
        let credsStr = process.env.GOOGLE_CREDENTIALS.trim();
        let creds = typeof credsStr === 'string' ? JSON.parse(credsStr) : credsStr;
        clientEmail = creds.client_email || clientEmail;
        privateKey = creds.private_key || privateKey;
      } catch (e) {
        console.error("Failed to parse GOOGLE_CREDENTIALS JSON:", e.message);
      }
    } else if (fs.existsSync('./credentials.json')) {
      try {
        let creds = JSON.parse(fs.readFileSync('./credentials.json'));
        clientEmail = creds.client_email || clientEmail;
        privateKey = creds.private_key || privateKey;
      } catch (e) {
        console.error("Failed to read credentials.json:", e.message);
      }
    }
  }

  if (privateKey) {
    privateKey = privateKey.trim();
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  return { clientEmail, privateKey };
}

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);

async function initDoc() {
  const { clientEmail, privateKey } = getCredentials();
  
  if (!clientEmail || !privateKey) {
    throw new Error(`Credentials Missing! Email: ${clientEmail ? 'OK' : 'MISSING'}, Key: ${privateKey ? 'OK' : 'MISSING'}`);
  }

  await doc.useServiceAccountAuth({
    client_email: clientEmail,
    private_key: privateKey,
  });
  await doc.loadInfo();
}

async function getSheets() {
  await initDoc();
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
    reward_per_task: parseInt(rows[0].reward_per_task) || 0,
    min_wd: parseInt(rows[0].min_wd) || 0,
    task_title: rows[0].task_title || '',
    task_desc: rows[0].task_desc || '',
    info_text: rows[0].info_text || '',
    proof_keyword: rows[0].proof_keyword || '',
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
    const user = rows.find(r => r.user_id == userId.toString());
    return user ? user.status === 'banned' : false;
  } catch (err) {
    return false;
  }
}

async function calculateUserBalance(userId) {
  const { taskSheet, wdSheet } = await getSheets();
  const settings = await getSettings();

  const taskRows = await taskSheet.getRows();
  const approvedTasks = taskRows.filter(r => r.user_id == userId.toString() && r.status === 'Approve').length;
  const totalEarned = approvedTasks * settings.reward_per_task;

  const wdRows = await wdSheet.getRows();
  const totalWithdrawn = wdRows
    .filter(r => r.user_id == userId.toString() && ['Pending', 'Sukses'].includes(r.status))
    .reduce((sum, r) => sum + (parseInt(r.amount) || 0), 0);

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
        return await bot.sendMessage(chatId, 'Jika ingin menggunakan bot ini harap mengikuti channel ini terlebih dahulu.', {
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
      let user = rows.find(r => r.user_id == userId.toString());
      if (!user) {
        await usersSheet.addRow({
          user_id: userId.toString(),
          username: msg.from.username || msg.from.first_name,
          join_date: new Date().toLocaleString('id-ID'),
          status: 'active'
        });
      }

      return await bot.sendMessage(chatId, `🎉 Selamat datang! Silahkan pilih menu di bawah ini:`, getMainMenu(userId));
    }

    if (userState[userId] && userState[userId].step === 'AWAIT_REK_NUMBER') {
      if (!text.startsWith('08')) {
        return await bot.sendMessage(chatId, '❌ Nomor rekening harus berawalan "08". Silahkan coba lagi:');
      }
      userState[userId].account_number = text;
      userState[userId].step = 'CONFIRM_WD';
      return await bot.sendMessage(chatId, `📌 **Konfirmasi Penarikan**\n\nMetode: ${userState[userId].method}\nNo Rekening: ${text}`, {
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
      return await bot.sendMessage(chatId, `✅ **${matchedLines.length} Bukti Tugas Terkirim!** Status: *Pending*`, { parse_mode: 'Markdown', ...getBackButton() });
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
      return await bot.sendMessage(chatId, '📋 Menu Utama:', getMainMenu(userId));
    }

    if (data === 'menu_profil') {
      const text = `👤 **Profil Pengguna**\n\n🆔 ID: \`${userId}\`\n👤 Nama: ${query.from.first_name}\n🏷 Username: @${query.from.username || '-'}`;
      return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...getBackButton() });
    }

    if (data === 'menu_task') {
      const settings = await getSettings();
      const text = `📌 **${settings.task_title}**\n\n${settings.task_desc}\n\n💵 Reward: Rp ${settings.reward_per_task}\n🔑 Inisial Bukti: \`${settings.proof_keyword}\`\n\n👇 *Kirimkan pesan bukti tugas langsung di chat ini.*`;
      return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...getBackButton() });
    }

    if (data === 'menu_saldo') {
      const balance = await calculateUserBalance(userId);
      const settings = await getSettings();
      return await bot.sendMessage(chatId, `💰 **Informasi Saldo**\n\nSaldo Aktif: Rp ${balance.toLocaleString('id-ID')}\nMinimum Penarikan: Rp ${settings.min_wd.toLocaleString('id-ID')}`, {
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
        return await bot.sendMessage(chatId, '❌ Saldo tidak mencukupi.', getBackButton());
      }
      return await bot.sendMessage(chatId, '💳 Pilih e-wallet:', {
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
      return await bot.sendMessage(chatId, `Kirim nomor rekening ${method} kamu (berawalan 08...):`);
    }

    if (data === 'wd_confirm') {
      const state = userState[userId];
      if (!state || !state.account_number) return await bot.sendMessage(chatId, 'Sesi kadaluarsa.', getBackButton());
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
      return await bot.sendMessage(chatId, '⏳ Penarikan sedang diproses oleh admin.', getBackButton());
    }
  }
}

app.use(async (req, res) => {
  if (req.method === 'POST') {
    try {
      await handleUpdate(req.body);
    } catch (err) {
      console.error("Vercel Webhook Error:", err.message || err);
    }
    return res.status(200).json({ ok: true });
  }
  res.status(200).send('Serverless Vercel Active!');
});

module.exports = app;
