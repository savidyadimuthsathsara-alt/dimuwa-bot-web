"use strict";

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  downloadContentFromMessage,
  jidNormalizedUser
} = require("@whiskeysockets/baileys");

const QRCode = require("qrcode");
const axios = require("axios");
const ytDlp = require("yt-dlp-exec");

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = Number(process.env.PORT || 3000);

/* =========================================================
   RAILWAY DATA DIRECTORY
========================================================= */

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

/*
  Railway Volume එකක් add කළාම:

  Mount Path:
  /app/data

  Variable:
  DATA_DIR=/app/data
*/

const SETTINGS_FILE =
  path.join(DATA_DIR, "settings.json");

const STATS_FILE =
  path.join(DATA_DIR, "stats.json");

/* =========================================================
   GLOBALS
========================================================= */

const sockets = new Map();
const connectionStates = new Map();
const qrStore = new Map();
const pairingRequested = new Set();

const messageCache = new Map();

const MAX_CACHE = 500;

const botStats = new Map();

const startTimes = new Map();

/* =========================================================
   DEFAULT SETTINGS
========================================================= */

const DEFAULT_SETTINGS = {
  alwaysOnline: "OFF",
  autoRead: "OFF",

  botMode: "PUBLIC",

  statusRead: "ON",
  statusReact: "GREEN",

  composing: "ON",

  antiDelete: "ON",
  antiDelTarget: "SAME",

  vvTarget: "SAME",
  saveTarget: "SAME",

  botPower: "ON"
};

/* =========================================================
   SETTINGS STORAGE
========================================================= */

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(
      SETTINGS_FILE,
      "utf8"
    );

    return JSON.parse(raw || "{}");
  } catch (error) {
    console.error(
      "Settings load error:",
      error.message
    );

    return {};
  }
}

let userSettingsStore = loadSettings();

function saveSettings() {
  try {
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify(
        userSettingsStore,
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "Settings save error:",
      error.message
    );
  }
}

function getSettings(username) {
  if (!userSettingsStore[username]) {
    userSettingsStore[username] = {
      ...DEFAULT_SETTINGS
    };

    saveSettings();
  }

  return userSettingsStore[username];
}

/* =========================================================
   STATS STORAGE
========================================================= */

function loadStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      return {};
    }

    return JSON.parse(
      fs.readFileSync(
        STATS_FILE,
        "utf8"
      )
    );
  } catch {
    return {};
  }
}

let statsStore = loadStats();

function saveStats() {
  try {
    fs.writeFileSync(
      STATS_FILE,
      JSON.stringify(
        statsStore,
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "Stats save error:",
      error.message
    );
  }
}

function increaseMessageCount(username) {
  if (!statsStore[username]) {
    statsStore[username] = {
      messages: 0
    };
  }

  statsStore[username].messages++;

  saveStats();
}

/* =========================================================
   SESSION PATH
========================================================= */

function getSessionPath(username) {
  /*
    IMPORTANT:
    Template literal එකක් භාවිතා කළ යුතුයි.
  */

  return path.join(
    DATA_DIR,
    `session_${username}`
  );
}

/* =========================================================
   UTILS
========================================================= */

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function safeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 50);
}

function getOwnerJid(sock) {
  try {
    if (!sock.user?.id) {
      return null;
    }

    return jidNormalizedUser(
      sock.user.id
    );
  } catch {
    return null;
  }
}

function isGroup(jid) {
  return String(jid || "")
    .endsWith("@g.us");
}

function isStatus(jid) {
  return jid === "status@broadcast";
}

function isPrivateChat(jid) {
  return (
    jid &&
    !isGroup(jid) &&
    !isStatus(jid)
  );
}

/* =========================================================
   BOT MODE
========================================================= */

function isAllowedChat(
  sock,
  username,
  jid
) {
  const settings =
    getSettings(username);

  if (
    settings.botPower === "OFF"
  ) {
    return false;
  }

  const mode =
    settings.botMode || "PUBLIC";

  if (mode === "PUBLIC") {
    return true;
  }

  if (mode === "PRIVATE") {
    const owner = getOwnerJid(sock);

    return (
      !!owner &&
      jidNormalizedUser(jid) === owner
    );
  }

  if (mode === "INBOX") {
    return isPrivateChat(jid);
  }

  return true;
}

/* =========================================================
   MESSAGE CACHE
========================================================= */

function cacheMessage(msg) {
  if (!msg?.key?.id) {
    return;
  }

  const jid =
    msg.key.remoteJid || "";

  const id =
    msg.key.id;

  const cacheKey =
    `${jid}:${id}`;

  messageCache.set(
    cacheKey,
    msg
  );

  if (
    messageCache.size >
    MAX_CACHE
  ) {
    const first =
      messageCache.keys().next().value;

    if (first) {
      messageCache.delete(first);
    }
  }
}

function getCachedMessage(key) {
  if (!key?.id) {
    return null;
  }

  const jid =
    key.remoteJid || "";

  return messageCache.get(
    `${jid}:${key.id}`
  ) || null;
}

/* =========================================================
   RECURSIVE MESSAGE UNWRAP
========================================================= */

function unwrapMessage(message) {
  let current = message;

  while (current) {
    if (
      current.ephemeralMessage
        ?.message
    ) {
      current =
        current.ephemeralMessage.message;

      continue;
    }

    if (
      current.viewOnceMessage
        ?.message
    ) {
      current =
        current.viewOnceMessage.message;

      continue;
    }

    if (
      current.viewOnceMessageV2
        ?.message
    ) {
      current =
        current.viewOnceMessageV2.message;

      continue;
    }

    if (
      current.viewOnceMessageV2Extension
        ?.message
    ) {
      current =
        current.viewOnceMessageV2Extension.message;

      continue;
    }

    break;
  }

  return current || null;
}

/* =========================================================
   FIND MESSAGE CONTENT
========================================================= */

function getMessageContent(msg) {
  if (!msg) {
    return null;
  }

  return unwrapMessage(
    msg.message
  );
}

/* =========================================================
   GET TEXT
========================================================= */

function getText(msg) {
  const content =
    getMessageContent(msg);

  if (!content) {
    return "";
  }

  if (
    typeof content.conversation ===
    "string"
  ) {
    return content.conversation;
  }

  if (
    content.extendedTextMessage
      ?.text
  ) {
    return content.extendedTextMessage.text;
  }

  if (
    content.imageMessage
      ?.caption
  ) {
    return content.imageMessage.caption;
  }

  if (
    content.videoMessage
      ?.caption
  ) {
    return content.videoMessage.caption;
  }

  if (
    content.documentMessage
      ?.caption
  ) {
    return content.documentMessage.caption;
  }

  return "";
}

/* =========================================================
   QUOTED MESSAGE
========================================================= */

function getQuotedMessage(msg) {
  const content =
    getMessageContent(msg);

  if (!content) {
    return null;
  }

  const quoted =
    content.extendedTextMessage
      ?.contextInfo
      ?.quotedMessage;

  if (quoted) {
    return {
      message: quoted
    };
  }

  const imageQuoted =
    content.imageMessage
      ?.contextInfo
      ?.quotedMessage;

  if (imageQuoted) {
    return {
      message: imageQuoted
    };
  }

  const videoQuoted =
    content.videoMessage
      ?.contextInfo
      ?.quotedMessage;

  if (videoQuoted) {
    return {
      message: videoQuoted
    };
  }

  return null;
}

/* =========================================================
   DOWNLOAD BAILEYS MEDIA
========================================================= */

async function downloadBaileysMedia(
  message
) {
  const content =
    getMessageContent(message);

  if (!content) {
    return null;
  }

  let mediaType = null;
  let mediaMessage = null;

  if (content.imageMessage) {
    mediaType = "image";
    mediaMessage =
      content.imageMessage;
  }

  else if (content.videoMessage) {
    mediaType = "video";
    mediaMessage =
      content.videoMessage;
  }

  else if (content.audioMessage) {
    mediaType = "audio";
    mediaMessage =
      content.audioMessage;
  }

  else if (content.documentMessage) {
    mediaType = "document";
    mediaMessage =
      content.documentMessage;
  }

  else if (content.stickerMessage) {
    mediaType = "sticker";
    mediaMessage =
      content.stickerMessage;
  }

  if (
    !mediaType ||
    !mediaMessage
  ) {
    return null;
  }

  try {
    const stream =
      await downloadContentFromMessage(
        mediaMessage,
        mediaType
      );

    const chunks = [];

    for await (
      const chunk of stream
    ) {
      chunks.push(chunk);
    }

    return {
      buffer: Buffer.concat(chunks),
      type: mediaType,
      message: mediaMessage
    };
  } catch (error) {
    console.error(
      "Media download error:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   SEND MEDIA TO CHAT
========================================================= */

async function sendMediaMessage(
  sock,
  jid,
  message
) {
  const media =
    await downloadBaileysMedia(
      message
    );

  if (!media) {
    return false;
  }

  const m =
    media.message;

  try {
    if (media.type === "image") {
      await sock.sendMessage(
        jid,
        {
          image: media.buffer,
          caption:
            m.caption || undefined
        }
      );

      return true;
    }

    if (media.type === "video") {
      await sock.sendMessage(
        jid,
        {
          video: media.buffer,
          caption:
            m.caption || undefined,
          mimetype:
            m.mimetype ||
            "video/mp4"
        }
      );

      return true;
    }

    if (media.type === "audio") {
      await sock.sendMessage(
        jid,
        {
          audio: media.buffer,
          mimetype:
            m.mimetype ||
            "audio/mpeg",
          ptt:
            !!m.ptt
        }
      );

      return true;
    }

    if (media.type === "document") {
      await sock.sendMessage(
        jid,
        {
          document:
            media.buffer,
          mimetype:
            m.mimetype ||
            "application/octet-stream",
          fileName:
            m.fileName ||
            "file"
        }
      );

      return true;
    }

    if (media.type === "sticker") {
      await sock.sendMessage(
        jid,
        {
          sticker:
            media.buffer
        }
      );

      return true;
    }

  } catch (error) {
    console.error(
      "Send media error:",
      error.message
    );
  }

  return false;
}

/* =========================================================
   SEND QUOTED MEDIA
========================================================= */

async function sendQuotedMedia(
  sock,
  msg,
  destination
) {
  const quoted =
    getQuotedMessage(msg);

  if (!quoted) {
    return {
      success: false,
      error:
        "Please reply to an image/video/audio/document/sticker."
    };
  }

  const success =
    await sendMediaMessage(
      sock,
      destination,
      quoted
    );

  if (!success) {
    return {
      success: false,
      error:
        "Quoted message does not contain supported media."
    };
  }

  return {
    success: true
  };
}

/* =========================================================
   DESTINATION
========================================================= */

function getTargetJid(
  sock,
  from,
  setting
) {
  if (
    String(setting).toUpperCase() ===
    "PRIVATE"
  ) {
    return getOwnerJid(sock);
  }

  return from;
}

/* =========================================================
   RANDOM STATUS REACTION
========================================================= */

function randomReaction() {
  const reactions = [
    "❤️",
    "🔥",
    "😂",
    "😍",
    "😮",
    "👏",
    "💯",
    "👍",
    "🥰",
    "😎"
  ];

  return reactions[
    Math.floor(
      Math.random() *
      reactions.length
    )
  ];
}

/* =========================================================
   STATUS HANDLER
========================================================= */

async function handleStatus(
  sock,
  username,
  messages
) {
  const settings =
    getSettings(username);

  if (
    settings.statusRead !== "ON" &&
    settings.statusReact === "OFF"
  ) {
    return;
  }

  for (const msg of messages) {
    try {
      if (
        !msg?.key ||
        msg.key.remoteJid !==
          "status@broadcast"
      ) {
        continue;
      }

      if (
        settings.statusRead ===
        "ON"
      ) {
        try {
          await sock.readMessages([
            msg.key
          ]);
        } catch {}
      }

      if (
        settings.statusReact !==
        "OFF"
      ) {
        const participant =
          msg.key.participant ||
          msg.participant;

        if (!participant) {
          continue;
        }

        let emoji = "❤️";

        if (
          settings.statusReact ===
          "RANDOM"
        ) {
          emoji =
            randomReaction();
        }

        await sock.sendMessage(
          "status@broadcast",
          {
            react: {
              text: emoji,
              key: msg.key
            }
          },
          {
            statusJidList: [
              participant
            ]
          }
        );
      }
    } catch (error) {
      console.error(
        "Status error:",
        error.message
      );
    }
  }
}

/* =========================================================
   ANTI DELETE
========================================================= */

async function handleDeletedMessage(
  sock,
  username,
  key
) {
  const settings =
    getSettings(username);

  if (
    settings.antiDelete !==
    "ON"
  ) {
    return;
  }

  const cached =
    getCachedMessage(key);

  if (!cached) {
    console.log(
      "Deleted message not found in cache:",
      key?.id
    );

    return;
  }

  const originalChat =
    key.remoteJid;

  let destination =
    originalChat;

  if (
    settings.antiDelTarget ===
    "PRIVATE"
  ) {
    destination =
      getOwnerJid(sock);
  }

  if (!destination) {
    return;
  }

  try {
    const text =
      getText(cached);

    if (text) {
      await sock.sendMessage(
        destination,
        {
          text:
            `🗑️ *ANTI DELETE*\n\n${text}`
        }
      );

      return;
    }

    const sent =
      await sendMediaMessage(
        sock,
        destination,
        cached
      );

    if (!sent) {
      await sock.sendMessage(
        destination,
        {
          text:
            "🗑️ Anti-delete: deleted message was detected, but its content could not be restored."
        }
      );
    }

  } catch (error) {
    console.error(
      "Anti-delete error:",
      error.message
    );
  }
}

/* =========================================================
   COMMAND MENU
========================================================= */

async function sendMenu(
  sock,
  jid
) {
  const menu = `
╭━━━〔 *DIMUWA MINI BOT* 〕━━━╮

│ 👋 *WhatsApp Automation Bot*
│
│ 📌 *GENERAL*
│ ├ .menu
│ ├ .alive
│ ├ .status
│ └ .settings
│
│ 🎬 *MEDIA*
│ ├ .vv
│ ├ .save
│ ├ .tt <url>
│ ├ .yt <url>
│ └ .fb <url>
│
│ ⚙️ *SETTINGS*
│
│ .settings
│
│ Configure:
│ • VV target
│ • SAVE target
│ • Anti-delete
│ • Status read
│ • Status reaction
│ • Auto read
│ • Bot mode
│
╰━━━━━━━━━━━━━━━━━━━━━━╯

© 2026 DIMUWA BOT
Created by DIMUTH SATHSARA
`;

  await sock.sendMessage(
    jid,
    {
      text: menu
    }
  );
}

/* =========================================================
   SETTINGS MENU
========================================================= */

async function sendSettings(
  sock,
  jid,
  username
) {
  const s =
    getSettings(username);

  const text = `
⚙️ *DIMUWA BOT SETTINGS*

1️⃣ Always Online:
${s.alwaysOnline}

2️⃣ Auto Read:
${s.autoRead}

3️⃣ Bot Mode:
${s.botMode}

4️⃣ Status Read:
${s.statusRead}

5️⃣ Status React:
${s.statusReact}

6️⃣ Composing:
${s.composing}

7️⃣ Anti Delete:
${s.antiDelete}

8️⃣ Anti Delete Target:
${s.antiDelTarget}

9️⃣ VV Target:
${s.vvTarget}

🔟 SAVE Target:
${s.saveTarget}

1️⃣1️⃣ Bot Power:
${s.botPower}


*COMMANDS*

.settings vv same
.settings vv private

.settings save same
.settings save private

.settings antidelete on
.settings antidelete off

.settings antidelete same
.settings antidelete private

.settings autoread on
.settings autoread off

.settings statusread on
.settings statusread off

.settings statusreact random
.settings statusreact green
.settings statusreact off

.settings botmode public
.settings botmode private
.settings botmode inbox

.settings power on
.settings power off
`;

  await sock.sendMessage(
    jid,
    {
      text
    }
  );
}

/* =========================================================
   SETTINGS COMMAND
========================================================= */

async function processSettingsCommand(
  sock,
  jid,
  username,
  text
) {
  const args =
    text.trim().split(/\s+/);

  const command =
    args[1]?.toLowerCase();

  const value =
    args[2]?.toLowerCase();

  const settings =
    getSettings(username);

  if (!command) {
    await sendSettings(
      sock,
      jid,
      username
    );

    return;
  }

  let changed = true;

  if (command === "vv") {
    if (
      value === "same"
    ) {
      settings.vvTarget =
        "SAME";
    }

    else if (
      value === "private" ||
      value === "inbox"
    ) {
      settings.vvTarget =
        "PRIVATE";
    }

    else {
      changed = false;
    }
  }

  else if (
    command === "save"
  ) {
    if (
      value === "same"
    ) {
      settings.saveTarget =
        "SAME";
    }

    else if (
      value === "private" ||
      value === "inbox"
    ) {
      settings.saveTarget =
        "PRIVATE";
    }

    else {
      changed = false;
    }
  }

  else if (
    command === "antidelete"
  ) {
    if (
      value === "on" ||
      value === "off"
    ) {
      settings.antiDelete =
        value.toUpperCase();
    }

    else if (
      value === "same"
    ) {
      settings.antiDelTarget =
        "SAME";
    }

    else if (
      value === "private" ||
      value === "inbox"
    ) {
      settings.antiDelTarget =
        "PRIVATE";
    }

    else {
      changed = false;
    }
  }

  else if (
    command === "autoread"
  ) {
    if (
      value === "on" ||
      value === "off"
    ) {
      settings.autoRead =
        value.toUpperCase();
    }

    else {
      changed = false;
    }
  }

  else if (
    command === "statusread"
  ) {
    if (
      value === "on" ||
      value === "off"
    ) {
      settings.statusRead =
        value.toUpperCase();
    }

    else {
      changed = false;
    }
  }

  else if (
    command === "statusreact"
  ) {
    if (
      value === "random"
    ) {
      settings.statusReact =
        "RANDOM";
    }

    else if (
      value === "green"
    ) {
      settings.statusReact =
        "GREEN";
    }

    else if (
      value === "off"
    ) {
      settings.statusReact =
        "OFF";
    }

    else {
      changed = false;
    }
  }

  else if (
    command === "botmode"
  ) {
    if (
      [
        "public",
        "private",
        "inbox"
      ].includes(value)
    ) {
      settings.botMode =
        value.toUpperCase();
    }

    else {
      changed = false;
    }
  }

  else if (
    command === "power"
  ) {
    if (
      value === "on" ||
      value === "off"
    ) {
      settings.botPower =
        value.toUpperCase();
    }

    else {
      changed = false;
    }
  }

  else {
    changed = false;
  }

  if (!changed) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Invalid settings command.\n\nUse .settings to see available commands."
      }
    );

    return;
  }

  userSettingsStore[username] =
    settings;

  saveSettings();

  await sock.sendMessage(
    jid,
    {
      text:
        "✅ *SETTING UPDATED*\n\n" +
        JSON.stringify(
          settings,
          null,
          2
        )
    }
  );
}

/* =========================================================
   URL EXTRACTION
========================================================= */

function extractUrl(text) {
  const match =
    String(text || "")
      .match(/https?:\/\/\S+/i);

  return match
    ? match[0]
    : null;
}

/* =========================================================
   YT-DLP DOWNLOAD
========================================================= */

async function downloadWithYtDlp(
  url
) {
  const tempDir =
    path.join(
      os.tmpdir(),
      "dimuwa-bot"
    );

  fs.mkdirSync(
    tempDir,
    {
      recursive: true
    }
  );

  const fileBase =
    path.join(
      tempDir,
      `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
    );

  const output =
    `${fileBase}.%(ext)s`;

  try {
    await ytDlp(
      url,
      {
        output,
        format:
          "best[ext=mp4]/best",
        noPlaylist: true,
        noWarnings: true,
        quiet: true
      }
    );

    const files =
      fs.readdirSync(
        tempDir
      )
      .filter(file =>
        file.startsWith(
          path.basename(fileBase)
        )
      );

    if (!files.length) {
      throw new Error(
        "Downloader did not create a file."
      );
    }

    const file =
      path.join(
        tempDir,
        files[0]
      );

    return file;

  } catch (error) {
    console.error(
      "yt-dlp error:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   SEND DOWNLOADED FILE
========================================================= */

async function sendDownloadedFile(
  sock,
  jid,
  file,
  url
) {
  try {
    const stat =
      fs.statSync(file);

    const maxSize =
      90 * 1024 * 1024;

    if (
      stat.size >
      maxSize
    ) {
      await sock.sendMessage(
        jid,
        {
          text:
            "❌ Downloaded file is too large for this bot."
        }
      );

      return false;
    }

    const buffer =
      fs.readFileSync(file);

    const ext =
      path.extname(file)
        .toLowerCase();

    let message;

    if (
      [
        ".mp4",
        ".mkv",
        ".webm",
        ".mov"
      ].includes(ext)
    ) {
      message = {
        video: buffer,
        mimetype:
          "video/mp4",
        caption:
          `🎬 Downloaded by DIMUWA BOT\n\n${url}`
      };
    }

    else if (
      [
        ".mp3",
        ".m4a",
        ".aac",
        ".wav",
        ".ogg"
      ].includes(ext)
    ) {
      message = {
        audio: buffer,
        mimetype:
          "audio/mpeg"
      };
    }

    else {
      message = {
        document: buffer,
        fileName:
          `dimuwa${ext || ".bin"}`,
        mimetype:
          "application/octet-stream"
      };
    }

    await sock.sendMessage(
      jid,
      message
    );

    return true;

  } catch (error) {
    console.error(
      "Downloaded send error:",
      error.message
    );

    return false;

  } finally {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

/* =========================================================
   URL COMMAND
========================================================= */

async function handleDownloader(
  sock,
  jid,
  command,
  text
) {
  const url =
    extractUrl(text);

  if (!url) {
    await sock.sendMessage(
      jid,
      {
        text:
          `❌ Please send a URL.\n\nExample:\n.${command} https://...`
      }
    );

    return;
  }

  await sock.sendMessage(
    jid,
    {
      text:
        "⏳ Downloading...\nPlease wait."
    }
  );

  const file =
    await downloadWithYtDlp(
      url
    );

  if (!file) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Download failed.\n\nThis URL may not be supported, private, age-restricted, login-required, or temporarily unavailable."
      }
    );

    return;
  }

  const sent =
    await sendDownloadedFile(
      sock,
      jid,
      file,
      url
    );

  if (!sent) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Could not send downloaded media."
      }
    );
  }
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
  sock,
  username,
  msg
) {
  if (!msg?.message) {
    return;
  }

  if (
    msg.key.fromMe
  ) {
    return;
  }

  const from =
    msg.key.remoteJid;

  if (!from) {
    return;
  }

  if (
    from ===
    "status@broadcast"
  ) {
    return;
  }

  const settings =
    getSettings(username);

  increaseMessageCount(
    username
  );

  cacheMessage(msg);

  /*
    AUTO READ
  */

  if (
    settings.autoRead ===
    "ON"
  ) {
    try {
      await sock.readMessages([
        msg.key
      ]);
    } catch {}
  }

  /*
    BOT MODE
  */

  if (
    !isAllowedChat(
      sock,
      username,
      from
    )
  ) {
    return;
  }

  const text =
    getText(msg)
      .trim();

  if (!text) {
    return;
  }

  const lower =
    text.toLowerCase();

  /*
    .menu
  */

  if (
    lower === ".menu" ||
    lower === ".help"
  ) {
    await sendMenu(
      sock,
      from
    );

    return;
  }

  /*
    .alive
  */

  if (
    lower === ".alive"
  ) {
    await sock.sendMessage(
      from,
      {
        text:
          "🟢 *DIMUWA BOT ONLINE*\n\n⚡ Status: Active\n🤖 Bot: Running\n☁️ Railway: Connected"
      }
    );

    return;
  }

  /*
    .status
  */

  if (
    lower === ".status"
  ) {
    await sock.sendMessage(
      from,
      {
        text:
          "🟢 *BOT STATUS*\n\n" +
          `Bot Power: ${settings.botPower}\n` +
          `Mode: ${settings.botMode}\n` +
          `Auto Read: ${settings.autoRead}\n` +
          `Status Read: ${settings.statusRead}\n` +
          `Status React: ${settings.statusReact}\n` +
          `Anti Delete: ${settings.antiDelete}\n` +
          `VV Target: ${settings.vvTarget}\n` +
          `SAVE Target: ${settings.saveTarget}`
      }
    );

    return;
  }

  /*
    .settings
  */

  if (
    lower === ".settings" ||
    lower.startsWith(".settings ")
  ) {
    await processSettingsCommand(
      sock,
      from,
      username,
      text
    );

    return;
  }

  /*
    .vv
  */

  if (
    lower === ".vv"
  ) {
    const destination =
      getTargetJid(
        sock,
        from,
        settings.vvTarget
      );

    if (!destination) {
      await sock.sendMessage(
        from,
        {
          text:
            "❌ Owner/private chat is not available yet."
        }
      );

      return;
    }

    const result =
      await sendQuotedMedia(
        sock,
        msg,
        destination
      );

    if (!result.success) {
      await sock.sendMessage(
        from,
        {
          text:
            `❌ ${result.error}`
        }
      );
    }

    return;
  }

  /*
    .save
  */

  if (
    lower === ".save"
  ) {
    const destination =
      getTargetJid(
        sock,
        from,
        settings.saveTarget
      );

    if (!destination) {
      await sock.sendMessage(
        from,
        {
          text:
            "❌ Owner/private chat is not available yet."
        }
      );

      return;
    }

    const result =
      await sendQuotedMedia(
        sock,
        msg,
        destination
      );

    if (!result.success) {
      await sock.sendMessage(
        from,
        {
          text:
            `❌ ${result.error}`
        }
      );
    }

    return;
  }

  /*
    .tt
  */

  if (
    lower.startsWith(".tt ")
  ) {
    await handleDownloader(
      sock,
      from,
      "tt",
      text
    );

    return;
  }

  /*
    .yt
  */

  if (
    lower.startsWith(".yt ")
  ) {
    await handleDownloader(
      sock,
      from,
      "yt",
      text
    );

    return;
  }

  /*
    .fb
  */

  if (
    lower.startsWith(".fb ")
  ) {
    await handleDownloader(
      sock,
      from,
      "fb",
      text
    );

    return;
  }
}

/* =========================================================
   START BOT
========================================================= */

async function startBot(
  username,
  options = {}
) {
  username =
    safeUsername(username);

  if (!username) {
    throw new Error(
      "Invalid username."
    );
  }

  /*
    Already running
  */

  if (
    sockets.has(username)
  ) {
    return sockets.get(
      username
    );
  }

  const sessionPath =
    getSessionPath(username);

  fs.mkdirSync(
    sessionPath,
    {
      recursive: true
    }
  );

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      sessionPath
    );

  let version;

  try {
    const latest =
      await fetchLatestWaWebVersion();

    version =
      latest.version;
  } catch {
    version =
      undefined;
  }

  const sockOptions = {
    auth: state,
    logger: pino({
      level: "silent"
    }),
    printQRInTerminal: false,
    browser:
      Browsers.ubuntu(
        "Chrome"
      ),
    syncFullHistory: false,
    markOnlineOnConnect: false
  };

  if (version) {
    sockOptions.version =
      version;
  }

  const sock =
    makeWASocket(
      sockOptions
    );

  sockets.set(
    username,
    sock
  );

  startTimes.set(
    username,
    Date.now()
  );

  connectionStates.set(
    username,
    "connecting"
  );

  getSettings(username);

  /*
    Save credentials
  */

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /*
    Connection
  */

  sock.ev.on(
    "connection.update",
    async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        qrStore.set(
          username,
          qr
        );

        connectionStates.set(
          username,
          "qr"
        );
      }

      if (
        connection ===
        "connecting"
      ) {
        connectionStates.set(
          username,
          "connecting"
        );
      }

      if (
        connection ===
        "open"
      ) {
        connectionStates.set(
          username,
          "open"
        );

        qrStore.delete(
          username
        );

        pairingRequested.delete(
          username
        );

        console.log(
          `[${username}] WhatsApp connected.`
        );

        /*
          Always Online
        */

        const settings =
          getSettings(
            username
          );

        if (
          settings.alwaysOnline ===
          "ON"
        ) {
          try {
            await sock.sendPresenceUpdate(
              "available"
            );
          } catch {}
        }
      }

      if (
        connection ===
        "close"
      ) {
        connectionStates.set(
          username,
          "closed"
        );

        sockets.delete(
          username
        );

        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        const shouldReconnect =
          statusCode !==
          DisconnectReason.loggedOut;

        console.log(
          `[${username}] Connection closed. Reconnect: ${shouldReconnect}`
        );

        if (
          shouldReconnect
        ) {
          await sleep(3000);

          try {
            await startBot(
              username
            );
          } catch (error) {
            console.error(
              "Reconnect error:",
              error.message
            );
          }
        }
      }
    }
  );

  /*
    New messages
  */

  sock.ev.on(
    "messages.upsert",
    async data => {
      try {
        const messages =
          data?.messages || [];

        for (const msg of messages) {
          if (
            msg.key?.remoteJid ===
            "status@broadcast"
          ) {
            await handleStatus(
              sock,
              username,
              [msg]
            );

            continue;
          }

          await handleMessage(
            sock,
            username,
            msg
          );
        }
      } catch (error) {
        console.error(
          "messages.upsert error:",
          error.message
        );
      }
    }
  );

  /*
    Proper delete event
  */

  sock.ev.on(
    "messages.delete",
    async event => {
      try {
        const keys =
          event?.keys ||
          [];

        for (const key of keys) {
          await handleDeletedMessage(
            sock,
            username,
            key
          );
        }
      } catch (error) {
        console.error(
          "messages.delete error:",
          error.message
        );
      }
    }
  );

  return sock;
}

/* =========================================================
   RESTORE EXISTING SESSIONS
========================================================= */

async function restoreExistingSessions() {
  try {
    const entries =
      fs.readdirSync(
        DATA_DIR,
        {
          withFileTypes: true
        }
      );

    const sessions =
      entries.filter(
        entry =>
          entry.isDirectory() &&
          entry.name.startsWith(
            "session_"
          )
      );

    for (const entry of sessions) {
      const username =
        entry.name.replace(
          /^session_/,
          ""
        );

      if (!username) {
        continue;
      }

      try {
        console.log(
          `Restoring session: ${username}`
        );

        await startBot(
          username
        );

        await sleep(1500);

      } catch (error) {
        console.error(
          `Failed to restore ${username}:`,
          error.message
        );
      }
    }
  } catch (error) {
    console.error(
      "Session restore error:",
      error.message
    );
  }
}

/* =========================================================
   API - PAIRING CODE
========================================================= */

app.get(
  "/get-pairing-code",
  async (req, res) => {
    try {
      const username =
        safeUsername(
          req.query.username
        );

      if (!username) {
        return res.status(400).json({
          success: false,
          error:
            "Username is required."
        });
      }

      let sock =
        sockets.get(
          username
        );

      /*
        Start socket if not running.
      */

      if (!sock) {
        sock =
          await startBot(
            username,
            {
              pairing: true
            }
          );

        await sleep(2000);
      }

      /*
        Already connected
      */

      if (
        sock.user?.id &&
        connectionStates.get(
          username
        ) === "open"
      ) {
        return res.json({
          success: false,
          error:
            "This bot is already connected."
        });
      }

      if (
        pairingRequested.has(
          username
        )
      ) {
        return res.json({
          success: false,
          error:
            "Pairing code request already in progress. Wait a few seconds and try again."
        });
      }

      pairingRequested.add(
        username
      );

      try {
        const phone =
          String(
            req.query.phone ||
            ""
          )
          .replace(
            /[^0-9]/g,
            ""
          );

        if (!phone) {
          pairingRequested.delete(
            username
          );

          return res.status(400).json({
            success: false,
            error:
              "Phone number required. Add ?phone=947XXXXXXXX"
          });
        }

        if (
          !sock.authState
        ) {
          /*
            Baileys socket does not expose
            authState directly in all versions.
            We therefore rely on state.creds
            through a temporary auth check below.
          */
        }

        const code =
          await sock.requestPairingCode(
            phone
          );

        pairingRequested.delete(
          username
        );

        return res.json({
          success: true,
          code
        });

      } catch (error) {
        pairingRequested.delete(
          username
        );

        console.error(
          "Pairing code error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          error:
            error.message ||
            "Could not generate pairing code."
        });
      }

    } catch (error) {
      return res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   API - QR
========================================================= */

app.get(
  "/get-qr",
  async (req, res) => {
    try {
      const username =
        safeUsername(
          req.query.username
        );

      if (!username) {
        return res.status(400).send(
          "Username required."
        );
      }

      let sock =
        sockets.get(
          username
        );

      if (!sock) {
        await startBot(
          username
        );

        await sleep(1000);

        sock =
          sockets.get(
            username
          );
      }

      const qr =
        qrStore.get(
          username
        );

      if (!qr) {
        return res.status(404).send(
          "QR not available yet. Wait a few seconds and refresh."
        );
      }

      const buffer =
        await QRCode.toBuffer(
          qr,
          {
            type: "png",
            width: 600,
            margin: 2
          }
        );

      res.setHeader(
        "Content-Type",
        "image/png"
      );

      res.send(buffer);

    } catch (error) {
      res.status(500).send(
        error.message
      );
    }
  }
);

/* =========================================================
   API - DETAILS
========================================================= */

app.get(
  "/details",
  async (req, res) => {
    const username =
      safeUsername(
        req.query.username
      );

    if (!username) {
      return res.json({
        success: false,
        error:
          "Username required."
      });
    }

    const sock =
      sockets.get(
        username
      );

    const settings =
      getSettings(
        username
      );

    const stat =
      statsStore[username] ||
      {
        messages: 0
      };

    const started =
      startTimes.get(
        username
      );

    const uptime =
      started
        ? Math.floor(
            (Date.now() -
              started) /
              1000
          )
        : 0;

    res.json({
      success: true,
      username,
      connected:
        connectionStates.get(
          username
        ) === "open",
      connection:
        connectionStates.get(
          username
        ) || "offline",
      user:
        sock?.user || null,
      messages:
        stat.messages || 0,
      uptime,
      settings
    });
  }
);

/* =========================================================
   API - STATS
========================================================= */

app.get(
  "/stats",
  (req, res) => {
    res.json({
      success: true,
      bots:
        sockets.size,
      stats:
        statsStore
    });
  }
);

/* =========================================================
   API - LOGOUT
========================================================= */

app.post(
  "/logout",
  async (req, res) => {
    try {
      const username =
        safeUsername(
          req.query.username
        );

      const sock =
        sockets.get(
          username
        );

      if (!sock) {
        return res.json({
          success: false,
          error:
            "Bot is not connected."
        });
      }

      try {
        await sock.logout();
      } catch {}

      sockets.delete(
        username
      );

      connectionStates.set(
        username,
        "logged_out"
      );

      res.json({
        success: true
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   API - UNLINK / DELETE SESSION
========================================================= */

app.post(
  "/unlink",
  async (req, res) => {
    try {
      const username =
        safeUsername(
          req.query.username
        );

      const sock =
        sockets.get(
          username
        );

      if (sock) {
        try {
          await sock.logout();
        } catch {}
      }

      sockets.delete(
        username
      );

      qrStore.delete(
        username
      );

      connectionStates.set(
        username,
        "unlinked"
      );

      const sessionPath =
        getSessionPath(
          username
        );

      fs.rmSync(
        sessionPath,
        {
          recursive: true,
          force: true
        }
      );

      res.json({
        success: true
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      service:
        "DIMUWA MINI BOT",
      uptime:
        process.uptime(),
      bots:
        sockets.size
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      `DIMUWA MINI BOT running on port ${PORT}`
    );

    console.log(
      `DATA_DIR = ${DATA_DIR}`
    );

    await restoreExistingSessions();
  }
);

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);
