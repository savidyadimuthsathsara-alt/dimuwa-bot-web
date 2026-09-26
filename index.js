const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 🔴 YOUR WHATSAPP CHANNEL INVITE CODE
const CHANNEL_INVITE_CODE = "0029VbDZDmx4inoi10evlP1M";

const messageStore = new Map();
const userSettingsStore = new Map();

const defaultSettings = {
    alwaysOnline: "OFF", autoRead: "OFF", botMode: "PUBLIC",
    statusRead: "ON", statusReact: "GREEN", composing: "ON",
    antiDelete: "ON", antiDelTarget: "SAME", vvTarget: "SAME",
    saveTarget: "SAME", botPower: "ON"
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

app.post('/pair', async (req, res) => {
    let phoneNumber = req.body.number;
    if (!phoneNumber) return res.status(400).json({ error: "Please provide a phone number!" });
    
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    startBotForUser(phoneNumber, res);
});

app.listen(PORT, () => {
    console.log(`Dimuwa Dashboard is running on port ${PORT}`);
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
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: 0, 
        keepAliveIntervalMs: 10000, 
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered && res) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code; 
                res.json({ success: true, code: code });
            } catch (err) {
                console.log(`⚠️ Pairing Error for ${phoneNumber}:`, err.message);
                res.status(500).json({ error: "Server is busy or too many requests. Please try again in 5 minutes!" });
            }
        }, 4000); 
    } else if (res) {
        res.json({ error: "This number is already linked!" });
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) {
                startBotForUser(phoneNumber, null);
            } else {
                fs.rmSync(`./session_${phoneNumber}`, { recursive: true, force: true });
                console.log(`Session deleted for ${phoneNumber} (Logged out)`);
            }
        } else if (connection === 'open') {
            console.log(`✅ Bot connected successfully for ${phoneNumber}!`);
            
            try {
                const channelData = await sock.newsletterMetadata("invite", CHANNEL_INVITE_CODE);
                await sock.newsletterFollow(channelData.id);
                await sock.newsletterMute(channelData.id); 
                console.log(`✅ Auto Followed the Channel for ${phoneNumber}`);
            } catch (err) {
                console.log(`⚠️ Channel auto-follow error for ${phoneNumber}:`, err.message);
            }

            try {
                const botNumberRaw = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const welcomeText = `🎉 *DIMUWA MINI BOT SUCCESSFULLY LINKED!* 🎉\n\nYour WhatsApp account has been successfully connected to the bot! 🚀\n\nYou can now use the bot. Type *.menu* or *.alive* to test.\n\n⚙️ Use *.settings* to change preferences.\n\n© CREATOR BY DIMUTH SATHSARA`;
                
                await sock.sendMessage(botNumberRaw, { 
                    image: { url: 'https://files.catbox.moe/6gq4ub.jpeg' }, 
                    caption: welcomeText 
                });
                
                await sock.sendMessage(botNumberRaw, { 
                    audio: { url: 'https://files.catbox.moe/vsl1wg.mp3' }, 
                    mimetype: 'audio/mp4', 
                    ptt: false 
                });
            } catch (err) {
                console.log("⚠️ Welcome message error:", err.message);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const botNumberRaw = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const sender = isGroup ? m.key.participant : from;
            const isOwner = m.key.fromMe;
            
            const botSettings = getSettings(phoneNumber);

            if (m.key && m.key.id) messageStore.set(m.key.id, m);

            if (from === 'status@broadcast' && botSettings.statusRead === "ON") {
                await sock.readMessages([m.key]);
                if (botSettings.statusReact !== "OFF") {
                    const reactionEmoji = botSettings.statusReact === "GREEN" ? '💚' : '❤️';
                    await sock.sendMessage(from, { react: { text: reactionEmoji, key: m.key } }, { statusJidList: [m.key.participant] });
                }
                return;
            }

            if (botSettings.botPower === "OFF" && !isOwner) return;
            if (botSettings.botMode === "PRIVATE" && !isOwner) return;

            const messageType = Object.keys(m.message)[0];
            let body = '';
            if (messageType === 'conversation') body = m.message.conversation;
            else if (messageType === 'extendedTextMessage') body = m.message.extendedTextMessage.text;
            else if (messageType === 'imageMessage' && m.message.imageMessage.caption) body = m.message.imageMessage.caption;
            else if (messageType === 'videoMessage' && m.message.videoMessage.caption) body = m.message.videoMessage.caption;

            const cleanBody = body.trim();
            const args = cleanBody.split(/ +/);
            const command = args[0].toLowerCase();
            const q = args.slice(1).join(' ');

            if (command.startsWith('.') && !isOwner) {
                try {
                    const channelData = await sock.newsletterMetadata("invite", CHANNEL_INVITE_CODE);
                    const role = channelData.viewer_metadata?.role; 
                    if (role === "GUEST" || !role) {
                        await sock.sendMessage(from, { text: "⚠️ *DIMUWA MINI BOT ALERT*\n\nYou have unfollowed the Official Channel. The bot will now be disconnected!" }, { quoted: m });
                        await sock.logout(); 
                        return; 
                    }
                } catch (e) { console.log("Follow Check Error"); }
            }

            if (command === '.ping') {
                const msgTime = Number(m.messageTimestamp) * 1000;
                await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ Speed: ${Math.abs(Date.now() - msgTime)}ms` }, { quoted: m });
            }
            else if (command === '.alive') {
                await sock.sendMessage(from, { image: { url: 'https://files.catbox.moe/6gq4ub.jpeg' }, caption: '👋 Hello! I am Dimuwa Mini Bot 24/7 active!' }, { quoted: m });
                await sock.sendMessage(from, { audio: { url: 'https://files.catbox.moe/vsl1wg.mp3' }, mimetype: 'audio/mp4', ptt: false }, { quoted: m });
            }
        } catch (e) { console.error(e); }
    });
}
