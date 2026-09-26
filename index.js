const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
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

// Setup SQLite Database for Users
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

// Serve Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Register API
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Please fill all fields!" });

    db.run(`INSERT INTO users (username, password, phone) VALUES (?, ?, ?)`, [username, password, ""], function(err) {
        if (err) {
            return res.status(400).json({ error: "Username already exists!" });
        }
        res.json({ success: true, message: "Account created successfully!" });
    });
});

// Login API
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Please fill all fields!" });

    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) {
            return res.status(400).json({ error: "Invalid username or password!" });
        }
        res.json({ success: true, username: row.username, phone: row.phone || "" });
    });
});

// Stats API (Active Bots Count)
app.get('/stats', (req, res) => {
    let count = 0;
    if (fs.existsSync('./')) {
        fs.readdirSync('./').forEach(file => {
            if (file.startsWith('session_')) count++;
        });
    }
    res.json({ activeBots: count });
});

// Pair API
app.post('/pair', async (req, res) => {
    let { username, number } = req.body;
    if (!username || !number) return res.status(400).json({ error: "Invalid request!" });
    
    number = number.replace(/[^0-9]/g, '');

    db.run(`UPDATE users SET phone = ? WHERE username = ?`, [number, username], () => {
        startBotForUser(number, res);
    });
});

// Disconnect API
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
}
