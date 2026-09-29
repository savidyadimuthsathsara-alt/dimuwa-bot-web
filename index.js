"use strict";

/*
=========================================================
        DIMUWA MINI BOT - FULL INDEX.JS
        Railway + Baileys + yt-dlp
=========================================================
*/

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, execFile } = require("child_process");
const util = require("util");

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent
} = require("@whiskeysockets/baileys");

const execFileAsync = util.promisify(execFile);

/*
=========================================================
                    CONFIG
=========================================================
*/

const PORT = Number(process.env.PORT || 3000);

const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, "data");

const SESSION_DIR = path.join(DATA_DIR, "sessions");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const TOOLS_DIR = path.join(DATA_DIR, "tools");

const LOGO_URL = "https://files.catbox.moe/6gq4ub.jpeg";
const MENU_AUDIO_URL = "https://files.catbox.moe/vsl1wg.mp3";

const DIMUWA_CHANNEL_INVITE =
  "0029VbDZDmx4inoi10evlP1M";

const DIMUWA_CHANNEL_URL =
  "https://whatsapp.com/channel/0029VbDZDmx4inoi10evlP1M";

const CREATOR_NAME = "Dimuth sathsara";
const CREATOR_PHONE = "+94740325746";

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

/*
=========================================================
                    DIRECTORIES
=========================================================
*/

for (const dir of [
  DATA_DIR,
  SESSION_DIR,
  MEDIA_DIR,
  TOOLS_DIR
]) {
  fs.mkdirSync(dir, {
    recursive: true
  });
}

/*
=========================================================
                    EXPRESS
=========================================================
*/

const app = express();

app.use(cors());
app.use(express.json({
  limit: "2mb"
}));

app.get("/", (req, res) => {
  res.json({
    name: "DIMUWA MINI BOT",
    status: "online",
    creator: CREATOR_NAME,
    version: "5.0.0"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    status: "online",
    bot: "DIMUWA MINI BOT",
    time: new Date().toISOString()
  });
});

/*
=========================================================
                    MEMORY / STATE
=========================================================
*/

const bots = new Map();
const qrStore = new Map();

const settingsStore = new Map();

const messageCache = new Map();
const messageStats = new Map();

const downloadJobs = new Map();

/*
=========================================================
                    DEFAULT SETTINGS
=========================================================
*/

const DEFAULT_SETTINGS = {
  alwaysOnline: "ON",
  autoRead: "OFF",
  botMode: "INBOX",
  statusRead: "ON",
  statusReact: "GREEN",
  composing: "ON",

  antiDelete: "ON",
  antiDelTarget: "SAME",

  vvTarget: "PRIVATE",
  saveTarget: "PRIVATE",

  botPower: "ON"
};

/*
=========================================================
                    BASIC HELPERS
=========================================================
*/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSettings(username) {
  if (!settingsStore.has(username)) {
    settingsStore.set(
      username,
      {
        ...DEFAULT_SETTINGS
      }
    );
  }

  return settingsStore.get(username);
}

function updateSettings(username, key, value) {
  const settings = getSettings(username);

  settings[key] = value;

  settingsStore.set(username, settings);

  return settings;
}

function jidNumber(jid = "") {
  return String(jid)
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function jidFromPhone(phone = "") {
  const number = String(phone).replace(/\D/g, "");

  if (!number) {
    return null;
  }

  return `${number}@s.whatsapp.net`;
}

function normalizePhone(phone = "") {
  let value = String(phone)
    .replace(/\D/g, "");

  if (value.startsWith("00")) {
    value = value.slice(2);
  }

  if (value.startsWith("0")) {
    value = "94" + value.slice(1);
  }

  return value;
}

function isGroupJid(jid = "") {
  return jid.endsWith("@g.us");
}

function isStatusJid(jid = "") {
  return jid === "status@broadcast";
}

function isPrivateJid(jid = "") {
  return jid.endsWith("@s.whatsapp.net");
}

function sameNumber(a, b) {
  return jidNumber(a) === jidNumber(b);
}

/*
=========================================================
                    MESSAGE UNWRAP
=========================================================
*/

function unwrapMessageContent(message) {
  let current = message;

  for (let i = 0; i < 10 && current; i++) {
    try {
      const normalized =
        normalizeMessageContent(current) || current;

      current = normalized;

      if (current.viewOnceMessage?.message) {
        current = current.viewOnceMessage.message;
        continue;
      }

      if (current.viewOnceMessageV2?.message) {
        current = current.viewOnceMessageV2.message;
        continue;
      }

      if (current.viewOnceMessageV2Extension?.message) {
        current = current.viewOnceMessageV2Extension.message;
        continue;
      }

      if (current.ephemeralMessage?.message) {
        current = current.ephemeralMessage.message;
        continue;
      }

      if (current.documentWithCaptionMessage?.message) {
        current = current.documentWithCaptionMessage.message;
        continue;
      }

      break;
    } catch {
      break;
    }
  }

  return current;
}

function getMessageContent(msg) {
  if (!msg?.message) {
    return null;
  }

  return unwrapMessageContent(msg.message);
}

function getContextInfo(message) {
  const root = message;

  if (!root || typeof root !== "object") {
    return null;
  }

  const queue = [root];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();

    if (!current || typeof current !== "object") {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    if (current.contextInfo) {
      return current.contextInfo;
    }

    for (const value of Object.values(current)) {
      if (
        value &&
        typeof value === "object"
      ) {
        queue.push(value);
      }
    }
  }

  return null;
}

function getMessageText(msg) {
  const content = getMessageContent(msg);

  if (!content) {
    return "";
  }

  if (typeof content.conversation === "string") {
    return content.conversation.trim();
  }

  if (
    typeof content.extendedTextMessage?.text ===
    "string"
  ) {
    return content.extendedTextMessage.text.trim();
  }

  if (
    typeof content.imageMessage?.caption ===
    "string"
  ) {
    return content.imageMessage.caption.trim();
  }

  if (
    typeof content.videoMessage?.caption ===
    "string"
  ) {
    return content.videoMessage.caption.trim();
  }

  if (
    typeof content.documentMessage?.caption ===
    "string"
  ) {
    return content.documentMessage.caption.trim();
  }

  return "";
}

function getMediaInfo(msg) {
  const content = getMessageContent(msg);

  if (!content) {
    return null;
  }

  const type = getContentType(content);

  if (!type) {
    return null;
  }

  if (type === "imageMessage") {
    return {
      type: "image",
      mimetype:
        content.imageMessage?.mimetype ||
        "image/jpeg",
      caption:
        content.imageMessage?.caption || ""
    };
  }

  if (type === "videoMessage") {
    return {
      type: "video",
      mimetype:
        content.videoMessage?.mimetype ||
        "video/mp4",
      caption:
        content.videoMessage?.caption || ""
    };
  }

  if (type === "audioMessage") {
    return {
      type: "audio",
      mimetype:
        content.audioMessage?.mimetype ||
        "audio/mpeg",
      ptt:
        Boolean(content.audioMessage?.ptt)
    };
  }

  if (type === "documentMessage") {
    return {
      type: "document",
      mimetype:
        content.documentMessage?.mimetype ||
        "application/octet-stream",
      fileName:
        content.documentMessage?.fileName ||
        "file"
    };
  }

  return null;
}

/*
=========================================================
                    QUOTED MESSAGE
=========================================================
*/

function getQuotedMessage(msg) {
  if (!msg?.message) {
    return null;
  }

  const contextInfo =
    getContextInfo(msg.message);

  const quoted =
    contextInfo?.quotedMessage;

  if (!quoted) {
    return null;
  }

  const participant =
    contextInfo?.participant ||
    msg.key?.participant ||
    msg.key?.remoteJid;

  return {
    key: {
      remoteJid:
        msg.key?.remoteJid,
      fromMe:
        Boolean(contextInfo?.fromMe),
      id:
        contextInfo?.stanzaId ||
        `quoted-${Date.now()}`,
      participant
    },

    message: quoted
  };
}

/*
=========================================================
                    WHATSAPP MEDIA
=========================================================
*/

async function downloadWhatsAppMedia(
  sock,
  message
) {
  return await downloadMediaMessage(
    message,
    "buffer",
    {},
    {
      logger,

      reuploadRequest: async m => {
        return await sock.updateMediaMessage(m);
      }
    }
  );
}

/*
=========================================================
                    SEND MEDIA
=========================================================
*/

async function sendMediaToChat(
  sock,
  jid,
  buffer,
  mediaInfo,
  caption = "",
  quoted = null
) {
  if (!buffer) {
    throw new Error(
      "Media buffer is empty."
    );
  }

  if (mediaInfo.type === "image") {
    return await sock.sendMessage(
      jid,
      {
        image: buffer,
        mimetype:
          mediaInfo.mimetype ||
          "image/jpeg",
        caption
      },
      quoted
        ? {
            quoted
          }
        : undefined
    );
  }

  if (mediaInfo.type === "video") {
    return await sock.sendMessage(
      jid,
      {
        video: buffer,
        mimetype:
          mediaInfo.mimetype ||
          "video/mp4",
        caption
      },
      quoted
        ? {
            quoted
          }
        : undefined
    );
  }

  if (mediaInfo.type === "audio") {
    return await sock.sendMessage(
      jid,
      {
        audio: buffer,
        mimetype:
          mediaInfo.mimetype ||
          "audio/mpeg",
        ptt: Boolean(mediaInfo.ptt)
      },
      quoted
        ? {
            quoted
          }
        : undefined
    );
  }

  if (mediaInfo.type === "document") {
    return await sock.sendMessage(
      jid,
      {
        document: buffer,
        mimetype:
          mediaInfo.mimetype ||
          "application/octet-stream",
        fileName:
          mediaInfo.fileName ||
          "file"
      },
      quoted
        ? {
            quoted
          }
        : undefined
    );
  }

  throw new Error(
    "Unsupported media type."
  );
}

/*
=========================================================
                    MENU
=========================================================
*/

function menuText(username) {
  const settings =
    getSettings(username);

  return `👋 DIMUWA MINI BOT 🤖 👑
-- The Mini Whatsapp Bot Experience --

┌──「 👨‍💻 CREATOR INFO 」──┐
│ 👨‍💻 Creator: Dimuth sathsara
│ 📱 Contact: +94740325746
│ ⚙️ Prefix: [ . ]
└────────────────────┘

┌──「 🤖 BOT STATUS 」──┐
│ 🇱🇰 Bot Name: DIMUWA MINI BOT
│ 🟢 Status: Online
│ ⚙️ Mode: ${settings.botMode}
└────────────────────┘

┌──「 📁 MAIN MENU 」──┐
│ 1️⃣ 📥 DOWNLOAD (TikTok, FB, YT)
│ 2️⃣ ⚙️ SETTINGS (.settings)
│ 3️⃣ 👑 OWNER COMMANDS
│ 4️⃣ 🛠️ UTILITY (.vv, .save)
│ 5️⃣ 🎮 FUN COMMANDS
│ 6️⃣ 👥 GROUP COMMANDS (.tagall)
└────────────────────┘

💡 Type or reply a number (1-6) or command!

© 2026 DIMUWA BOT. Created by DIMUTH SATHSARA`;
}

async function sendMenu(
  sock,
  username,
  jid
) {
  try {
    await sock.sendMessage(
      jid,
      {
        image: {
          url: LOGO_URL
        },
        caption:
          menuText(username)
      }
    );
  } catch (error) {
    logger.error({
      error: error.message
    }, "Menu image failed.");

    await sock.sendMessage(
      jid,
      {
        text:
          menuText(username)
      }
    );
  }

  try {
    await sock.sendMessage(
      jid,
      {
        audio: {
          url: MENU_AUDIO_URL
        },
        mimetype: "audio/mpeg",
        ptt: false
      }
    );
  } catch (error) {
    logger.error({
      error: error.message
    }, "Menu audio failed.");
  }
}

/*
=========================================================
                    SETTINGS MENU
=========================================================
*/

function settingsText(username) {
  const s =
    getSettings(username);

  return `╭━━〔 ⚙️ DIMUWA SETTINGS 〕━━╮
┃
┃ 01. Always Online
┃     ➜ ${s.alwaysOnline}
┃
┃ 02. Auto Read
┃     ➜ ${s.autoRead}
┃
┃ 03. Bot Mode
┃     ➜ ${s.botMode}
┃
┃ 04. Status Read
┃     ➜ ${s.statusRead}
┃
┃ 05. Status React
┃     ➜ ${s.statusReact}
┃
┃ 06. Composing
┃     ➜ ${s.composing}
┃
┃ 07. Anti Delete
┃     ➜ ${s.antiDelete}
┃
┃ 08. Anti Delete Target
┃     ➜ ${s.antiDelTarget}
┃
┃ 09. View Once Target
┃     ➜ ${s.vvTarget}
┃
┃ 10. Save Target
┃     ➜ ${s.saveTarget}
┃
┃ 11. Bot Power
┃     ➜ ${s.botPower}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯

Use:
1.1 = Always Online ON
1.2 = Always Online OFF

2.1 = Auto Read ON
2.2 = Auto Read OFF

3.1 = PUBLIC
3.2 = INBOX

4.1 = Status Read ON
4.2 = Status Read OFF

5.1 = Status React GREEN
5.2 = Status React OFF

6.1 = Composing ON
6.2 = Composing OFF

7.1 = Anti Delete ON
7.2 = Anti Delete OFF

8.1 = Anti Delete SAME
8.2 = Anti Delete PRIVATE

9.1 = VV PRIVATE
9.2 = VV SAME

10.1 = SAVE PRIVATE
10.2 = SAVE SAME

11.1 = BOT ON
11.2 = BOT OFF`;
}

/*
=========================================================
                    SETTINGS CODE
=========================================================
*/

function processSettingsCode(
  username,
  rawText
) {
  const text =
    String(rawText)
      .trim()
      .toLowerCase();

  const match =
    text.match(
      /^(?:\.settings\s+)?(\d{1,2}\.\d)$/
    );

  if (!match) {
    return null;
  }

  const code = match[1];

  const map = {
    "1.1": ["alwaysOnline", "ON"],
    "1.2": ["alwaysOnline", "OFF"],

    "2.1": ["autoRead", "ON"],
    "2.2": ["autoRead", "OFF"],

    "3.1": ["botMode", "PUBLIC"],
    "3.2": ["botMode", "INBOX"],

    "4.1": ["statusRead", "ON"],
    "4.2": ["statusRead", "OFF"],

    "5.1": ["statusReact", "GREEN"],
    "5.2": ["statusReact", "OFF"],

    "6.1": ["composing", "ON"],
    "6.2": ["composing", "OFF"],

    "7.1": ["antiDelete", "ON"],
    "7.2": ["antiDelete", "OFF"],

    "8.1": ["antiDelTarget", "SAME"],
    "8.2": ["antiDelTarget", "PRIVATE"],

    "9.1": ["vvTarget", "PRIVATE"],
    "9.2": ["vvTarget", "SAME"],

    "10.1": ["saveTarget", "PRIVATE"],
    "10.2": ["saveTarget", "SAME"],

    "11.1": ["botPower", "ON"],
    "11.2": ["botPower", "OFF"]
  };

  const selected = map[code];

  if (!selected) {
    return false;
  }

  updateSettings(
    username,
    selected[0],
    selected[1]
  );

  return {
    key: selected[0],
    value: selected[1]
  };
}

/*
=========================================================
                    BOT POWER
=========================================================
*/

function isBotPowerOn(username) {
  return (
    getSettings(username)
      .botPower === "ON"
  );
}

/*
=========================================================
                    MESSAGE PERMISSION
=========================================================
*/

function canProcessMessage(
  sock,
  username,
  msg
) {
  const settings =
    getSettings(username);

  const jid =
    msg.key?.remoteJid || "";

  if (!jid) {
    return false;
  }

  if (isStatusJid(jid)) {
    return false;
  }

  if (
    settings.botMode === "INBOX"
  ) {
    if (isGroupJid(jid)) {
      return false;
    }
  }

  if (
    settings.botMode === "PUBLIC"
  ) {
    return true;
  }

  return true;
}

/*
=========================================================
                    COMPOSING
=========================================================
*/

async function sendComposing(
  sock,
  jid,
  enabled
) {
  if (!enabled) {
    return;
  }

  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate(
      "composing",
      jid
    );

    setTimeout(() => {
      sock
        .sendPresenceUpdate(
          "paused",
          jid
        )
        .catch(() => {});
    }, 1200);
  } catch {}
}

/*
=========================================================
                    READ
=========================================================
*/

async function markReadIfEnabled(
  sock,
  username,
  msg
) {
  const settings =
    getSettings(username);

  if (settings.autoRead !== "ON") {
    return;
  }

  try {
    await sock.readMessages([
      msg.key
    ]);
  } catch {}
}

/*
=========================================================
                    ONLINE
=========================================================
*/

async function applyOnlinePresence(
  sock,
  username
) {
  const settings =
    getSettings(username);

  try {
    if (
      settings.alwaysOnline === "ON"
    ) {
      await sock.sendPresenceUpdate(
        "available"
      );
    } else {
      await sock.sendPresenceUpdate(
        "unavailable"
      );
    }
  } catch {}
}

/*
=========================================================
                    STATUS
=========================================================
*/

async function handleStatus(
  sock,
  username,
  msg
) {
  const settings =
    getSettings(username);

  if (
    msg.key?.remoteJid !==
    "status@broadcast"
  ) {
    return;
  }

  if (
    settings.statusRead === "ON"
  ) {
    try {
      await sock.readMessages([
        msg.key
      ]);
    } catch {}
  }
}

/*
=========================================================
                    ANTI DELETE CACHE
=========================================================
*/

function cacheMessage(
  username,
  msg
) {
  const settings =
    getSettings(username);

  if (
    settings.antiDelete !== "ON"
  ) {
    return;
  }

  if (!msg?.key?.id) {
    return;
  }

  const cacheKey =
    `${username}:${msg.key.id}`;

  messageCache.set(
    cacheKey,
    msg
  );

  setTimeout(() => {
    messageCache.delete(cacheKey);
  }, 60 * 60 * 1000);
}

/*
=========================================================
                    ANTI DELETE
=========================================================
*/

async function handleDeletedMessages(
  username,
  sock,
  event
) {
  const settings =
    getSettings(username);

  if (
    settings.antiDelete !== "ON"
  ) {
    return;
  }

  const keys =
    Array.isArray(event?.keys)
      ? event.keys
      : Array.isArray(event)
        ? event
        : [];

  for (const key of keys) {
    const cacheKey =
      `${username}:${key.id}`;

    const oldMessage =
      messageCache.get(cacheKey);

    if (!oldMessage) {
      continue;
    }

    const target =
      settings.antiDelTarget ===
      "PRIVATE"
        ? jidFromPhone(
            jidNumber(
              sock.user?.id
            )
          )
        : key.remoteJid;

    if (!target) {
      continue;
    }

    try {
      const text =
        getMessageText(oldMessage);

      const media =
        getMediaInfo(oldMessage);

      if (media) {
        const buffer =
          await downloadWhatsAppMedia(
            sock,
            oldMessage
          );

        await sendMediaToChat(
          sock,
          target,
          buffer,
          media,
          `♻️ *ANTI DELETE*\n\n👤 Message recovered\n🆔 ${key.id}`
        );
      } else if (text) {
        await sock.sendMessage(
          target,
          {
            text:
              `♻️ *ANTI DELETE*\n\n${text}`
          }
        );
      }
    } catch (error) {
      logger.error({
        error: error.message
      }, "Anti-delete failed.");
    }

    messageCache.delete(
      cacheKey
    );
  }
}

/*
=========================================================
                    OWNER
=========================================================
*/

function getOwnerJid(sock) {
  const id =
    sock?.user?.id;

  if (!id) {
    return null;
  }

  return jidFromPhone(
    jidNumber(id)
  );
}

function isOwnerMessage(
  sock,
  msg
) {
  const owner =
    getOwnerJid(sock);

  if (!owner) {
    return false;
  }

  const remote =
    msg.key?.remoteJid || "";

  return (
    sameNumber(remote, owner) ||
    Boolean(msg.key?.fromMe)
  );
}

/*
=========================================================
                    MENU NUMBER
=========================================================
*/

async function handleMenuNumber(
  sock,
  username,
  jid,
  number,
  msg
) {
  if (number === "1") {
    await sock.sendMessage(
      jid,
      {
        text:
`📥 *DOWNLOAD MENU*

1️⃣ TikTok
2️⃣ Facebook
3️⃣ YouTube

Send:
.tt <url>
.fb <url>
.yt <url>

Or simply send the URL.`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  if (number === "2") {
    await sock.sendMessage(
      jid,
      {
        text:
          settingsText(username)
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  if (number === "3") {
    if (
      !isOwnerMessage(
        sock,
        msg
      )
    ) {
      await sock.sendMessage(
        jid,
        {
          text:
            "❌ Owner only command."
        },
        {
          quoted: msg
        }
      );

      return true;
    }

    await sock.sendMessage(
      jid,
      {
        text:
`👑 *OWNER COMMANDS*

.ping
.menu
.settings
.logout
.unlink

Bot owner:
${CREATOR_NAME}
${CREATOR_PHONE}`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  if (number === "4") {
    await sock.sendMessage(
      jid,
      {
        text:
`🛠️ *UTILITY*

Reply to an image/video/audio with:

.vv
.save

.vv = View / resend media
.save = Save / resend media`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  if (number === "5") {
    await sock.sendMessage(
      jid,
      {
        text:
`🎮 *FUN COMMANDS*

🎲 .dice
🎯 .random
❤️ .love`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  if (number === "6") {
    await sock.sendMessage(
      jid,
      {
        text:
`👥 *GROUP COMMANDS*

.tagall

Reply/send in a group to tag members.`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  return false;
}

/*
=========================================================
                    GROUP TAG ALL
=========================================================
*/

async function handleTagAll(
  sock,
  jid,
  msg
) {
  if (!isGroupJid(jid)) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ .tagall can only be used in groups."
      },
      {
        quoted: msg
      }
    );

    return;
  }

  try {
    const metadata =
      await sock.groupMetadata(
        jid
      );

    const participants =
      metadata.participants || [];

    if (!participants.length) {
      return;
    }

    const mentions =
      participants.map(
        p => p.id
      );

    const body =
`📢 *DIMUWA TAG ALL*

${participants
  .map(
    p => `@${jidNumber(p.id)}`
  )
  .join(" ")}`;

    await sock.sendMessage(
      jid,
      {
        text: body,
        mentions
      },
      {
        quoted: msg
      }
    );
  } catch (error) {
    await sock.sendMessage(
      jid,
      {
        text:
          `❌ Tag all failed.\n\n${error.message}`
      },
      {
        quoted: msg
      }
    );
  }
}

/*
=========================================================
                    FUN
=========================================================
*/

async function handleFunCommand(
  sock,
  jid,
  command,
  msg
) {
  if (command === ".dice") {
    const value =
      Math.floor(
        Math.random() * 6
      ) + 1;

    await sock.sendMessage(
      jid,
      {
        text:
          `🎲 Dice: *${value}*`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  if (command === ".random") {
    const value =
      Math.floor(
        Math.random() * 100
      ) + 1;

    await sock.sendMessage(
      jid,
      {
        text:
          `🎯 Random number: *${value}*`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  if (command === ".love") {
    const value =
      Math.floor(
        Math.random() * 101
      );

    await sock.sendMessage(
      jid,
      {
        text:
          `❤️ Love: *${value}%*`
      },
      {
        quoted: msg
      }
    );

    return true;
  }

  return false;
}

/*
=========================================================
                    VV / SAVE TARGET
=========================================================
*/

function getMediaTarget(
  sock,
  username,
  currentJid,
  type
) {
  const settings =
    getSettings(username);

  const setting =
    type === "vv"
      ? settings.vvTarget
      : settings.saveTarget;

  if (setting === "PRIVATE") {
    return getOwnerJid(sock);
  }

  return currentJid;
}

/*
=========================================================
                    VV COMMAND
=========================================================
*/

async function handleViewOnce(
  sock,
  username,
  jid,
  msg
) {
  const quoted =
    getQuotedMessage(msg);

  if (!quoted) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Reply to a view-once/image/video/audio message with *.vv*."
      },
      {
        quoted: msg
      }
    );

    return;
  }

  const media =
    getMediaInfo(quoted);

  if (!media) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ The replied message does not contain supported media."
      },
      {
        quoted: msg
      }
    );

    return;
  }

  try {
    await sock.sendMessage(
      jid,
      {
        text:
          "⏳ *Processing .vv...*"
      },
      {
        quoted: msg
      }
    );

    const buffer =
      await downloadWhatsAppMedia(
        sock,
        quoted
      );

    const target =
      getMediaTarget(
        sock,
        username,
        jid,
        "vv"
      );

    if (!target) {
      throw new Error(
        "Owner number is not available."
      );
    }

    await sendMediaToChat(
      sock,
      target,
      buffer,
      media,
      ""
    );

    if (target !== jid) {
      await sock.sendMessage(
        jid,
        {
          text:
            "✅ *VV sent to private owner chat.*"
        },
        {
          quoted: msg
        }
      );
    }
  } catch (error) {
    logger.error({
      error: error.message
    }, "VV failed.");

    await sock.sendMessage(
      jid,
      {
        text:
          `❌ *VV failed*\n\n${error.message}`
      },
      {
        quoted: msg
      }
    );
  }
}

/*
=========================================================
                    SAVE COMMAND
=========================================================
*/

async function handleSave(
  sock,
  username,
  jid,
  msg
) {
  const quoted =
    getQuotedMessage(msg);

  const source =
    quoted || msg;

  const media =
    getMediaInfo(source);

  if (!media) {
    await sock.sendMessage(
      jid,
      {
        text:
          "❌ Reply to an image/video/audio/document with *.save*."
      },
      {
        quoted: msg
      }
    );

    return;
  }

  try {
    await sock.sendMessage(
      jid,
      {
        text:
          "⏳ *Saving media...*"
      },
      {
        quoted: msg
      }
    );

    const buffer =
      await downloadWhatsAppMedia(
        sock,
        source
      );

    const target =
      getMediaTarget(
        sock,
        username,
        jid,
        "save"
      );

    if (!target) {
      throw new Error(
        "Owner number is not available."
      );
    }

    await sendMediaToChat(
      sock,
      target,
      buffer,
      media,
      ""
    );

    if (target !== jid) {
      await sock.sendMessage(
        jid,
        {
          text:
            "✅ *Media saved to private owner chat.*"
        },
        {
          quoted: msg
        }
      );
    }
  } catch (error) {
    logger.error({
      error: error.message
    }, "SAVE failed.");

    await sock.sendMessage(
      jid,
      {
        text:
          `❌ *SAVE failed*\n\n${error.message}`
      },
      {
        quoted: msg
      }
    );
  }
}

/*
=========================================================
                    PING
=========================================================
*/

async function handlePing(
  sock,
  jid,
  msg
) {
  const start =
    Date.now();

  try {
    await sock.sendMessage(
      jid,
      {
        text:
          "🏓 *Pinging...*"
      },
      {
        quoted: msg
      }
    );

    const ms =
      Date.now() - start;

    await sock.sendMessage(
      jid,
      {
        text:
`🏓 *PONG!*

⚡ Response: ${ms} ms
🟢 Status: Online
🤖 DIMUWA MINI BOT
👑 Creator: Dimuth sathsara`
      }
    );
  } catch (error) {
    logger.error({
      error: error.message
    }, "Ping failed.");
  }
}

/*
=========================================================
                    URL HELPERS
=========================================================
*/

function extractHttpUrl(text) {
  const match =
    String(text || "").match(
      /https?:\/\/[^\s<>"']+/i
    );

  if (!match) {
    return null;
  }

  return match[0]
    .replace(/[),.!?]+$/g, "");
}

function isSupportedDownloaderUrl(
  url
) {
  try {
    const parsed =
      new URL(url);

    const host =
      parsed.hostname
        .toLowerCase()
        .replace(/^www\./, "");

    return (
      host.includes("tiktok.com") ||
      host === "vm.tiktok.com" ||
      host === "vt.tiktok.com" ||

      host.includes("facebook.com") ||
      host === "fb.watch" ||

      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be"
    );
  } catch {
    return false;
  }
}

function extractDownloaderUrl(
  text
) {
  const value =
    String(text || "").trim();

  const shortcut =
    value.match(
      /^\.(yt|tt|fb)\s+(https?:\/\/\S+)/i
    );

  if (shortcut) {
    const url =
      shortcut[2]
        .replace(/[),.!?]+$/g, "");

    if (
      isSupportedDownloaderUrl(
        url
      )
    ) {
      return url;
    }

    return null;
  }

  const url =
    extractHttpUrl(value);

  if (
    url &&
    isSupportedDownloaderUrl(url)
  ) {
    return url;
  }

  return null;
}

/*
=========================================================
                    DOWNLOAD BINARY
=========================================================
*/

function downloadFile(
  url,
  destination
) {
  return new Promise(
    (resolve, reject) => {
      const client =
        url.startsWith("https")
          ? https
          : http;

      const request =
        client.get(
          url,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0"
            }
          },
          response => {
            if (
              response.statusCode >=
                300 &&
              response.statusCode < 400 &&
              response.headers.location
            ) {
              response.resume();

              return downloadFile(
                response.headers.location,
                destination
              )
                .then(resolve)
                .catch(reject);
            }

            if (
              response.statusCode !==
              200
            ) {
              response.resume();

              reject(
                new Error(
                  `HTTP ${response.statusCode}`
                )
              );

              return;
            }

            const file =
              fs.createWriteStream(
                destination
              );

            response.pipe(file);

            file.on(
              "finish",
              () => {
                file.close(resolve);
              }
            );

            file.on(
              "error",
              error => {
                file.destroy();

                reject(error);
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.setTimeout(
        120000,
        () => {
          request.destroy(
            new Error(
              "Download timeout."
            )
          );
        }
      );
    }
  );
}

/*
=========================================================
                    YT-DLP
=========================================================
*/

function getYtDlpPath() {
  return path.join(
    TOOLS_DIR,
    process.arch === "arm64"
      ? "yt-dlp_linux_aarch64"
      : "yt-dlp_linux"
  );
}

async function ensureYtDlp() {
  const binary =
    getYtDlpPath();

  try {
    await fsp.access(
      binary,
      fs.constants.X_OK
    );

    return binary;
  } catch {}
  
  const url =
    process.arch === "arm64"
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

  logger.info(
    `Downloading yt-dlp: ${url}`
  );

  const temp =
    `${binary}.download`;

  try {
    await fsp.rm(
      temp,
      {
        force: true
      }
    );

    await downloadFile(
      url,
      temp
    );

    await fsp.chmod(
      temp,
      0o755
    );

    await fsp.rename(
      temp,
      binary
    );

    return binary;
  } catch (error) {
    await fsp.rm(
      temp,
      {
        force: true
      }
    ).catch(() => {});

    throw error;
  }
}

async function hasFfmpeg() {
  try {
    await execFileAsync(
      "ffmpeg",
      ["-version"],
      {
        timeout: 10000
      }
    );

    return true;
  } catch {
    return false;
  }
}

function getDownloaderError(
  stderr,
  stdout
) {
  const combined =
    `${stderr || ""}\n${stdout || ""}`;

  const lines =
    combined
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean)
      .filter(
        line =>
          !line.startsWith("[download]")
      );

  if (!lines.length) {
    return "Unable to download this URL.";
  }

  return lines
    .slice(-6)
    .join("\n")
    .slice(0, 1200);
}

async function runYtDlp(
  binary,
  args
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          binary,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        data => {
          stdout +=
            data.toString();

          if (
            stdout.length > 30000
          ) {
            stdout =
              stdout.slice(-30000);
          }
        }
      );

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();

          if (
            stderr.length > 30000
          ) {
            stderr =
              stderr.slice(-30000);
          }
        }
      );

      const timeout =
        setTimeout(() => {
          child.kill("SIGKILL");

          reject(
            new Error(
              "yt-dlp timeout."
            )
          );
        }, 180000);

      child.on(
        "error",
        error => {
          clearTimeout(timeout);
          reject(error);
        }
      );

      child.on(
        "close",
        code => {
          clearTimeout(timeout);

          if (code === 0) {
            resolve({
              stdout,
              stderr
            });

            return;
          }

          reject(
            new Error(
              getDownloaderError(
                stderr,
                stdout
              )
            )
          );
        }
      );
    }
  );
}

/*
=========================================================
                    SOCIAL DOWNLOADER
=========================================================
*/

async function downloadSocialMedia(
  url
) {
  const binary =
    await ensureYtDlp();

  const jobId =
    `${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 9)}`;

  const jobDir =
    path.join(
      MEDIA_DIR,
      jobId
    );

  await fsp.mkdir(
    jobDir,
    {
      recursive: true
    }
  );

  const outputTemplate =
    path.join(
      jobDir,
      "%(title).80s_[%(id)s].%(ext)s"
    );

  try {
    const ffmpeg =
      await hasFfmpeg();

    /*
    If ffmpeg exists:
      best video + best audio
    Otherwise:
      progressive mp4 first

    This avoids asking yt-dlp to merge
    streams when ffmpeg is unavailable.
    */

    let format;

    if (ffmpeg) {
      format =
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b";
    } else {
      format =
        "b[ext=mp4]/b";
    }

    const args = [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",

      "--restrict-filenames",

      "--geo-bypass",

      "--no-overwrites",

      "--retries",
      "3",

      "--fragment-retries",
      "3",

      "--extractor-retries",
      "3",

      "--socket-timeout",
      "30",

      "--max-filesize",
      "100M",

      "--check-formats",

      "-f",
      format,

      "-o",
      outputTemplate,

      "--print",
      "after_move:filepath",

      url
    ];

    const result =
      await runYtDlp(
        binary,
        args
      );

    const lines =
      result.stdout
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);

    let filePath = null;

    for (
      let i = lines.length - 1;
      i >= 0;
      i--
    ) {
      const candidate =
        lines[i];

      if (
        candidate.startsWith(
          jobDir
        ) &&
        fs.existsSync(
          candidate
        )
      ) {
        filePath =
          candidate;

        break;
      }
    }

    if (!filePath) {
      const files =
        await fsp.readdir(
          jobDir
        );

      const mediaFile =
        files.find(
          file =>
            /\.(mp4|mkv|webm|mov|avi|m4v|mp3|m4a|aac|ogg|wav)$/i
              .test(file)
        );

      if (mediaFile) {
        filePath =
          path.join(
            jobDir,
            mediaFile
          );
      }
    }

    if (!filePath) {
      throw new Error(
        "Download completed but output file was not found."
      );
    }

    const stat =
      await fsp.stat(
        filePath
      );

    if (stat.size > 100 * 1024 * 1024) {
      throw new Error(
        "Downloaded file is larger than 100 MB."
      );
    }

    return {
      filePath,
      jobDir
    };
  } catch (error) {
    await fsp.rm(
      jobDir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});

    throw error;
  }
}

/*
=========================================================
                    SEND DOWNLOADED FILE
=========================================================
*/

function getMimeType(
  filePath
) {
  const ext =
    path.extname(filePath)
      .toLowerCase();

  const map = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".m4v": "video/mp4",

    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav"
  };

  return (
    map[ext] ||
    "application/octet-stream"
  );
}

function isAudioFile(
  filePath
) {
  return /\.(mp3|m4a|aac|ogg|wav)$/i
    .test(filePath);
}

function isVideoFile(
  filePath
) {
  return /\.(mp4|mkv|webm|mov|avi|m4v)$/i
    .test(filePath);
}

async function sendDownloadedFile(
  sock,
  jid,
  filePath,
  quoted
) {
  const buffer =
    await fsp.readFile(
      filePath
    );

  const mime =
    getMimeType(filePath);

  const fileName =
    path.basename(filePath);

  if (
    isAudioFile(filePath)
  ) {
    return await sock.sendMessage(
      jid,
      {
        audio: buffer,
        mimetype: mime,
        ptt: false
      },
      {
        quoted
      }
    );
  }

  if (
    isVideoFile(filePath)
  ) {
    return await sock.sendMessage(
      jid,
      {
        video: buffer,
        mimetype: mime,
        fileName
      },
      {
        quoted
      }
    );
  }

  return await sock.sendMessage(
    jid,
    {
      document: buffer,
      mimetype: mime,
      fileName
    },
    {
      quoted
    }
  );
}

/*
=========================================================
                    DOWNLOAD COMMAND
=========================================================
*/

async function handleDownloader(
  sock,
  jid,
  msg,
  url
) {
  const jobKey =
    `${jid}:${url}`;

  if (
    downloadJobs.has(jobKey)
  ) {
    await sock.sendMessage(
      jid,
      {
        text:
          "⏳ This URL is already downloading."
      },
      {
        quoted: msg
      }
    );

    return;
  }

  downloadJobs.set(
    jobKey,
    Date.now()
  );

  try {
    await sock.sendMessage(
      jid,
      {
        text:
`⏳ *DOWNLOADING...*

🔗 ${url}

Please wait...`
      },
      {
        quoted: msg
      }
    );

    const result =
      await downloadSocialMedia(
        url
      );

    await sendDownloadedFile(
      sock,
      jid,
      result.filePath,
      msg
    );

    await sock.sendMessage(
      jid,
      {
        text:
          "✅ *Download completed.*"
      }
    );

    await fsp.rm(
      result.jobDir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});
  } catch (error) {
    logger.error({
      url,
      error: error.message
    }, "Downloader failed.");

    await sock.sendMessage(
      jid,
      {
        text:
`❌ *DOWNLOAD FAILED*

${error.message}

💡 Make sure the link is:
• Public
• Valid
• Not login/private
• Not age/region restricted`
      },
      {
        quoted: msg
      }
    );
  } finally {
    downloadJobs.delete(
      jobKey
    );
  }
}

/*
=========================================================
                    WELCOME
=========================================================
*/

async function sendDimuwaWelcome(
  sock,
  username
) {
  try {
    const ownerJid =
      getOwnerJid(sock);

    if (!ownerJid) {
      return;
    }

    const welcomeText =
`👋 *WELCOME TO DIMUWA MINI BOT* 🤖 👑

🎉 Your bot has been successfully connected!

┌──「 🤖 BOT INFO 」──┐
│ 🤖 Name: DIMUWA MINI BOT
│ 🟢 Status: Online
│ 👨‍💻 Creator: Dimuth sathsara
│ ⚙️ Prefix: [ . ]
└────────────────────┘

📢 *DIMUWA OFFICIAL CHANNEL*

Follow our WhatsApp Channel for:

• 🆕 Bot Updates
• ⚙️ New Features
• 📥 Downloader Updates
• 🔧 Maintenance News
• 🎁 Special Updates

🔗 ${DIMUWA_CHANNEL_URL}

💡 Type *.menu* to open the bot menu.

👑 Created by DIMUTH SATHSARA`;

    await sock.sendMessage(
      ownerJid,
      {
        text: welcomeText
      }
    );

    logger.info({
      username
    }, "Welcome message sent.");
  } catch (error) {
    logger.error({
      error: error.message
    }, "Welcome message failed.");
  }
}

/*
=========================================================
                    CHANNEL FOLLOW
=========================================================
*/

async function followDimuwaChannel(
  sock
) {
  try {
    if (
      typeof sock.newsletterMetadata !==
      "function" ||
      typeof sock.newsletterFollow !==
      "function"
    ) {
      logger.warn(
        "Newsletter/channel API is not available in this Baileys build."
      );

      return false;
    }

    const metadata =
      await sock.newsletterMetadata(
        "invite",
        DIMUWA_CHANNEL_INVITE
      );

    const channelJid =
      metadata?.id ||
      metadata?.jid ||
      metadata?.newsletterJid;

    if (!channelJid) {
      logger.warn(
        "Could not resolve DIMUWA channel JID."
      );

      return false;
    }

    await sock.newsletterFollow(
      channelJid
    );

    logger.info({
      channelJid
    }, "DIMUWA channel follow attempted.");

    return true;
  } catch (error) {
    logger.error({
      error: error.message
    }, "DIMUWA channel follow failed.");

    return false;
  }
}

/*
=========================================================
                    MESSAGE HANDLER
=========================================================
*/

async function handleMessage(
  username,
  sock,
  msg
) {
  if (!msg?.message) {
    return;
  }

  const jid =
    msg.key?.remoteJid;

  if (!jid) {
    return;
  }

  /*
  Status
  */
  if (
    jid === "status@broadcast"
  ) {
    await handleStatus(
      sock,
      username,
      msg
    );

    return;
  }

  /*
  Cache for anti-delete
  */
  cacheMessage(
    username,
    msg
  );

  /*
  Statistics
  */
  const count =
    messageStats.get(username) ||
    0;

  messageStats.set(
    username,
    count + 1
  );

  /*
  Auto read
  */
  await markReadIfEnabled(
    sock,
    username,
    msg
  );

  /*
  Bot power
  */
  if (
    !isBotPowerOn(username)
  ) {
    return;
  }

  /*
  Permission
  */
  if (
    !canProcessMessage(
      sock,
      username,
      msg
    )
  ) {
    return;
  }

  const text =
    getMessageText(msg);

  /*
  Media can still be used by .save
  even if text exists.
  */
  if (!text) {
    return;
  }

  const lower =
    text.toLowerCase().trim();

  /*
  Composing
  */
  const settings =
    getSettings(username);

  if (
    settings.composing === "ON"
  ) {
    await sendComposing(
      sock,
      jid,
      true
    );
  }

  /*
  Download URL
  */
  const downloaderUrl =
    extractDownloaderUrl(text);

  if (downloaderUrl) {
    await handleDownloader(
      sock,
      jid,
      msg,
      downloaderUrl
    );

    return;
  }

  /*
  MENU
  */
  if (
    lower === ".menu" ||
    lower === "menu"
  ) {
    await sendMenu(
      sock,
      username,
      jid
    );

    return;
  }

  /*
  SETTINGS
  */
  if (
    lower === ".settings" ||
    lower === "settings"
  ) {
    await sock.sendMessage(
      jid,
      {
        text:
          settingsText(username)
      },
      {
        quoted: msg
      }
    );

    return;
  }

  /*
  SETTINGS CODE
  */
  const settingResult =
    processSettingsCode(
      username,
      text
    );

  if (
    settingResult
  ) {
    await sock.sendMessage(
      jid,
      {
        text:
`✅ *SETTING UPDATED*

⚙️ ${settingResult.key}
➡️ ${settingResult.value}`
      },
      {
        quoted: msg
      }
    );

    await applyOnlinePresence(
      sock,
      username
    );

    return;
  }

  if (
    settingResult === false
  ) {
    /*
    It looked like a setting code
    but was invalid.
    */
    if (
      /^\d{1,2}\.\d$/.test(
        text.trim()
      )
    ) {
      await sock.sendMessage(
        jid,
        {
          text:
            "❌ Invalid settings code.\n\nUse *.settings* to view the codes."
        },
        {
          quoted: msg
        }
      );

      return;
    }
  }

  /*
  PING
  */
  if (
    lower === ".ping" ||
    lower === "ping"
  ) {
    await handlePing(
      sock,
      jid,
      msg
    );

    return;
  }

  /*
  VV
  */
  if (
    lower === ".vv" ||
    lower === "vv"
  ) {
    await handleViewOnce(
      sock,
      username,
      jid,
      msg
    );

    return;
  }

  /*
  SAVE
  */
  if (
    lower === ".save" ||
    lower === "save"
  ) {
    await handleSave(
      sock,
      username,
      jid,
      msg
    );

    return;
  }

  /*
  TAG ALL
  */
  if (
    lower === ".tagall"
  ) {
    await handleTagAll(
      sock,
      jid,
      msg
    );

    return;
  }

  /*
  FUN
  */
  if (
    await handleFunCommand(
      sock,
      jid,
      lower,
      msg
    )
  ) {
    return;
  }

  /*
  MENU NUMBERS
  */
  if (
    /^[1-6]$/.test(
      lower
    )
  ) {
    await handleMenuNumber(
      sock,
      username,
      jid,
      lower,
      msg
    );

    return;
  }

  /*
  HELP
  */
  if (
    lower === ".help" ||
    lower === "help"
  ) {
    await sendMenu(
      sock,
      username,
      jid
    );

    return;
  }

  /*
  OWNER COMMANDS
  */
  if (
    lower === ".owner"
  ) {
    await sock.sendMessage(
      jid,
      {
        text:
`👑 *DIMUWA MINI BOT OWNER*

👨‍💻 Creator: ${CREATOR_NAME}
📱 Contact: ${CREATOR_PHONE}

🤖 DIMUWA MINI BOT`
      },
      {
        quoted: msg
      }
    );

    return;
  }

  /*
  Logout
  */
  if (
    lower === ".logout" ||
    lower === ".unlink"
  ) {
    if (
      !isOwnerMessage(
        sock,
        msg
      )
    ) {
      await sock.sendMessage(
        jid,
        {
          text:
            "❌ Owner only."
        },
        {
          quoted: msg
        }
      );

      return;
    }

    await sock.sendMessage(
      jid,
      {
        text:
          "⏳ Logging out..."
      },
      {
        quoted: msg
      }
    );

    try {
      await sock.logout();
    } catch {}

    return;
  }

  /*
  Unknown command
  */
  if (
    lower.startsWith(".")
  ) {
    await sock.sendMessage(
      jid,
      {
        text:
`❌ *Unknown command*

Type *.menu* to see available commands.`
      },
      {
        quoted: msg
      }
    );
  }
}

/*
=========================================================
                    START BOT
=========================================================
*/

async function startBot(
  username,
  options = {}
) {
  if (
    bots.has(username) &&
    bots.get(username)?.sock
  ) {
    return bots.get(
      username
    ).sock;
  }

  const sessionPath =
    path.join(
      SESSION_DIR,
      `session_${username}`
    );

  await fsp.mkdir(
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

  const sock =
    makeWASocket({
      auth: state,

      logger,

      printQRInTerminal: false,

      browser: [
        "DIMUWA MINI BOT",
        "Chrome",
        "1.0.0"
      ],

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview:
        false,

      shouldIgnoreJid:
        jid =>
          jid === "status@broadcast"
    });

  const botState = {
    sock,
    username,
    connected: false,
    pairing: Boolean(
      options.pairing
    ),
    qr: null,
    presenceTimer: null
  };

  bots.set(
    username,
    botState
  );

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /*
  =======================================================
                    CONNECTION UPDATE
  =======================================================
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
          {
            qr,
            createdAt:
              Date.now()
          }
        );

        try {
          const dataUrl =
            await QRCode.toDataURL(
              qr
            );

          qrStore.set(
            username,
            {
              qr,
              dataUrl,
              createdAt:
                Date.now()
            }
          );
        } catch {}
      }

      if (
        connection ===
        "connecting"
      ) {
        logger.info({
          username
        }, "WhatsApp connecting...");
      }

      if (
        connection ===
        "open"
      ) {
        botState.connected =
          true;

        qrStore.delete(
          username
        );

        logger.info({
          username,
          phone:
            jidNumber(
              sock.user?.id
            )
        }, "DIMUWA BOT connected.");

        /*
        Presence
        */
        await applyOnlinePresence(
          sock,
          username
        );

        /*
        Channel follow attempt
        */
        await followDimuwaChannel(
          sock
        );

        /*
        Welcome
        */
        await sendDimuwaWelcome(
          sock,
          username
        );

        /*
        Keep online
        */
        if (
          botState.presenceTimer
        ) {
          clearInterval(
            botState.presenceTimer
          );
        }

        botState.presenceTimer =
          setInterval(
            async () => {
              try {
                const settings =
                  getSettings(
                    username
                  );

                if (
                  settings.alwaysOnline ===
                  "ON"
                ) {
                  await sock.sendPresenceUpdate(
                    "available"
                  );
                }
              } catch {}
            },
            4 * 60 * 1000
          );
      }

      if (
        connection ===
        "close"
      ) {
        botState.connected =
          false;

        if (
          botState.presenceTimer
        ) {
          clearInterval(
            botState.presenceTimer
          );

          botState.presenceTimer =
            null;
        }

        const statusCode =
          lastDisconnect
            ?.error?.output
            ?.statusCode;

        logger.warn({
          username,
          statusCode
        }, "WhatsApp connection closed.");

        bots.delete(
          username
        );

        /*
        Logged out:
        don't reconnect.
        */
        if (
          statusCode ===
          DisconnectReason.loggedOut
        ) {
          logger.warn({
            username
          }, "Session logged out.");

          return;
        }

        /*
        Restart/reconnect.
        */
        setTimeout(
          () => {
            startBot(
              username
            ).catch(
              error => {
                logger.error({
                  username,
                  error:
                    error.message
                }, "Reconnect failed.");
              }
            );
          },
          3000
        );
      }
    }
  );

  /*
  =======================================================
                    INCOMING MESSAGES
  =======================================================
  */

  sock.ev.on(
    "messages.upsert",
    async event => {
      if (
        event.type !==
        "notify"
      ) {
        return;
      }

      for (
        const msg of
        event.messages || []
      ) {
        try {
          await handleMessage(
            username,
            sock,
            msg
          );
        } catch (error) {
          logger.error({
            username,
            error:
              error.message
          }, "Message handler failed.");
        }
      }
    }
  );

  /*
  =======================================================
                    DELETE EVENTS
  =======================================================
  */

  sock.ev.on(
    "messages.delete",
    async event => {
      try {
        await handleDeletedMessages(
          username,
          sock,
          event
        );
      } catch (error) {
        logger.error({
          username,
          error:
            error.message
        }, "Delete event failed.");
      }
    }
  );

  return sock;
}

/*
=========================================================
                    QR ENDPOINT
=========================================================
*/

app.get(
  "/qr/:username",
  async (req, res) => {
    const username =
      String(
        req.params.username
      );

    const data =
      qrStore.get(
        username
      );

    if (!data) {
      return res.status(404)
        .json({
          ok: false,
          message:
            "QR not available."
        });
    }

    return res.json({
      ok: true,
      username,
      qr: data.qr,
      dataUrl:
        data.dataUrl || null,
      createdAt:
        data.createdAt
    });
  }
);

/*
=========================================================
                    BOT STATUS
=========================================================
*/

app.get(
  "/status/:username",
  async (req, res) => {
    const username =
      String(
        req.params.username
      );

    const bot =
      bots.get(
        username
      );

    return res.json({
      ok: true,
      username,

      connected:
        Boolean(
          bot?.connected
        ),

      phone:
        bot?.sock?.user?.id
          ? jidNumber(
              bot.sock.user.id
            )
          : null,

      messages:
        messageStats.get(
          username
        ) || 0,

      settings:
        getSettings(
          username
        )
    });
  }
);

/*
=========================================================
                    PAIRING CODE
=========================================================
*/

app.post(
  "/get-pairing-code",
  async (req, res) => {
    try {
      const phone =
        normalizePhone(
          req.body?.phone ||
          req.body?.number ||
          ""
        );

      const username =
        String(
          req.body?.username ||
          phone
        )
        .replace(
          /[^a-zA-Z0-9_-]/g,
          "_"
        );

      if (
        !phone
      ) {
        return res.status(400)
          .json({
            ok: false,
            message:
              "Phone number required."
          });
      }

      let sock =
        bots.get(
          username
        )?.sock;

      if (!sock) {
        sock =
          await startBot(
            username,
            {
              pairing: true
            }
          );
      }

      await sleep(1200);

      const code =
        await sock.requestPairingCode(
          phone
        );

      return res.json({
        ok: true,
        username,
        phone,
        code
      });
    } catch (error) {
      logger.error({
        error:
          error.message
      }, "Pairing code failed.");

      return res.status(500)
        .json({
          ok: false,
          message:
            error.message
        });
    }
  }
);

/*
=========================================================
                    START BOT API
=========================================================
*/

app.post(
  "/start-bot",
  async (req, res) => {
    try {
      const username =
        String(
          req.body?.username ||
          ""
        )
        .trim()
        .replace(
          /[^a-zA-Z0-9_-]/g,
          "_"
        );

      if (!username) {
        return res.status(400)
          .json({
            ok: false,
            message:
              "Username required."
          });
      }

      await startBot(
        username
      );

      return res.json({
        ok: true,
        username,
        message:
          "Bot started."
      });
    } catch (error) {
      return res.status(500)
        .json({
          ok: false,
          message:
            error.message
        });
    }
  }
);

/*
=========================================================
                    LOGOUT API
=========================================================
*/

app.post(
  "/logout/:username",
  async (req, res) => {
    const username =
      String(
        req.params.username
      );

    const bot =
      bots.get(
        username
      );

    try {
      if (
        bot?.sock
      ) {
        try {
          await bot.sock.logout();
        } catch {}
      }

      bots.delete(
        username
      );

      qrStore.delete(
        username
      );

      const sessionPath =
        path.join(
          SESSION_DIR,
          `session_${username}`
        );

      await fsp.rm(
        sessionPath,
        {
          recursive: true,
          force: true
        }
      );

      return res.json({
        ok: true,
        message:
          "Logged out."
      });
    } catch (error) {
      return res.status(500)
        .json({
          ok: false,
          message:
            error.message
        });
    }
  }
);

/*
=========================================================
                    RESTORE SESSIONS
=========================================================
*/

async function restoreSessions() {
  try {
    const entries =
      await fsp.readdir(
        SESSION_DIR,
        {
          withFileTypes: true
        }
      );

    for (
      const entry of entries
    ) {
      if (
        !entry.isDirectory()
      ) {
        continue;
      }

      if (
        !entry.name.startsWith(
          "session_"
        )
      ) {
        continue;
      }

      const username =
        entry.name.slice(
          "session_".length
        );

      if (!username) {
        continue;
      }

      logger.info({
        username
      }, "Restoring bot session...");

      try {
        await startBot(
          username
        );

        await sleep(500);
      } catch (error) {
        logger.error({
          username,
          error:
            error.message
        }, "Session restore failed.");
      }
    }
  } catch (error) {
    logger.error({
      error:
        error.message
    }, "Restore sessions failed.");
  }
}

/*
=========================================================
                    CLEAN OLD MEDIA
=========================================================
*/

async function cleanMediaDirectory() {
  try {
    const entries =
      await fsp.readdir(
        MEDIA_DIR,
        {
          withFileTypes: true
        }
      );

    const now =
      Date.now();

    for (
      const entry of entries
    ) {
      const fullPath =
        path.join(
          MEDIA_DIR,
          entry.name
        );

      try {
        const stat =
          await fsp.stat(
            fullPath
          );

        const age =
          now -
          stat.mtimeMs;

        /*
        Delete temporary files
        older than 6 hours.
        */
        if (
          age >
          6 * 60 * 60 * 1000
        ) {
          await fsp.rm(
            fullPath,
            {
              recursive: true,
              force: true
            }
          );
        }
      } catch {}
    }
  } catch {}
}

/*
=========================================================
                    SERVER START
=========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    logger.info(
      `DIMUWA MINI BOT server running on port ${PORT}`
    );

    logger.info(
      `DATA_DIR: ${DATA_DIR}`
    );

    logger.info(
      `SESSION_DIR: ${SESSION_DIR}`
    );

    logger.info(
      `MEDIA_DIR: ${MEDIA_DIR}`
    );

    await cleanMediaDirectory();

    await restoreSessions();
  }
);

/*
=========================================================
                    PERIODIC CLEANUP
=========================================================
*/

setInterval(
  () => {
    cleanMediaDirectory()
      .catch(() => {});
  },
  60 * 60 * 1000
);

/*
=========================================================
                    PROCESS EVENTS
=========================================================
*/

process.on(
  "unhandledRejection",
  error => {
    logger.error({
      error:
        error?.message ||
        String(error)
    }, "Unhandled rejection.");
  }
);

process.on(
  "uncaughtException",
  error => {
    logger.error({
      error:
        error?.message ||
        String(error)
    }, "Uncaught exception.");
  }
);

process.on(
  "SIGTERM",
  async () => {
    logger.info(
      "SIGTERM received."
    );

    for (
      const [
        username,
        bot
      ] of bots.entries()
    ) {
      try {
        if (
          bot.presenceTimer
        ) {
          clearInterval(
            bot.presenceTimer
          );
        }

        logger.info({
          username
        }, "Stopping bot.");
      } catch {}
    }

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  async () => {
    process.exit(0);
  }
);
