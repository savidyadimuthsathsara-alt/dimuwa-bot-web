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

const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Database connection error:", err.message);
    else console.log("Connected to SQLite Database.");
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    phone TEXT
)`);

const CHANNEL_INVITE_CODE = "0029VbDZDmx4inoi10evlP1M";

const userSettingsStore = new Map();
const defaultSettings = {
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

function getSettings(phoneNumber) {
    if (!userSettingsStore.has(phoneNumber)) {
        userSettingsStore.set(phoneNumber, { ...defaultSettings });
    }
    return userSettingsStore.get(phoneNumber);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Please fill all fields!" });

    db.run(`INSERT INTO users (username, password, phone) VALUES (?, ?, ?)`, [username, password, ""], function(err) {
        if (err) return res.status(400).json({ error: "Username already exists!" });
        res.json({ success: true, message: "Account created successfully!" });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Please fill all fields!" });

    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid username or password!" });
        res.json({ success: true, username: row.username, phone: row.phone || "" });
    });
});

app.get('/stats', (req, res) => {
    let count = 0;
    if (fs.existsSync('./')) {
        fs.readdirSync('./').forEach(file => {
            if (file.startsWith('session_')) count++;
        });
    }
    res.json({ activeBots: count });
});

app.post('/pair', async (req, res) => {
    let { username, number } = req.body;
    if (!username || !number) return res.status(400).json({ error: "Invalid request!" });
    
    number = number.replace(/[^0-9]/g, '');

    db.run(`UPDATE users SET phone = ? WHERE username = ?`, [number, username], () => {
        startBotForUser(number, res);
    });
});

app.post('/disconnect', (req, res) => {
    let { username, number } = req.body;
    if (!number) return res.status(400).json({ error: "Phone number required!" });
    
    number = number.replace(/[^0-9]/g, '');
    const sessionFolder = `./session_${number}`;
    
    if (fs.existsSync(sessionFolder)) {
        try {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            db.run(`UPDATE users SET phone = '' WHERE username = ?`, [username]);
            res.json({ success: true, message: "Bot successfully disconnected!" });
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
            const num = file.replace('session_', '');
            startBotForUser(num, null);
        }
    });
});

async function startBotForUser(phoneNumber, res) {
    const { state, saveCreds } = await useMultiFileAuthState(`./session_${phoneNumber}`);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        connectTimeoutMs: 60000, 
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered && res) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code; 
                res.json({ success: true, code: code });
            } catch (err) {
                res.status(500).json({ error: "WhatsApp server busy. Try again later!" });
            }
        }, 4000); 
    } else if (res) {
        res.json({ error: "Number already linked!" });
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBotForUser(phoneNumber, null);
            else fs.rmSync(`./session_${phoneNumber}`, { recursive: true, force: true });
        } else if (connection === 'open') {
            try {
                const channelData = await sock.newsletterMetadata("invite", CHANNEL_INVITE_CODE);
                await sock.newsletterFollow(channelData.id);
                await sock.newsletterMute(channelData.id); 
            } catch (err) {}

            try {
                const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const welcomeConnectText = `🎉 *DIMUWA MINI BOT CONNECTED!* 🚀\n\n` +
                    `✅ Status: Online & Active (24/7)\n` +
                    `📱 Connected Number: +${phoneNumber}\n` +
                    `👑 Creator: Dimuth Sathsara\n` +
                    `⚙️ Type \`.menu\` to see all commands!\n\n` +
                    `© CREATOR BY DIMUTH SATHSARA`;
                
                await sock.sendMessage(botJid, { 
                    image: { url: 'https://files.catbox.moe/6gq4ub.jpeg' }, 
                    caption: welcomeConnectText 
                });
                await sock.sendMessage(botJid, { 
                    audio: { url: 'https://files.catbox.moe/vsl1wg.mp3' }, 
                    mimetype: 'audio/mp4', 
                    ptt: false 
                });
            } catch (err) {}
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const senderNumber = m.key.participant || from;
            const botNumberRaw = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const botSettings = getSettings(phoneNumber);

            if (botSettings.botPower === "OFF") return;

            if (botSettings.alwaysOnline === "ON") {
                await sock.sendPresenceUpdate('available', from);
            }

            if (botSettings.composing === "ON") {
                await sock.sendPresenceUpdate('composing', from);
            }

            if (botSettings.autoRead === "ON") {
                await sock.readMessages([m.key]);
            }

            if (from === 'status@broadcast' && botSettings.statusRead === "ON") {
                await sock.readMessages([m.key]);
                if (botSettings.statusReact !== "OFF") {
                    const emoji = botSettings.statusReact === "GREEN" ? '💚' : '❤️';
                    await sock.sendMessage(from, { react: { text: emoji, key: m.key } }, { statusJidList: [m.key.participant] });
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

            if (botSettings.botMode === "PRIVATE" && !m.key.fromMe && senderNumber !== botNumberRaw) {
                return;
            }

            let effectiveCommand = command;
            if (cleanBody === '1') effectiveCommand = '.tiktok';
            else if (cleanBody === '2' || cleanBody === '.setting' || cleanBody === '.settings') effectiveCommand = '.settings';
            else if (cleanBody === '4' || cleanBody === '.menu') effectiveCommand = '.menu';

            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
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
            else if (effectiveCommand === '.tiktok' || effectiveCommand === '.tt' || effectiveCommand === '.fb' || effectiveCommand === '.facebook' || effectiveCommand === '.yt' || effectiveCommand === '.youtube') {
                if (!text) {
                    await sock.sendMessage(from, { text: `⚠️ Please provide a valid link!\nExample: \`.tiktok <link>\`` }, { quoted: m });
                    return;
                }
                await sock.sendMessage(from, { text: "⏳ *Downloading your media, please wait...*" }, { quoted: m });
                try {
                    const apiURL = `https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(text)}`;
                    const response = await axios.get(apiURL).catch(() => null);
                    
                    if (response && response.data && response.data.status) {
                        const videoUrl = response.data.data.no_watermark || response.data.data.video;
                        await sock.sendMessage(from, { video: { url: videoUrl }, caption: "📥 *Downloaded by Dimuwa Mini Bot*" }, { quoted: m });
                    } else {
                        await sock.sendMessage(from, { video: { url: text }, caption: "📥 *Downloaded Media*" }, { quoted: m });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: "❌ Failed to download media. Please check the link and try again!" }, { quoted: m });
                }
            }
            else if (effectiveCommand === '.save') {
                const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) {
                    await sock.sendMessage(from, { text: "⚠️ Please reply to a status or media message with *.save* to download it!" }, { quoted: m });
                    return;
                }
                const targetMsg = quotedMsg;
                const type = Object.keys(targetMsg)[0];
                const destination = botSettings.saveTarget === "PRIVATE" ? botNumberRaw : from;
                
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
            }
            else if (effectiveCommand === '.vv') {
                const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) {
                    await sock.sendMessage(from, { text: "⚠️ Please reply to a View-Once message with *.vv* to unlock it!" }, { quoted: m });
                    return;
                }
                
                const innerMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message || quotedMsg;
                const type = Object.keys(innerMsg)[0];
                const mediaMsg = innerMsg[type];
                
                if (!mediaMsg || (type !== 'imageMessage' && type !== 'videoMessage')) {
                    await sock.sendMessage(from, { text: "⚠️ This is not a valid View-Once media message!" }, { quoted: m });
                    return;
                }

                const destination = botSettings.vvTarget === "PRIVATE" ? botNumberRaw : from;
                const mediaType = type === 'imageMessage' ? 'image' : 'video';
                
                const stream = await downloadContentFromMessage(mediaMsg, mediaType);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }

                if (mediaType === 'image') {
                    await sock.sendMessage(destination, { image: buffer, caption: "🔓 *View-Once Unlocked by Dimuwa Bot!*\n\n" + (mediaMsg.caption || '') });
                } else {
                    await sock.sendMessage(destination, { video: buffer, caption: "🔓 *View-Once Unlocked by Dimuwa Bot!*\n\n" + (mediaMsg.caption || '') });
                }
            }
        } catch (e) { console.error(e); }
    });
}
