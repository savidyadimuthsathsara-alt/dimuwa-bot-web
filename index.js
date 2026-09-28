const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Database connection error:", err.message);
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    phone TEXT
)`);

const CHANNEL_INVITE_CODE = "0029VbDZDmx4inoi10evlP1M";
const activeQRStore = new Map();
const pairingCodeStore = new Map();
const userSettingsStore = new Map();
const userDownloadState = new Map();
const messageStore = new Map();

const defaultSettings = {
    alwaysOnline: "OFF", autoRead: "OFF", botMode: "PUBLIC",
    statusRead: "ON", statusReact: "GREEN", composing: "ON",
    antiDelete: "ON", antiDelTarget: "SAME", vvTarget: "SAME",     
    saveTarget: "SAME", botPower: "ON"
};

function getSettings(username) {
    if (!userSettingsStore.has(username)) {
        userSettingsStore.set(username, { ...defaultSettings });
    }
    return userSettingsStore.get(username);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Pairing Code Endpoint
app.post('/get-pairing-code', async (req, res) => {
    const { username, phone } = req.body;
    if (!username || !phone) return res.status(400).json({ error: "User and phone number required" });

    const sessionPath = `./session_${username}`;
    if (fs.existsSync(sessionPath)) {
        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch(e){}
    }

    startBotForUser(username, true, phone);

    const checkInterval = setInterval(() => {
        if (pairingCodeStore.has(username)) {
            const code = pairingCodeStore.get(username);
            clearInterval(checkInterval);
            res.json({ success: true, code: code });
        }
    }, 1000);

    setTimeout(() => {
        clearInterval(checkInterval);
        if (!res.headersSent) res.status(408).json({ error: "Pairing code timeout. Try again." });
    }, 25000);
});

app.post('/disconnect', (req, res) => {
    const { username } = req.body;
    const sessionFolder = `./session_${username}`;
    
    if (fs.existsSync(sessionFolder)) {
        try {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            activeQRStore.delete(username);
            pairingCodeStore.delete(username);
            res.json({ success: true, message: "Bot successfully unlinked!" });
        } catch (err) {
            res.status(500).json({ error: "Failed to delete session." });
        }
    } else {
        res.status(404).json({ error: "No active session found!" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    fs.readdirSync('./').forEach(file => {
        if (file.startsWith('session_')) {
            const user = file.replace('session_', '');
            startBotForUser(user, false, null);
        }
    });
});

async function startBotForUser(username, usePairingCode, phoneNumber) {
    const { state, saveCreds } = await useMultiFileAuthState(`./session_${username}`);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        connectTimeoutMs: 60000, 
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: true
    });

    if (usePairingCode && phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                let code = await sock.requestPairingCode(cleanPhone);
                pairingCodeStore.set(username, code?.match(/.{1,4}/g)?.join("-") || code);
            } catch (err) {
                console.error("Pairing code error:", err);
            }
        }, 4000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            activeQRStore.set(username, qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) {
                setTimeout(() => startBotForUser(username, false, null), 3000);
            } else {
                try { fs.rmSync(`./session_${username}`, { recursive: true, force: true }); } catch(e){}
                activeQRStore.delete(username);
                pairingCodeStore.delete(username);
            }
        } else if (connection === 'open') {
            activeQRStore.delete(username);
            pairingCodeStore.delete(username);
            try {
                const channelData = await sock.newsletterMetadata("invite", CHANNEL_INVITE_CODE);
                await sock.newsletterFollow(channelData.id);
                await sock.newsletterMute(channelData.id); 
            } catch (err) {}
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        try {
            const botSettings = getSettings(username);
            if (botSettings.antiDelete !== "ON" || botSettings.botPower === "OFF") return;

            for (const update of updates) {
                if (update.update && update.update.message === null) {
                    const key = update.key;
                    const msgId = key.id;
                    const cachedMsg = messageStore.get(msgId);

                    if (cachedMsg) {
                        const from = key.remoteJid;
                        const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        const destination = botSettings.antiDelTarget === "PRIVATE" ? ownerJid : from;

                        let alertText = `🚨 *ANTI-DELETE DETECTED!*\n\n📱 *Sender:* @${key.participant ? key.participant.split('@')[0] : from.split('@')[0]}`;
                        
                        await sock.sendMessage(destination, { text: alertText, mentions: [key.participant || from] });
                        await sock.sendMessage(destination, { forward: cachedMsg });
                    }
                }
            }
        } catch (e) { console.error("Anti-delete error:", e); }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            if (m.key && m.key.id) {
                messageStore.set(m.key.id, m);
                if (messageStore.size > 200) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            const from = m.key.remoteJid;
            const senderNumber = m.key.participant || from;
            const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const botSettings = getSettings(username);

            if (botSettings.botPower === "OFF") return;

            if (botSettings.alwaysOnline === "ON") await sock.sendPresenceUpdate('available', from);
            if (botSettings.composing === "ON") await sock.sendPresenceUpdate('composing', from);
            if (botSettings.autoRead === "ON") await sock.readMessages([m.key]);

            if (from === 'status@broadcast' && botSettings.statusRead === "ON") {
                await sock.readMessages([m.key]);
                if (botSettings.statusReact !== "OFF") {
                    const emoji = botSettings.statusReact === "GREEN" ? '💚' : '❤️';
                    await sock.sendMessage(from, { 
                        react: { text: emoji, key: m.key } 
                    }, { statusJidList: [m.key.participant || m.participant] });
                }
                return;
            }

            const messageType = Object.keys(m.message)[0];
            let body = '';
            if (messageType === 'conversation') body = m.message.conversation;
            else if (messageType === 'extendedTextMessage') body = m.message.extendedTextMessage.text;

            const cleanBody = body.trim();
            const args = cleanBody.split(/ +/);
            const command = args[0].toLowerCase();
            const text = args.slice(1).join(" ");

            if (botSettings.botMode === "PRIVATE" && senderNumber !== ownerJid && !m.key.fromMe) return;

            if (userDownloadState.get(from) === 'waiting_for_link') {
                userDownloadState.delete(from);
                const mediaLink = cleanBody;
                if (!mediaLink.startsWith('http')) {
                    await sock.sendMessage(from, { text: "⚠️ Invalid link provided! Please send a valid URL." }, { quoted: m });
                    return;
                }
                await downloadAndSendMedia(sock, from, mediaLink, m);
                return;
            }

            let effectiveCommand = command;
            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            let isMenuContext = quotedMsg && quotedMsg.conversation && (quotedMsg.conversation.includes("DIMUWA MINI BOT") || quotedMsg.conversation.includes("MAIN MENU") || quotedMsg.conversation.includes("SETTINGS"));

            if (isMenuContext || !cleanBody.startsWith('.')) {
                if (cleanBody === '1' || cleanBody === '.download' || cleanBody === '.dl') {
                    const dlText = `📥 *DIMUWA MEDIA DOWNLOADER*\n\n` +
                        `• \`.tiktok <link>\`\n` +
                        `• \`.fb <link>\`\n` +
                        `• \`.yt <link>\``;
                    userDownloadState.set(from, 'waiting_for_link');
                    await sock.sendMessage(from, { text: dlText }, { quoted: m });
                    return;
                }
                else if (cleanBody === '2' || cleanBody === '.setting' || cleanBody === '.settings') {
                    effectiveCommand = '.settings';
                }
                else if (cleanBody === '3') {
                    await sock.sendMessage(from, { text: "👑 *Owner Commands:* Only bot owner can manage advanced system overrides." }, { quoted: m });
                    return;
                }
                else if (cleanBody === '4' || cleanBody === '.utility') {
                    const utilText = `🛠️ *UTILITY COMMANDS*\n\n` +
                        `• \`.vv\` - Reply to a View-Once message to unlock it.\n` +
                        `• \`.save\` - Reply to a media/status to save it.`;
                    await sock.sendMessage(from, { text: utilText }, { quoted: m });
                    return;
                }
            }

            if (cleanBody === '.menu' || cleanBody === '4' && isMenuContext === false) {
                effectiveCommand = '.menu';
            }

            let isSettingsMenuContext = quotedMsg && quotedMsg.conversation && quotedMsg.conversation.includes("DIMUWA MINI BOT SETTINGS");

            if (isSettingsMenuContext || cleanBody.includes('.')) {
                if (cleanBody === '1.1') { botSettings.alwaysOnline = "ON"; await sock.sendMessage(from, { text: "✅ Always Online enabled!" }, { quoted: m }); return; }
                if (cleanBody === '1.2') { botSettings.alwaysOnline = "OFF"; await sock.sendMessage(from, { text: "❌ Always Online disabled!" }, { quoted: m }); return; }
                if (cleanBody === '2.1') { botSettings.autoRead = "ON"; await sock.sendMessage(from, { text: "✅ Auto Read enabled!" }, { quoted: m }); return; }
                if (cleanBody === '2.2') { botSettings.autoRead = "OFF"; await sock.sendMessage(from, { text: "❌ Auto Read disabled!" }, { quoted: m }); return; }
                if (cleanBody === '3.1') { botSettings.botMode = "PUBLIC"; await sock.sendMessage(from, { text: "✅ Bot Mode set to PUBLIC!" }, { quoted: m }); return; }
                if (cleanBody === '3.2') { botSettings.botMode = "PRIVATE"; await sock.sendMessage(from, { text: "✅ Bot Mode set to PRIVATE!" }, { quoted: m }); return; }
                if (cleanBody === '3.3') { botSettings.botMode = "INBOX"; await sock.sendMessage(from, { text: "✅ Bot Mode set to INBOX!" }, { quoted: m }); return; }
                if (cleanBody === '4.1') { botSettings.statusRead = "ON"; await sock.sendMessage(from, { text: "✅ Status Read enabled!" }, { quoted: m }); return; }
                if (cleanBody === '4.2') { botSettings.statusRead = "OFF"; await sock.sendMessage(from, { text: "❌ Status Read disabled!" }, { quoted: m }); return; }
                if (cleanBody === '5.1') { botSettings.statusReact = "GREEN"; await sock.sendMessage(from, { text: "✅ Status React set to GREEN!" }, { quoted: m }); return; }
                if (cleanBody === '5.2') { botSettings.statusReact = "RANDOM"; await sock.sendMessage(from, { text: "✅ Status React set to RANDOM!" }, { quoted: m }); return; }
                if (cleanBody === '5.3') { botSettings.statusReact = "OFF"; await sock.sendMessage(from, { text: "❌ Status React turned OFF!" }, { quoted: m }); return; }
                if (cleanBody === '7.1') { botSettings.composing = "ON"; await sock.sendMessage(from, { text: "✅ Composing enabled!" }, { quoted: m }); return; }
                if (cleanBody === '7.2') { botSettings.composing = "OFF"; await sock.sendMessage(from, { text: "❌ Composing disabled!" }, { quoted: m }); return; }
                if (cleanBody === '9.1') { botSettings.antiDelete = "ON"; await sock.sendMessage(from, { text: "✅ Anti-Delete enabled!" }, { quoted: m }); return; }
                if (cleanBody === '9.2') { botSettings.antiDelete = "OFF"; await sock.sendMessage(from, { text: "❌ Anti-Delete disabled!" }, { quoted: m }); return; }
                if (cleanBody === '10.1') { botSettings.antiDelTarget = "SAME"; await sock.sendMessage(from, { text: "✅ Anti-Del Target set to SAME CHAT!" }, { quoted: m }); return; }
                if (cleanBody === '10.2') { botSettings.antiDelTarget = "PRIVATE"; await sock.sendMessage(from, { text: "✅ Anti-Del Target set to MY INBOX!" }, { quoted: m }); return; }
                if (cleanBody === '11.1') { botSettings.vvTarget = "SAME"; await sock.sendMessage(from, { text: "✅ View-Once Target set to SAME CHAT!" }, { quoted: m }); return; }
                if (cleanBody === '11.2') { botSettings.vvTarget = "PRIVATE"; await sock.sendMessage(from, { text: "✅ View-Once Target set to MY INBOX!" }, { quoted: m }); return; }
                if (cleanBody === '12.1') { botSettings.saveTarget = "SAME"; await sock.sendMessage(from, { text: "✅ Save Target set to SAME CHAT!" }, { quoted: m }); return; }
                if (cleanBody === '12.2') { botSettings.saveTarget = "PRIVATE"; await sock.sendMessage(from, { text: "✅ Save Target set to MY INBOX!" }, { quoted: m }); return; }
                if (cleanBody === '13.1') { botSettings.botPower = "ON"; await sock.sendMessage(from, { text: "✅ Bot Power turned ON!" }, { quoted: m }); return; }
                if (cleanBody === '13.2') { botSettings.botPower = "OFF"; await sock.sendMessage(from, { text: "❌ Bot Power turned OFF!" }, { quoted: m }); return; }
            }

            if (effectiveCommand === '.ping') {
                const msgTime = Number(m.messageTimestamp) * 1000;
                await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ Speed: ${Math.abs(Date.now() - msgTime)}ms` }, { quoted: m });
            }
            else if (effectiveCommand === '.alive') {
                await sock.sendMessage(from, { image: { url: 'https://files.catbox.moe/6gq4ub.jpeg' }, caption: '👋 Hello! I am Dimuwa Mini Bot 24/7 active!' }, { quoted: m });
                await sock.sendMessage(from, { audio: { url: 'https://files.catbox.moe/vsl1wg.mp3' }, mimetype: 'audio/mp4', ptt: false }, { quoted: m });
            }
            else if (effectiveCommand === '.settings') {
                let settingsText = `⚙️ DIMUWA MINI BOT SETTINGS\n` +
                    `│ Reply with the code below to update\n\n` +
                    `• PRESENCE & SCOPE •\n\n` +
                    `01. Always Online [ ${botSettings.alwaysOnline} ]\n` +
                    `│ 1.1 Enable  •  1.2 Disable\n\n` +
                    `02. Auto Read [ ${botSettings.autoRead} ]\n` +
                    `│ 2.1 Enable  •  2.2 Disable\n\n` +
                    `03. Bot Mode [ ${botSettings.botMode} ]\n` +
                    `│ 3.1 Public  •  3.2 Private  •  3.3 Inbox\n\n` +
                    `• AUTOMATIONS & STATUS •\n\n` +
                    `04. Status Read [ ${botSettings.statusRead} ]\n` +
                    `│ 4.1 Enable  •  4.2 Disable\n\n` +
                    `05. Status React [ ${botSettings.statusReact} ]\n` +
                    `│ 5.1 Green  •  5.2 Random  •  5.3 Off\n\n` +
                    `07. Composing [ ${botSettings.composing} ]\n` +
                    `│ 7.1 Enable  •  7.2 Disable\n\n` +
                    `• SECURITY & SYSTEM •\n\n` +
                    `09. Anti-Delete [ ${botSettings.antiDelete} ]\n` +
                    `│ 9.1 Enable  •  9.2 Disable\n\n` +
                    `10. Anti-Del Target [ ${botSettings.antiDelTarget} ]\n` +
                    `│ 10.1 Same Chat  •  10.2 My Inbox\n\n` +
                    `11. View Once (.vv) Target [ ${botSettings.vvTarget} ]\n` +
                    `│ 11.1 Same Chat  •  11.2 My Inbox\n\n` +
                    `12. Save (.save) Target [ ${botSettings.saveTarget} ]\n` +
                    `│ 12.1 Same Chat  •  12.2 My Inbox\n\n` +
                    `13. Bot Power [ ${botSettings.botPower} ]\n` +
                    `│ 13.1 Turn ON  •  13.2 Turn Off\n\n` +
                    `© CREATOR BY DIMUTH SATHSARA`;
                
                await sock.sendMessage(from, { text: settingsText }, { quoted: m });
            }
            else if (effectiveCommand === '.menu') {
                const menuText = `👋 DIMUWA MINI BOT 🤖 👑\n` +
                    `-- The Mini Whatsapp Bot Experience --\n\n` +
                    `┌──「 👨‍💻 CREATOR INFO 」──┐\n` +
                    `│ 👨‍💻 Creator: Dimuth sathsara\n` +
                    `│ 📱 Contact: +94740325746\n` +
                    `│ ⚙️ Prefix: [ . ]\n` +
                    `└────────────────────┘\n\n` +
                    `┌──「 🤖 BOT STATUS 」──┐\n` +
                    `│ 🇱🇰 Bot Name: DIMUWA MINI BOT\n` +
                    `│ 🟢 Status: Online\n` +
                    `│ ⚙️ Mode: ${botSettings.botMode}\n` +
                    `└────────────────────┘\n\n` +
                    `┌──「 📁 MAIN MENU 」──┐\n` +
                    `│ 1️⃣ 📥 DOWNLOAD (TikTok, FB, YT)\n` +
                    `│ 2️⃣ ⚙️ SETTINGS (.settings)\n` +
                    `│ 3️⃣ 👑 OWNER COMMANDS\n` +
                    `│ 4️⃣ 🛠️ UTILITY (.vv, .save)\n` +
                    `│ 5️⃣ 🎮 FUN COMMANDS\n` +
                    `│ 6️⃣ 👥 GROUP COMMANDS (.tagall)\n` +
                    `└────────────────────┘\n\n` +
                    `💡 Type or reply a number (1-6) or command!`;
                
                await sock.sendMessage(from, { image: { url: 'https://files.catbox.moe/6gq4ub.jpeg' }, caption: menuText }, { quoted: m });
                await sock.sendMessage(from, { audio: { url: 'https://files.catbox.moe/vsl1wg.mp3' }, mimetype: 'audio/mp4', ptt: false }, { quoted: m });
            }
            else if (effectiveCommand === '.download' || effectiveCommand === '.dl') {
                const dlText = `📥 *DIMUWA MEDIA DOWNLOADER*\n\n` +
                    `• \`.tiktok <link>\`\n` +
                    `• \`.fb <link>\`\n` +
                    `• \`.yt <link>\``;
                await sock.sendMessage(from, { text: dlText }, { quoted: m });
            }
            else if (effectiveCommand === '.tiktok' || effectiveCommand === '.tt' || effectiveCommand === '.fb' || effectiveCommand === '.facebook' || effectiveCommand === '.yt' || effectiveCommand === '.youtube') {
                if (!text) {
                    await sock.sendMessage(from, { text: `⚠️ Please provide a valid link!\nExample: \`.tiktok <link>\`` }, { quoted: m });
                    return;
                }
                await downloadAndSendMedia(sock, from, text, m);
            }
            else if (effectiveCommand === '.save') {
                const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) {
                    await sock.sendMessage(from, { text: "⚠️ Please reply to a status or media message with *.save* to download it!" }, { quoted: m });
                    return;
                }
                const targetMsg = quotedMsg;
                const type = Object.keys(targetMsg)[0];
                const destination = botSettings.saveTarget === "PRIVATE" ? ownerJid : from;
                
                try {
                    if (type === 'imageMessage') {
                        const stream = await downloadContentFromMessage(targetMsg.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                        await sock.sendMessage(destination, { image: buffer, caption: targetMsg.imageMessage.caption || '' });
                    } else if (type === 'videoMessage') {
                        const stream = await downloadContentFromMessage(targetMsg.videoMessage, 'video');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                        await sock.sendMessage(destination, { video: buffer, caption: targetMsg.videoMessage.caption || '' });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: "❌ Failed to save media. Please try again!" }, { quoted: m });
                }
            }
            else if (effectiveCommand === '.vv') {
                const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) {
                    await sock.sendMessage(from, { text: "⚠️ Please reply to a View-Once message with *.vv* to unlock it!" }, { quoted: m });
                    return;
                }
                
                try {
                    const innerMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message || quotedMsg;
                    const type = Object.keys(innerMsg)[0];
                    const mediaMsg = innerMsg[type];
                    
                    if (!mediaMsg || (type !== 'imageMessage' && type !== 'videoMessage')) {
                        await sock.sendMessage(from, { text: "⚠️ This is not a valid View-Once media message!" }, { quoted: m });
                        return;
                    }

                    const destination = botSettings.vvTarget === "PRIVATE" ? ownerJid : from;
                    const mediaType = type === 'imageMessage' ? 'image' : 'video';
                    
                    const stream = await downloadContentFromMessage(mediaMsg, mediaType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }

                    if (mediaType === 'image') {
                        await sock.sendMessage(destination, { image: buffer, caption: "🔓 *View-Once Unlocked by Dimuwa Bot!*\n\n" + (mediaMsg.caption || '') });
                    } else {
                        await sock.sendMessage(destination, { video: buffer, caption: "🔓 *View-Once Unlocked by Dimuwa Bot!*\n\n" + (mediaMsg.caption || '') });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: "❌ Failed to unlock View-Once media. Please try replying directly to the view-once message!" }, { quoted: m });
                }
            }
        } catch (e) { console.error(e); }
    });
}

async function downloadAndSendMedia(sock, from, url, m) {
    await sock.sendMessage(from, { text: "⏳ *Downloading media, please wait...*" }, { quoted: m });
    try {
        const tikWmUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
        let response = await axios.get(tikWmUrl).catch(() => null);
        
        if (response && response.data && response.data.data) {
            const mediaUrl = response.data.data.play || response.data.data.wmplay || response.data.data.url;
            if (mediaUrl) {
                await sock.sendMessage(from, { video: { url: mediaUrl }, caption: "📥 *Downloaded by Dimuwa Mini Bot*" }, { quoted: m });
                return;
            }
        }

        const backupApi = `https://deliriussapi-oficial.vercel.app/download/all?url=${encodeURIComponent(url)}`;
        let backupRes = await axios.get(backupApi).catch(() => null);
        
        if (backupRes && backupRes.data && backupRes.data.data) {
            const videoUrl = backupRes.data.data.url || backupRes.data.data.download || backupRes.data.data.play;
            if (videoUrl) {
                await sock.sendMessage(from, { video: { url: videoUrl }, caption: "📥 *Downloaded by Dimuwa Mini Bot*" }, { quoted: m });
                return;
            }
        }

        const siputzxApi = `https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`;
        let siputzxRes = await axios.get(siputzxApi).catch(() => null);
        
        if (siputzxRes && siputzxRes.data && siputzxRes.data.status) {
            const videoUrl = siputzxRes.data.data.no_watermark || siputzxRes.data.data.video;
            if (videoUrl) {
                await sock.sendMessage(from, { video: { url: videoUrl }, caption: "📥 *Downloaded by Dimuwa Mini Bot*" }, { quoted: m });
                return;
            }
        }

        await sock.sendMessage(from, { text: "❌ Failed to download media. Please check if the link is correct!" }, { quoted: m });
    } catch (err) {
        await sock.sendMessage(from, { text: "❌ Failed to download media. Please try again later!" }, { quoted: m });
    }
}
