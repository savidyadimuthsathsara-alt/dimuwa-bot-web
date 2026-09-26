const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

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
    antiDelete: "ON", 
    botPower: "ON",
    vvTarget: "SAME",     
    saveTarget: "SAME"    
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
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const isOwner = m.key.fromMe;
            const botNumberRaw = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const botSettings = getSettings(phoneNumber);

            // Status Auto Read & React Logic
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
            const q = args[1]?.toLowerCase();
            const val = args[2]?.toUpperCase();

            if (command === '.ping') {
                const msgTime = Number(m.messageTimestamp) * 1000;
                await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ Speed: ${Math.abs(Date.now() - msgTime)}ms` }, { quoted: m });
            }
            else if (command === '.alive') {
                await sock.sendMessage(from, { image: { url: 'https://files.catbox.moe/6gq4ub.jpeg' }, caption: '👋 Hello! I am Dimuwa Mini Bot 24/7 active!' }, { quoted: m });
                await sock.sendMessage(from, { audio: { url: 'https://files.catbox.moe/vsl1wg.mp3' }, mimetype: 'audio/mp4', ptt: false }, { quoted: m });
            }
            else if (command === '.setting' || command === '.settings') {
                if (q && val) {
                    if (q === 'vvtarget' && (val === 'SAME' || val === 'PRIVATE')) {
                        botSettings.vvTarget = val;
                        await sock.sendMessage(from, { text: `✅ VV Target updated to: *${val}*` }, { quoted: m });
                        return;
                    } else if (q === 'savetarget' && (val === 'SAME' || val === 'PRIVATE')) {
                        botSettings.saveTarget = val;
                        await sock.sendMessage(from, { text: `✅ Save Target updated to: *${val}*` }, { quoted: m });
                        return;
                    }
                }

                let settingsText = `⚙️ *DIMUWA BOT SETTINGS* ⚙️\n\n` +
                    `• *Always Online:* ${botSettings.alwaysOnline}\n` +
                    `• *Auto Read:* ${botSettings.autoRead}\n` +
                    `• *Bot Mode:* ${botSettings.botMode}\n` +
                    `• *Status Read:* ${botSettings.statusRead}\n` +
                    `• *Status React:* ${botSettings.statusReact}\n` +
                    `• *Anti Delete:* ${botSettings.antiDelete}\n` +
                    `• *Bot Power:* ${botSettings.botPower}\n` +
                    `• *VV Target:* ${botSettings.vvTarget}\n` +
                    `• *Save Target:* ${botSettings.saveTarget}\n\n` +
                    `💡 *How to change targets:* `.setting vvtarget private` or `.setting savetarget same`\n\n` +
                    `© CREATOR BY DIMUTH SATHSARA`;
                
                await sock.sendMessage(from, { text: settingsText }, { quoted: m });
            }
            else if (command === '.menu') {
                const menuText = `🤖 *DIMUWA MINI BOT MENU* 🤖\n\n` +
                    `• *.alive* - Check bot status\n` +
                    `• *.ping* - Check bot speed\n` +
                    `• *.setting* - View/Change bot settings\n` +
                    `• *.save* - Download status/media (Target: ${botSettings.saveTarget})\n` +
                    `• *.vv* - Unlock view-once media (Target: ${botSettings.vvTarget})\n\n` +
                    `© CREATOR BY DIMUTH SATHSARA`;
                
                await sock.sendMessage(from, { image: { url: 'https://files.catbox.moe/6gq4ub.jpeg' }, caption: menuText }, { quoted: m });
                await sock.sendMessage(from, { audio: { url: 'https://files.catbox.moe/vsl1wg.mp3' }, mimetype: 'audio/mp4', ptt: false }, { quoted: m });
            }
            else if (command === '.save') {
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
            else if (command === '.vv') {
                const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) {
                    await sock.sendMessage(from, { text: "⚠️ Please reply to a View-Once message with *.vv* to unlock it!" }, { quoted: m });
                    return;
                }
                const vvMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message;
                if (!vvMsg) {
                    await sock.sendMessage(from, { text: "⚠️ This is not a View-Once message!" }, { quoted: m });
                    return;
                }
                const type = Object.keys(vvMsg)[0];
                const destination = botSettings.vvTarget === "PRIVATE" ? botNumberRaw : from;
                
                if (type === 'imageMessage') {
                    const stream = await downloadContentFromMessage(vvMsg.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                    await sock.sendMessage(destination, { image: buffer, caption: "🔓 *View-Once Unlocked!*\n\n" + (vvMsg.imageMessage.caption || '') });
                } else if (type === 'videoMessage') {
                    const stream = await downloadContentFromMessage(vvMsg.videoMessage, 'video');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                    await sock.sendMessage(destination, { video: buffer, caption: "🔓 *View-Once Unlocked!*\n\n" + (vvMsg.videoMessage.caption || '') });
                }
            }
        } catch (e) { console.error(e); }
    });
}
