"use strict";

/*

DIMUWA MINI BOT VERSION 5.0.0 

========================================================

Features:

WhatsApp Pairing Code

WhatsApp QR

Persistent sessions

Persistent settings

Persistent statistics

.menu

.alive

.status

.settings

Settings code system

.vv

.save

TikTok downloader

YouTube downloader

Facebook downloader

Auto Read

Always Online

Composing

Status Read

Status Reaction

Random Status Reaction

Anti Delete

Same Chat / My Inbox targets

Public / Private / Inbox modes

Bot Power

Railway compatible

No yt-dlp-exec dependency

Standalone yt-dlp downloaded at runtime

IMPORTANT:
Use Railway Volume mounted at:
/app/data

The application uses DATA_DIR for persistent data.

*/

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const {
default: makeWASocket,
useMultiFileAuthState,
DisconnectReason,
Browsers,
downloadMediaMessage,
getContentType,
normalizeMessageContent
} = require("@whiskeysockets/baileys");

/* =====================================================
APP CONFIG
===================================================== */

const PORT = Number(process.env.PORT || 3000);

const DATA_DIR =
process.env.DATA_DIR ||
process.env.RAILWAY_VOLUME_MOUNT_PATH ||
path.join(__dirname, "data");

const SESSION_DIR = path.join(DATA_DIR, "sessions");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const TOOLS_DIR = path.join(DATA_DIR, "tools");

const SETTINGS_FILE = path.join(
DATA_DIR,
"settings.json"
);

const STATS_FILE = path.join(
DATA_DIR,
"stats.json"
);

const LOG_LEVEL =
process.env.LOG_LEVEL || "info";

const DIMUWA_CHANNEL_INVITE =
  "0029VbDZDmx4inoi10evlP1M";

const DIMUWA_CHANNEL_URL =
  "https://whatsapp.com/channel/0029VbDZDmx4inoi10evlP1M";

const logger = pino({
level: LOG_LEVEL
});

/* =====================================================
EXPRESS
===================================================== */

const app = express();

app.use(cors());

app.use(express.json({
limit: "2mb"
}));

app.use(express.urlencoded({
extended: true
}));

app.use(express.static(__dirname));

/* =====================================================
DIRECTORIES
===================================================== */

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

/* =====================================================
DEFAULT SETTINGS
===================================================== */

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

/* =====================================================
IN-MEMORY STORAGE
===================================================== */

const bots = new Map();

const startingBots = new Map();

const qrStore = new Map();

const pairingStore = new Map();

const messageCache = new Map();

const MAX_MESSAGE_CACHE = 1000;

const CACHE_TTL =
60 * 60 * 1000;

const statusReactList = [
"❤️",
"💚",
"💙",
"💛",
"🤍",
"🧡",
"💜",
"🩷",
"🔥",
"😂",
"😍",
"😮",
"👍"
];

/* =====================================================
JSON STORAGE HELPERS
===================================================== */

function readJson(file, fallback) {

try {

if (!fs.existsSync(file)) { return fallback; } const raw = fs.readFileSync( file, "utf8" ); if (!raw.trim()) { return fallback; } return JSON.parse(raw); 

} catch (error) {

logger.error({ error: error.message, file }, "JSON read error"); return fallback; 

}
}

function writeJson(file, data) {

try {

const temp = `${file}.tmp`; fs.writeFileSync( temp, JSON.stringify( data, null, 2 ), "utf8" ); fs.renameSync( temp, file ); 

} catch (error) {

logger.error({ error: error.message, file }, "JSON write error"); 

}

}

const settingsDB =
readJson(
SETTINGS_FILE,
{}
);

const statsDB =
readJson(
STATS_FILE,
{}
);

/* =====================================================
USERNAME HELPERS
===================================================== */

function cleanUsername(username) {

return String(
username || "default"
)
.trim()
.replace(
/[^a-zA-Z0-9_-]/g,
"_"
)
.slice(0, 60) || "default";
}

function sessionPath(username) {

return path.join(
SESSION_DIR,
`session_${cleanUsername(username)}`
);
}

function getSettings(username) {

const key =
cleanUsername(username);

if (!settingsDB[key]) {

settingsDB[key] = { ...DEFAULT_SETTINGS }; writeJson( SETTINGS_FILE, settingsDB ); 

}

return settingsDB[key];
}

function saveSettings(
username,
settings
) {

const key =
cleanUsername(username);

settingsDB[key] = {
...DEFAULT_SETTINGS,
...settings
};

writeJson(
SETTINGS_FILE,
settingsDB
);
}

function getStats(username) {

const key =
cleanUsername(username);

if (!statsDB[key]) {

statsDB[key] = { messages: 0, commands: 0, downloads: 0, startedAt: Date.now(), connectedAt: null, lastSeen: null }; writeJson( STATS_FILE, statsDB ); 

}

return statsDB[key];
}

function saveStats() {

writeJson(
STATS_FILE,
statsDB
);
}

/* =====================================================
BOT STATUS
===================================================== */

function isConnected(sock) {

return !!(
sock &&
sock.user &&
sock.user.id
);
}

function getBot(username) {

return bots.get(
cleanUsername(username)
);
}

function getOwnerJid(sock) {

if (!sock?.user?.id) {
return null;
}

return sock.user.id;
}

function jidNumber(jid) {

if (!jid) {
return "";
}

return String(jid)
.split("@")[0]
.split(":")[0]
.replace(/\D/g, "");
}

function jidFromPhone(phone) {

const number =
String(phone || "")
.replace(/\D/g, "");

if (!number) {
return null;
}

return `${number}@s.whatsapp.net`;
}

function normalizePhone(phone) {

return String(
phone || ""
)
.replace(/\D/g, "")
.replace(/^00/, "");
}

/* =====================================================
STAT HELPERS
===================================================== */

function incrementStat(
username,
field,
amount = 1
) {

const stats =
getStats(username);

stats[field] =
Number(stats[field] || 0)
+ amount;

saveStats();
}

/* =====================================================
MESSAGE CACHE
===================================================== */

function cacheKey(key) {

if (!key) {
return null;
}

return [
key.remoteJid || "",
key.id || "",
key.participant || ""
].join(":");
}

function cacheMessage(msg) {

if (
!msg ||
!msg.key ||
!msg.message
) {
return;
}

const key =
cacheKey(msg.key);

if (!key) {
return;
}

messageCache.set(
key,
{
message: msg,
savedAt: Date.now()
}
);

if (
messageCache.size >
MAX_MESSAGE_CACHE
) {

const first = messageCache.keys().next().value; if (first) { messageCache.delete(first); } 

}
}

function getCachedMessage(key) {

const item =
messageCache.get(
cacheKey(key)
);

if (!item) {
return null;
}

if (
Date.now() -
item.savedAt >
CACHE_TTL
) {

messageCache.delete( cacheKey(key) ); return null; 

}

return item.message;
}

/* =====================================================
CLEAN OLD CACHE
===================================================== */

setInterval(() => {

const now =
Date.now();

for (
const [key, item]
of messageCache
) {

if ( now - item.savedAt > CACHE_TTL ) { messageCache.delete(key); } 

}

}, 10 * 60 * 1000);

/* =====================================================
MESSAGE TEXT
===================================================== */

function getMessageText(msg) {

if (!msg?.message) {
return "";
}

const message =
normalizeMessageContent(
msg.message
) || msg.message;

if (
message.conversation
) {

return message.conversation; 

}

if (
message.extendedTextMessage
?.text
) {

return message .extendedTextMessage .text; 

}

if (
message.imageMessage
?.caption
) {

return message .imageMessage .caption; 

}

if (
message.videoMessage
?.caption
) {

return message .videoMessage .caption; 

}

if (
message.documentMessage
?.caption
) {

return message .documentMessage .caption; 

}

return "";
}

/* =====================================================
GROUP / PRIVATE
===================================================== */

function isGroupJid(jid) {

return String(jid || "")
.endsWith("@g.us");
}

function isStatusJid(jid) {

return jid ===
"status@broadcast";
}

/* =====================================================
BOT MODE
===================================================== */

function canProcessMessage(
sock,
username,
msg
) {

const settings =
getSettings(username);

const remoteJid =
msg.key?.remoteJid;

if (!remoteJid) {
return false;
}

if (
settings.botPower !== "ON"
) {
return false;
}

const mode =
String(
settings.botMode || "PUBLIC"
).toUpperCase();

if (mode === "PUBLIC") {
return true;
}

if (mode === "PRIVATE") {

const owner = getOwnerJid(sock); if (!owner) { return false; } return ( msg.key?.fromMe || remoteJid === owner ); 

}

if (mode === "INBOX") {

return !isGroupJid( remoteJid ); 

}

return true;
}

/* =====================================================
SETTINGS MENU
===================================================== */

function settingsMenu(username) {

const s =
getSettings(username);

return `⚙️ DIMUWA MINI BOT SETTINGS
│ Reply with the code below to update

• PRESENCE & SCOPE •

Always Online [ ${s.alwaysOnline} ]
│ 1.1 Enable • 1.2 Disable

Auto Read [ ${s.autoRead} ]
│ 2.1 Enable • 2.2 Disable

Bot Mode [ ${s.botMode} ]
│ 3.1 Public • 3.2 Private • 3.3 Inbox

• AUTOMATIONS & STATUS •

Status Read [ ${s.statusRead} ]
│ 4.1 Enable • 4.2 Disable

Status React [ ${s.statusReact} ]
│ 5.1 Green • 5.2 Random • 5.3 Off

Composing [ ${s.composing} ]
│ 7.1 Enable • 7.2 Disable

• SECURITY & SYSTEM •

Anti-Delete [ ${s.antiDelete} ]
│ 9.1 Enable • 9.2 Disable

Anti-Del Target [ ${s.antiDelTarget} ]
│ 10.1 Same Chat • 10.2 My Inbox

View Once (.vv) Target [ ${s.vvTarget} ]
│ 11.1 Same Chat • 11.2 My Inbox

Save (.save) Target [ ${s.saveTarget} ]
│ 12.1 Same Chat • 12.2 My Inbox

Bot Power [ ${s.botPower} ]
│ 13.1 Turn ON • 13.2 Turn Off

© CREATOR BY DIMUTH SATHSARA`;
}

/* =====================================================
SETTINGS CODE PROCESSOR
===================================================== */

async function processSettingsCode(
sock,
username,
msg,
code
) {

const owner =
getOwnerJid(sock);

const sender =
msg.key?.participant ||
msg.key?.remoteJid;

const isOwner =
!!owner &&
(
msg.key?.fromMe ||
sender === owner ||
jidNumber(sender) ===
jidNumber(owner)
);

if (!isOwner) {

await sock.sendMessage( msg.key.remoteJid, { text: "❌ Only bot owner can change settings." } ); return true; 

}

const s =
getSettings(username);

let changed = false;
let message = "";

switch (code) {

case "1.1": s.alwaysOnline = "ON"; changed = true; message = "Always Online → ON"; break; case "1.2": s.alwaysOnline = "OFF"; changed = true; message = "Always Online → OFF"; break; case "2.1": s.autoRead = "ON"; changed = true; message = "Auto Read → ON"; break; case "2.2": s.autoRead = "OFF"; changed = true; message = "Auto Read → OFF"; break; case "3.1": s.botMode = "PUBLIC"; changed = true; message = "Bot Mode → PUBLIC"; break; case "3.2": s.botMode = "PRIVATE"; changed = true; message = "Bot Mode → PRIVATE"; break; case "3.3": s.botMode = "INBOX"; changed = true; message = "Bot Mode → INBOX"; break; case "4.1": s.statusRead = "ON"; changed = true; message = "Status Read → ON"; break; case "4.2": s.statusRead = "OFF"; changed = true; message = "Status Read → OFF"; break; case "5.1": s.statusReact = "GREEN"; changed = true; message = "Status React → GREEN 💚"; break; case "5.2": s.statusReact = "RANDOM"; changed = true; message = "Status React → RANDOM 🎲"; break; case "5.3": s.statusReact = "OFF"; changed = true; message = "Status React → OFF"; break; case "7.1": s.composing = "ON"; changed = true; message = "Composing → ON"; break; case "7.2": s.composing = "OFF"; changed = true; message = "Composing → OFF"; break; case "9.1": s.antiDelete = "ON"; changed = true; message = "Anti-Delete → ON"; break; case "9.2": s.antiDelete = "OFF"; changed = true; message = "Anti-Delete → OFF"; break; case "10.1": s.antiDelTarget = "SAME"; changed = true; message = "Anti-Delete Target → SAME CHAT"; break; case "10.2": s.antiDelTarget = "PRIVATE"; changed = true; message = "Anti-Delete Target → MY INBOX"; break; case "11.1": s.vvTarget = "SAME"; changed = true; message = ".vv Target → SAME CHAT"; break; case "11.2": s.vvTarget = "PRIVATE"; changed = true; message = ".vv Target → MY INBOX"; break; case "12.1": s.saveTarget = "SAME"; changed = true; message = ".save Target → SAME CHAT"; break; case "12.2": s.saveTarget = "PRIVATE"; changed = true; message = ".save Target → MY INBOX"; break; case "13.1": s.botPower = "ON"; changed = true; message = "Bot Power → ON"; break; case "13.2": s.botPower = "OFF"; changed = true; message = "Bot Power → OFF"; break; default: return false; 

}

if (changed) {

saveSettings( username, s ); await sock.sendMessage( msg.key.remoteJid, { text: `✅ SETTING UPDATED\n\n${message}\n\nUse .settings to view current settings.` } ); if ( s.alwaysOnline === "ON" ) { await sock.sendPresenceUpdate( "available" ).catch(() => {}); } return true; 

}

return false;
}

/* =====================================================
COMMAND HELP
===================================================== */

function menuText() {

return `╭━━━〔 🤖 DIMUWA MINI BOT 〕━━━╮
┃
┃ 👑 Created by DIMUTH SATHSARA
┃
┃ 📌 BASIC
┃ • .menu
┃ • .alive
┃ • .status
┃ • .settings
┃
┃ 📥 MEDIA
┃ • Reply media + .vv
┃ • Reply media + .save
┃
┃ 📥 DOWNLOADER
┃ • TikTok URL
┃ • YouTube URL
┃ • Facebook URL
┃
┃ ⚙️ SETTINGS
┃ • Reply setting code
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function aliveText(username) {

const s =
getSettings(username);

return `╭━━〔 🟢 DIMUWA BOT ALIVE 〕━━╮
┃
┃ 🤖 Bot: ONLINE
┃ 👤 User: ${username}
┃ ⚡ Power: ${s.botPower}
┃ 📥 Mode: ${s.botMode}
┃
┃ © DIMUTH SATHSARA
╰━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function statusText(
username,
sock
) {

const s =
getSettings(username);

const stats =
getStats(username);

return `╭━━〔 📊 DIMUWA STATUS 〕━━╮
┃
┃ 🤖 Status: ${isConnected(sock) ? "CONNECTED" : "OFFLINE"}
┃ 👤 Username: ${username}
┃ 📱 Number: ${jidNumber(sock.user?.id) || "-"}
┃
┃ ⚙️ Bot Mode: ${s.botMode}
┃ 🔌 Bot Power: ${s.botPower}
┃ 👁 Auto Read: ${s.autoRead}
┃ 🟢 Always Online: ${s.alwaysOnline}
┃ 🗑 Anti Delete: ${s.antiDelete}
┃ 📱 .vv Target: ${s.vvTarget}
┃ 💾 .save Target: ${s.saveTarget}
┃
┃ 💬 Messages: ${stats.messages}
┃ ⚡ Commands: ${stats.commands}
┃ 📥 Downloads: ${stats.downloads}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`;
}

/* =====================================================
MEDIA HELPERS
===================================================== */

function getMediaInfo(
message
) {

if (!message) {
return null;
}

const normalized =
normalizeMessageContent(
message
) || message;

const type =
getContentType(
normalized
);

if (!type) {
return null;
}

const map = {
imageMessage: "image",
videoMessage: "video",
audioMessage: "audio",
documentMessage: "document",
stickerMessage: "sticker"
};

const mediaType =
map[type];

if (!mediaType) {
return null;
}

return {
type,
mediaType,
content: normalized[type]
};
}

/* =====================================================
QUOTED MESSAGE
===================================================== */

function getQuotedMessage(
msg
) {

if (!msg?.message) {
return null;
}

const message =
msg.message;

const type =
getContentType(message);

if (!type) {
return null;
}

const content =
message[type];

const context =
content?.contextInfo;

if (
!context?.quotedMessage ||
!context?.stanzaId
) {
return null;
}

const quotedRemoteJid =
context.remoteJid ||
msg.key.remoteJid;

const participant =
context.participant ||
quotedRemoteJid;

return {
key: {
remoteJid:
quotedRemoteJid,
fromMe:
jidNumber(participant) ===
jidNumber(msg.key.remoteJid) &&
!!msg.key.fromMe,
id:
context.stanzaId,
participant
},

message: context.quotedMessage 

};
}

/* =====================================================
MEDIA DOWNLOAD
===================================================== */

async function downloadWhatsAppMedia(
sock,
message
) {

const info =
getMediaInfo(
message.message
);

if (!info) {
throw new Error(
"No supported media found."
);
}

const buffer =
await downloadMediaMessage(
message,
"buffer",
{},
{
logger,
reuploadRequest:
async (m) => {
return sock.updateMediaMessage(m);
}
}
);

return {
buffer,
...info
};
}

/* =====================================================
SEND SAVED MEDIA
===================================================== */

async function sendWhatsAppMedia(
sock,
jid,
media
) {

const {
buffer,
mediaType,
content
} = media;

const caption =
content?.caption ||
"";

if (
!Buffer.isBuffer(buffer) ||
!buffer.length
) {
throw new Error(
"Media buffer is empty."
);
}

if (
buffer.length >
100 * 1024 * 1024
) {
throw new Error(
"Media is too large to send."
);
}

if (mediaType === "image") {

await sock.sendMessage( jid, { image: buffer, caption } ); return; 

}

if (mediaType === "video") {

await sock.sendMessage( jid, { video: buffer, caption } ); return; 

}

if (mediaType === "audio") {

await sock.sendMessage( jid, { audio: buffer, mimetype: content?.mimetype || "audio/mp4", ptt: !!content?.ptt } ); return; 

}

if (mediaType === "sticker") {

await sock.sendMessage( jid, { sticker: buffer } ); return; 

}

if (mediaType === "document") {

await sock.sendMessage( jid, { document: buffer, mimetype: content?.mimetype || "application/octet-stream", fileName: content?.fileName || "DIMUWA_FILE" } ); return; 

}

throw new Error(
"Unsupported media type."
);
}

/* =====================================================
.VV
===================================================== */

async function handleViewOnce(
sock,
username,
msg
) {

const quoted =
getQuotedMessage(msg);

if (!quoted) {

await sock.sendMessage( msg.key.remoteJid, { text: "❌ Reply to a View Once image/video/audio with .vv" } ); return; 

}

try {

const media = await downloadWhatsAppMedia( sock, quoted ); const settings = getSettings(username); const target = settings.vvTarget === "PRIVATE" ? getOwnerJid(sock) : msg.key.remoteJid; if (!target) { throw new Error( "Owner inbox is not available." ); } await sendWhatsAppMedia( sock, target, media ); await sock.sendMessage( msg.key.remoteJid, { text: "✅ View Once media saved successfully." } ); 

} catch (error) {

logger.error({ error: error.message }, ".vv error"); await sock.sendMessage( msg.key.remoteJid, { text: `❌ .vv failed\n\n${error.message}` } ); 

}
}

/* =====================================================
.SAVE
===================================================== */

async function handleSave(
sock,
username,
msg
) {

const quoted =
getQuotedMessage(msg);

const targetMessage =
quoted || msg;

try {

const media = await downloadWhatsAppMedia( sock, targetMessage ); const settings = getSettings(username); const target = settings.saveTarget === "PRIVATE" ? getOwnerJid(sock) : msg.key.remoteJid; if (!target) { throw new Error( "Owner inbox is not available." ); } await sendWhatsAppMedia( sock, target, media ); if ( target !== msg.key.remoteJid ) { await sock.sendMessage( msg.key.remoteJid, { text: "✅ Media saved to My Inbox." } ); } 

} catch (error) {

logger.error({ error: error.message }, ".save error"); await sock.sendMessage( msg.key.remoteJid, { text: `❌ .save failed\n\nReply to an image, video, audio, document or sticker.\n\n${error.message}` } ); 

}
}

/* =====================================================
YT-DLP STANDALONE
===================================================== */

function ytDlpBinaryName() {

if (
process.platform !==
"linux"
) {

throw new Error( "This Railway downloader is designed for Linux." ); 

}

if (
process.arch === "x64"
) {
return "yt-dlp_linux";
}

if (
process.arch === "arm64"
) {
return "yt-dlp_linux_aarch64";
}

throw new Error(
`Unsupported CPU architecture: ${process.arch}`
);
}

function ytDlpDownloadUrl() {

return (
"https://github.com/yt-dlp/yt-dlp/releases/latest/download/" +
ytDlpBinaryName()
);
}

function downloadFile(
url,
destination
) {

return new Promise(
(resolve, reject) => {

const request = https.get( url, { headers: { "User-Agent": "DIMUWA-MINI-BOT/5.0" } }, (response) => { if ( response.statusCode >= 300 && response.statusCode < 400 && response.headers.location ) { response.resume(); return downloadFile( response.headers.location, destination ) .then(resolve) .catch(reject); } if ( response.statusCode !== 200 ) { response.resume(); reject( new Error( `Download failed: HTTP ${response.statusCode}` ) ); return; } const file = fs.createWriteStream( destination ); response.pipe(file); file.on( "finish", () => { file.close( () => resolve() ); } ); file.on( "error", reject ); } ); request.on( "error", reject ); request.setTimeout( 120000, () => { request.destroy( new Error( "yt-dlp download timed out." ) ); } ); } 

);
}

async function ensureYtDlp() {

const binary =
path.join(
TOOLS_DIR,
"yt-dlp"
);

if (
fs.existsSync(binary)
) {

try { await fsp.access( binary, fs.constants.X_OK ); return binary; } catch { // Re-download. } 

}

const temp =
`${binary}.download`;

logger.info(
"Downloading standalone yt-dlp..."
);

await downloadFile(
ytDlpDownloadUrl(),
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

logger.info(
"Standalone yt-dlp ready."
);

return binary;
}

/* =====================================================
DOWNLOADER URL CHECK
===================================================== */

function extractHttpUrl(text) {

if (!text) {
return null;
}

const match =
text.match(
/https?:\/\/[^\s]+/i
);

if (!match) {
return null;
}

return match[0]
.replace(/[)>]+$/g, "");
}

function isSupportedDownloaderUrl(
url
) {

try {

const parsed = new URL(url); const host = parsed.hostname .toLowerCase() .replace(/^www\./, ""); return ( host.includes("tiktok.com") || host.includes("vm.tiktok.com") || host.includes("youtube.com") || host === "youtu.be" || host.includes("facebook.com") || host === "fb.watch" ); 

} catch {

return false; 

}
}

/* =====================================================
DOWNLOADER
===================================================== */

async function downloadSocialMedia(
username,
url
) {

const ytDlp =
await ensureYtDlp();

const jobId =
crypto
.randomBytes(8)
.toString("hex");

const outputTemplate =
path.join(
MEDIA_DIR,
`${jobId}.%(ext)s`
);

const args = [
"--no-playlist",
"--no-warnings",
"--no-progress",
"--restrict-filenames",
"--geo-bypass",
"--max-filesize",
"100M",

"-f", "best[ext=mp4]/best", "-o", outputTemplate, "--print", "after_move:filepath", url 

];

logger.info({
url
}, "Downloading media");

let stdout = "";
let stderr = "";

try {

const result = await execFileAsync( ytDlp, args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 } ); stdout = result.stdout || ""; stderr = result.stderr || ""; 

} catch (error) {

stdout = error.stdout || ""; stderr = error.stderr || ""; logger.error({ error: error.message, stderr }, "yt-dlp failed"); throw new Error( getDownloaderError( stderr || error.message ) ); 

}

const printed =
stdout
.split(/\r?\n/)
.map(
x => x.trim()
)
.filter(Boolean);

let outputFile =
printed.length
? printed[printed.length - 1]
: "";

if (
!outputFile ||
!fs.existsSync(outputFile)
) {

const candidates = await fsp.readdir( MEDIA_DIR ); const candidate = candidates .filter( name => name.startsWith( `${jobId}.` ) ) .map( name => path.join( MEDIA_DIR, name ) ) .find( file => fs.existsSync(file) ); outputFile = candidate || ""; 

}

if (
!outputFile ||
!fs.existsSync(outputFile)
) {

throw new Error( "Downloader completed but no media file was created." ); 

}

return outputFile;
}

function getDownloaderError(
text
) {

const value =
String(text || "");

if (
/private|login required|sign in/i
.test(value)
) {

return ( "This media is private or requires login." ); 

}

if (
/unsupported URL/i
.test(value)
) {

return ( "This URL is not supported." ); 

}

if (
/video unavailable|not available/i
.test(value)
) {

return ( "This video is unavailable." ); 

}

if (
/max-filesize/i
.test(value)
) {

return ( "The media is too large." ); 

}

return (
"Unable to download this media."
);
}

/* =====================================================
SEND DOWNLOADED FILE
===================================================== */

async function sendDownloadedFile(
sock,
jid,
file
) {

const stat =
await fsp.stat(file);

if (
stat.size >
100 * 1024 * 1024
) {

throw new Error( "Downloaded file is too large." ); 

}

const ext =
path.extname(file)
.toLowerCase();

const data =
await fsp.readFile(file);

const videoExts = [
".mp4",
".mkv",
".webm",
".mov",
".avi"
];

const audioExts = [
".mp3",
".m4a",
".aac",
".ogg",
".opus",
".wav",
".webm"
];

if (
videoExts.includes(ext) &&
ext !== ".webm"
) {

await sock.sendMessage( jid, { video: data, mimetype: ext === ".mp4" ? "video/mp4" : "video/*", caption: "✅ DIMUWA DOWNLOADER" } ); return; 

}

if (
audioExts.includes(ext) &&
ext !== ".webm"
) {

await sock.sendMessage( jid, { audio: data, mimetype: ext === ".mp3" ? "audio/mpeg" : "audio/mp4" } ); return; 

}

await sock.sendMessage(
jid,
{
document: data,
mimetype:
"application/octet-stream",
fileName:
path.basename(file)
}
);
}

/* =====================================================
HANDLE DOWNLOADER
===================================================== */

async function handleDownloader(
sock,
username,
msg,
text
) {

const url =
extractHttpUrl(text);

if (
!url ||
!isSupportedDownloaderUrl(url)
) {
return false;
}

try {

await sock.sendMessage( msg.key.remoteJid, { text: "⏳ Downloading media...\nPlease wait." } ); const file = await downloadSocialMedia( username, url ); await sendDownloadedFile( sock, msg.key.remoteJid, file ); incrementStat( username, "downloads" ); await fsp.unlink( file ).catch(() => {}); 

} catch (error) {

logger.error({ error: error.message, url }, "Downloader error"); await sock.sendMessage( msg.key.remoteJid, { text: `❌ Download failed\n\n${error.message}` } ); 

}

return true;
}

/* =====================================================
ANTI DELETE
===================================================== */

async function handleDeletedMessages(
username,
sock,
deletedKeys
) {

const settings =
getSettings(username);

if (
settings.antiDelete !== "ON"
) {
return;
}

if (!Array.isArray(
deletedKeys
)) {
return;
}

for (
const key of deletedKeys
) {

try { const cached = getCachedMessage(key); if (!cached) { continue; } const target = settings.antiDelTarget === "PRIVATE" ? getOwnerJid(sock) : key.remoteJid; if (!target) { continue; } const text = getMessageText(cached); const media = getMediaInfo( cached.message ); if (media) { try { const downloaded = await downloadWhatsAppMedia( sock, cached ); await sendWhatsAppMedia( sock, target, downloaded ); } catch { await sock.sendMessage( target, { text: `🗑️ DELETED MEDIA\n\nType: ${media.mediaType}` } ); } } else if (text) { await sock.sendMessage( target, { text: `🗑️ DELETED MESSAGE\n\n${text}` } ); } else { try { await sock.sendMessage( target, { forward: cached } ); } catch { await sock.sendMessage( target, { text: "🗑️ A message was deleted." } ); } } } catch (error) { logger.error({ error: error.message }, "Anti-delete error"); } 

}
}

/* =====================================================
STATUS HANDLER
===================================================== */

async function handleStatus(
username,
sock,
msg
) {

if (
msg.key?.remoteJid !==
"status@broadcast"
) {
return;
}

const settings =
getSettings(username);

const participant =
msg.key?.participant ||
msg.participant;

if (
!participant
) {
return;
}

if (
settings.statusRead === "ON"
) {

await sock.readMessages([ msg.key ]).catch(() => {}); 

}

if (
settings.statusReact === "OFF"
) {
return;
}

let emoji =
"💚";

if (
settings.statusReact ===
"RANDOM"
) {

emoji = statusReactList[ Math.floor( Math.random() * statusReactList.length ) ]; 

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
).catch(
error => {
logger.error({
error: error.message
}, "Status reaction error");
}
);
}

/* =====================================================
   DIMUWA CHANNEL + WELCOME
===================================================== */

async function followDimuwaChannel(sock) {

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
    }, "DIMUWA channel followed.");

    return true;

  } catch (error) {

    logger.error({
      error:
        error.message
    }, "DIMUWA channel follow failed.");

    return false;
  }
}


async function sendDimuwaWelcome(
  sock,
  username
) {

  try {

    const ownerJid =
      jidFromPhone(
        jidNumber(
          sock.user?.id
        )
      );

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
      username,
      ownerJid
    }, "Welcome message sent.");

  } catch (error) {

    logger.error({
      error:
        error.message
    }, "Welcome message failed.");

  }
}

/* =====================================================
PRESENCE
===================================================== */

async function applyPresence(
username,
sock
) {

const settings =
getSettings(username);

if (
settings.alwaysOnline === "ON"
) {

await sock.sendPresenceUpdate( "available" ).catch(() => {}); 

} else {

await sock.sendPresenceUpdate( "unavailable" ).catch(() => {}); 

}
}

async function startComposing(
username,
sock,
jid
) {

const settings =
getSettings(username);

if (
settings.composing !== "ON"
) {
return;
}

await sock.sendPresenceUpdate(
"composing",
jid
).catch(() => {});

}

/* =====================================================
MAIN MESSAGE HANDLER
===================================================== */

async function handleMessage(
username,
sock,
msg
) {

if (
!msg ||
!msg.message ||
!msg.key
) {
return;
}

if (
isStatusJid(
msg.key.remoteJid
)
) {

await handleStatus( username, sock, msg ); return; 

}

if (
msg.key.remoteJid ===
"broadcast"
) {
return;
}

cacheMessage(msg);

incrementStat(
username,
"messages"
);

const settings =
getSettings(username);

if (
settings.autoRead === "ON" &&
!msg.key.fromMe
) {

await sock.readMessages([ msg.key ]).catch(() => {}); 

}

const text =
getMessageText(msg)
.trim();

if (!text) {
return;
}

/* -----------------------------------------
OWNER SETTINGS CODES
----------------------------------------- */

const settingCode =
text.match(
/^\s*(\d{1,2}\.\d)\s*$/
);

if (settingCode) {

await processSettingsCode( sock, username, msg, settingCode[1] ); return; 

}

/* -----------------------------------------
BOT POWER OFF
----------------------------------------- */

if (
settings.botPower !== "ON"
) {

return; 

}

/* -----------------------------------------
BOT MODE
----------------------------------------- */

if (
!canProcessMessage(
sock,
username,
msg
)
) {
return;
}

/* -----------------------------------------
COMPOSING
----------------------------------------- */

await startComposing(
username,
sock,
msg.key.remoteJid
);

/* -----------------------------------------
COMMAND
----------------------------------------- */

const command =
text
.split(/\s+/)[0]
.toLowerCase();

if (
command.startsWith(".")
) {

incrementStat( username, "commands" ); 

}

/* -----------------------------------------
MENU
----------------------------------------- */

if (
command === ".menu" ||
command === ".help"
) {

await sock.sendMessage( msg.key.remoteJid, { text: menuText() } ); return; 

}

/* -----------------------------------------
ALIVE
----------------------------------------- */

if (
command === ".alive"
) {

await sock.sendMessage( msg.key.remoteJid, { text: aliveText(username) } ); return; 

}

/* -----------------------------------------
STATUS
----------------------------------------- */

if (
command === ".status"
) {

await sock.sendMessage( msg.key.remoteJid, { text: statusText( username, sock ) } ); return; 

}

/* -----------------------------------------
SETTINGS
----------------------------------------- */

if (
command === ".settings"
) {

const owner = getOwnerJid(sock); const sender = msg.key.participant || msg.key.remoteJid; if ( owner && ( msg.key.fromMe || jidNumber(sender) === jidNumber(owner) ) ) { await sock.sendMessage( msg.key.remoteJid, { text: settingsMenu( username ) } ); } else { await sock.sendMessage( msg.key.remoteJid, { text: "❌ .settings is available only for bot owner." } ); } return; 

}

/* -----------------------------------------
.VV
----------------------------------------- */

if (
command === ".vv" ||
command === ".viewonce"
) {

await handleViewOnce( sock, username, msg ); return; 

}

/* -----------------------------------------
.SAVE
----------------------------------------- */

if (
command === ".save"
) {

await handleSave( sock, username, msg ); return; 

}

/* -----------------------------------------
DOWNLOADER
----------------------------------------- */

if (
extractHttpUrl(text)
) {

const handled = await handleDownloader( sock, username, msg, text ); if (handled) { return; } 

}

/* -----------------------------------------
PAUSE COMPOSING
----------------------------------------- */

await sock.sendPresenceUpdate(
"paused",
msg.key.remoteJid
).catch(() => {});
}

/* =====================================================
BOT CREATION
===================================================== */

async function startBot(
username,
options = {}
) {

const clean =
cleanUsername(username);

if (
bots.has(clean)
) {

return bots.get(clean); 

}

if (
startingBots.has(clean)
) {

return startingBots.get(clean); 

}

const startPromise =
(async () => {

const authPath = sessionPath(clean); fs.mkdirSync( authPath, { recursive: true } ); const { state, saveCreds } = await useMultiFileAuthState( authPath ); const sock = makeWASocket({ auth: state, browser: Browsers.ubuntu( "Chrome" ), printQRInTerminal: false, logger, markOnlineOnConnect: false, syncFullHistory: false, connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 25000 }); sock.__dimuwaUsername = clean; bots.set( clean, sock ); getSettings(clean); getStats(clean); /* --------------------------------------- CREDENTIALS --------------------------------------- */ sock.ev.on( "creds.update", saveCreds ); /* --------------------------------------- CONNECTION UPDATE --------------------------------------- */ sock.ev.on( "connection.update", async (update) => { const { connection, lastDisconnect, qr } = update; /* QR */ if (qr) { try { qrStore.set( clean, await QRCode.toDataURL( qr, { margin: 2, width: 500 } ) ); } catch (error) { logger.error({ error: error.message }, "QR generation error"); } } /* CONNECTED */ if ( connection === "open" ) { qrStore.delete( clean ); pairingStore.delete( clean ); /* --------------------------------------- DIMUWA CHANNEL FOLLOW --------------------------------------- */ await followDimuwaChannel( sock ); /* --------------------------------------- WELCOME MESSAGE --------------------------------------- */ await sendDimuwaWelcome( sock, clean ); const stats = getStats(clean); stats.connectedAt = Date.now(); saveStats(); logger.info({ username: clean, user: sock.user?.id }, "DIMUWA bot connected"); await applyPresence( clean, sock ); if ( getSettings(clean) .alwaysOnline === "ON" ) { const oldTimer = sock.__presenceTimer; if ( oldTimer ) { clearInterval( oldTimer ); } sock.__presenceTimer = setInterval( async () => { if ( isConnected(sock) && getSettings(clean) .alwaysOnline === "ON" ) { await sock .sendPresenceUpdate( "available" ) .catch(() => {}); } }, 20000 ); } return; } /* CLOSED */ if ( connection === "close" ) { if ( sock.__presenceTimer ) { clearInterval( sock.__presenceTimer ); sock.__presenceTimer = null; } const code = lastDisconnect ?.error ?.output ?.statusCode; logger.warn({ username: clean, code }, "WhatsApp connection closed"); bots.delete( clean ); if ( code === DisconnectReason.loggedOut ) { qrStore.delete( clean ); pairingStore.delete( clean ); logger.warn({ username: clean }, "Session logged out"); return; } if ( code === 440 ) { logger.warn({ username: clean }, "Connection replaced"); return; } const reconnectDelay = code === 515 ? 1000 : code === 408 ? 5000 : 5000; setTimeout( () => { startBot( clean ).catch( error => { logger.error({ error: error.message, username: clean }, "Reconnect failed"); } ); }, reconnectDelay ); } } ); /* --------------------------------------- MESSAGES --------------------------------------- */ sock.ev.on( "messages.upsert", async (event) => { const messages = event?.messages || []; for ( const msg of messages ) { try { await handleMessage( clean, sock, msg ); } catch (error) { logger.error({ username: clean, error: error.message, stack: error.stack }, "Message handler error"); } } } ); /* --------------------------------------- MESSAGE DELETE --------------------------------------- */ sock.ev.on( "messages.delete", async (event) => { try { let keys = []; if ( Array.isArray(event) ) { keys = event; } else if ( Array.isArray( event?.keys ) ) { keys = event.keys; } else if ( event?.key ) { keys = [ event.key ]; } await handleDeletedMessages( clean, sock, keys ); } catch (error) { logger.error({ error: error.message }, "Delete event error"); } } ); /* --------------------------------------- RETURN --------------------------------------- */ return sock; })(); 

startingBots.set(
clean,
startPromise
);

try {

return await startPromise; 

} finally {

startingBots.delete( clean ); 

}
}

/* =====================================================
PAIRING CODE
===================================================== */

async function getPairingCode(
username,
phone
) {

const clean =
cleanUsername(username);

const number =
normalizePhone(phone);

if (
!number ||
number.length < 8
) {

throw new Error( "Valid WhatsApp phone number required. Use country code without +." ); 

}

let sock =
bots.get(clean);

if (!sock) {

sock = await startBot( clean, { pairing: true } ); 

}

if (
isConnected(sock)
) {

return { connected: true, message: "This bot is already connected." }; 

}

pairingStore.set(
clean,
number
);

/*
Baileys pairing code requires
digits only and country code.
*/

await new Promise(
resolve =>
setTimeout(
resolve,
1500
)
);

if (
isConnected(sock)
) {

return { connected: true, message: "This bot is already connected." }; 

}

const code =
await sock.requestPairingCode(
number
);

const formatted =
String(code)
.replace(
/(.{4})/g,
"$1-"
)
.replace(
/-$/,
""
);

pairingStore.set(
clean,
number
);

return {
connected: false,
code: formatted,
phone: number
};
}

/* =====================================================
QR WAIT
===================================================== */

async function waitForQR(
username,
timeout = 15000
) {

const clean =
cleanUsername(username);

const started =
Date.now();

while (
Date.now() -
started <
timeout
) {

const qr = qrStore.get(clean); if (qr) { return qr; } const sock = bots.get(clean); if ( sock && isConnected(sock) ) { return null; } await new Promise( resolve => setTimeout( resolve, 300 ) ); 

}

return (
qrStore.get(clean) ||
null
);
}

/* =====================================================
DASHBOARD API
===================================================== */

app.get(
"/health",
(req, res) => {

res.json({ ok: true, service: "DIMUWA MINI BOT", version: "5.0.0", uptime: process.uptime(), time: new Date().toISOString() }); 

}
);

/* -----------------------------------------
ROOT
----------------------------------------- */

app.get(
"/",
(req, res) => {

res.sendFile( path.join( __dirname, "index.html" ) ); 

}
);

/* -----------------------------------------
PAIRING CODE
----------------------------------------- */

app.get(
"/get-pairing-code",
async (req, res) => {

try { const username = cleanUsername( req.query.username ); const phone = normalizePhone( req.query.phone ); if (!phone) { return res.status(400) .json({ ok: false, error: "Phone number required." }); } const result = await getPairingCode( username, phone ); res.json({ ok: true, ...result }); } catch (error) { logger.error({ error: error.message }, "Pairing API error"); res.status(500) .json({ ok: false, error: error.message }); } 

}
);

/* -----------------------------------------
QR
----------------------------------------- */

app.get(
"/qr",
async (req, res) => {

try { const username = cleanUsername( req.query.username ); const sock = await startBot( username ); if ( isConnected(sock) ) { return res.json({ ok: true, connected: true, qr: null, message: "Bot is already connected." }); } qrStore.delete( username ); const qr = await waitForQR( username, 15000 ); if (!qr) { return res.status(404) .json({ ok: false, error: "QR code not available yet. Try again." }); } res.json({ ok: true, connected: false, qr }); } catch (error) { logger.error({ error: error.message }, "QR API error"); res.status(500) .json({ ok: false, error: error.message }); } 

}
);

/* -----------------------------------------
DETAILS
----------------------------------------- */

app.get(
"/details",
async (req, res) => {

try { const username = cleanUsername( req.query.username ); const sock = bots.get(username); const stats = getStats(username); const settings = getSettings(username); res.json({ ok: true, status: isConnected(sock) ? "CONNECTED" : "OFFLINE", connected: isConnected(sock), username, phone: jidNumber( sock?.user?.id ) || null, name: sock?.user?.name || sock?.user?.verifiedName || null, pushName: sock?.user?.name || null, jid: sock?.user?.id || null, connectedAt: stats.connectedAt, settings }); } catch (error) { res.status(500) .json({ ok: false, error: error.message }); } 

}
);

/* -----------------------------------------
STATS
----------------------------------------- */

app.get(
"/stats",
async (req, res) => {

try { const username = cleanUsername( req.query.username ); const stats = getStats(username); const connectedAt = stats.connectedAt; const uptime = connectedAt ? Math.max( 0, Math.floor( ( Date.now() - connectedAt ) / 1000 ) ) : 0; res.json({ ok: true, stats: { ...stats, uptime } }); } catch (error) { res.status(500) .json({ ok: false, error: error.message }); } 

}
);

/* -----------------------------------------
SETTINGS
----------------------------------------- */

app.get(
"/settings",
async (req, res) => {

try { const username = cleanUsername( req.query.username ); res.json({ ok: true, settings: getSettings(username) }); } catch (error) { res.status(500) .json({ ok: false, error: error.message }); } 

}
);

/* -----------------------------------------
LOGOUT
----------------------------------------- */

app.post(
"/logout",
async (req, res) => {

try { const username = cleanUsername( req.query.username ); const sock = bots.get(username); if (sock) { try { await sock.logout(); } catch {} } bots.delete( username ); qrStore.delete( username ); pairingStore.delete( username ); const authPath = sessionPath(username); await fsp.rm( authPath, { recursive: true, force: true } ); res.json({ ok: true, message: "Bot logged out successfully." }); } catch (error) { res.status(500) .json({ ok: false, error: error.message }); } 

}
);

/* -----------------------------------------
UNLINK
----------------------------------------- */

app.post(
"/unlink",
async (req, res) => {

try { const username = cleanUsername( req.query.username ); const sock = bots.get(username); if (sock) { try { await sock.logout(); } catch {} } bots.delete( username ); qrStore.delete( username ); pairingStore.delete( username ); const authPath = sessionPath(username); await fsp.rm( authPath, { recursive: true, force: true } ); res.json({ ok: true, message: "WhatsApp session unlinked successfully." }); } catch (error) { res.status(500) .json({ ok: false, error: error.message }); } 

}
);

/* =====================================================
404
===================================================== */

app.use(
(req, res) => {

if ( req.path.startsWith("/api/") ) { return res.status(404) .json({ ok: false, error: "API endpoint not found." }); } res.status(404) .send( "DIMUWA MINI BOT - Page not found" ); 

}
);

/* =====================================================
SERVER
===================================================== */

const server =
app.listen(
PORT,
"0.0.0.0",
() => {

logger.info({ port: PORT, dataDir: DATA_DIR }, "DIMUWA MINI BOT server started"); } 

);

/* =====================================================
RESTORE EXISTING SESSIONS
===================================================== */

async function restoreSessions() {

try {

if ( !fs.existsSync( SESSION_DIR ) ) { return; } const folders = await fsp.readdir( SESSION_DIR, { withFileTypes: true } ); for ( const folder of folders ) { if ( !folder.isDirectory() ) { continue; } if ( !folder.name.startsWith( "session_" ) ) { continue; } const username = folder.name .replace( /^session_/, "" ); if (!username) { continue; } logger.info({ username }, "Restoring bot session"); startBot( username ).catch( error => { logger.error({ username, error: error.message }, "Session restore failed"); } ); /* Small delay between sessions so multiple sessions don't initialize at exactly the same time. */ await new Promise( resolve => setTimeout( resolve, 500 ) ); } 

} catch (error) {

logger.error({ error: error.message }, "Session restore error"); 

}
}

/* =====================================================
GRACEFUL SHUTDOWN
===================================================== */

async function shutdown(
signal
) {

logger.info(
`${signal} received. Shutting down...`
);

for (
const [username, sock]
of bots
) {

try { if ( sock.__presenceTimer ) { clearInterval( sock.__presenceTimer ); } logger.info({ username }, "Closing bot"); sock.ws?.close(); } catch {} 

}

server.close(
() => {
process.exit(0);
}
);

setTimeout(
() => process.exit(0),
5000
);
}

process.on(
"SIGTERM",
() => shutdown("SIGTERM")
);

process.on(
"SIGINT",
() => shutdown("SIGINT")
);

/* =====================================================
START
===================================================== */

restoreSessions()
.catch(
error => {

logger.error({ error: error.message }, "Startup restore error"); } 

);
