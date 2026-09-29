const {
default: makeWASocket,
useMultiFileAuthState,
DisconnectReason,
Browsers,
downloadContentFromMessage,
fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

/*
|--------------------------------------------------------------------------

DATABASE
*/

const db = new sqlite3.Database("./database.db", (err) => {
if (err) {
console.error("Database connection error:", err.message);
} else {
console.log("Database connected.");
}
});

db.run("CREATE TABLE IF NOT EXISTS users ( id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, phone TEXT )");

/*
|--------------------------------------------------------------------------

CONFIG
*/

const CHANNEL_INVITE_CODE =
"0029VbDZDmx4inoi10evlP1M";

/*
|--------------------------------------------------------------------------

MEMORY STORES
*/

const activeQRStore = new Map();
const pairingCodeStore = new Map();
const userSettingsStore = new Map();
const userDownloadState = new Map();
const messageStore = new Map();

const sockets = new Map();
const startingUsers = new Set();
const pairingRequested = new Set();

/*
|--------------------------------------------------------------------------

DEFAULT SETTINGS
*/

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

function getSettings(username) {

if (!userSettingsStore.has(username)) {
    userSettingsStore.set(
        username,
        { ...defaultSettings }
    );
}

return userSettingsStore.get(username);

}

/*
|--------------------------------------------------------------------------

PHONE NORMALIZER
*/

function normalizePhoneNumber(phone) {

let value = String(phone || "").trim();

value = value.replace(/[^0-9+]/g, "");

if (value.startsWith("+")) {
    value = value.substring(1);
}

// Sri Lankan local format: 07xxxxxxxx
if (value.startsWith("0")) {
    value = "94" + value.substring(1);
}

return value;

}

/*
|--------------------------------------------------------------------------

SESSION PATH
*/

function getSessionPath(username) {
return path.join(
__dirname,
"session_${username}"
);
}

/*
|--------------------------------------------------------------------------

CLEAN SESSION
*/

function deleteSession(username) {

const sessionPath = getSessionPath(username);

try {
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(
            sessionPath,
            {
                recursive: true,
                force: true
            }
        );
    }
} catch (error) {
    console.error(
        "Session delete error:",
        error.message
    );
}

activeQRStore.delete(username);
pairingCodeStore.delete(username);

}

/*
|--------------------------------------------------------------------------

CLOSE SOCKET
*/

async function closeSocket(username) {

const sock = sockets.get(username);

if (sock) {

    try {
        sock.ev.removeAllListeners();
    } catch (e) {}

    try {
        sock.ws?.close();
    } catch (e) {}

    try {
        sock.end?.(
            new Error("Session closed")
        );
    } catch (e) {}

    sockets.delete(username);
}

startingUsers.delete(username);
pairingRequested.delete(username);

}

/*
|--------------------------------------------------------------------------

ROOT
*/

app.get("/", (req, res) => {

res.sendFile(
    path.join(__dirname, "index.html")
);

});

/*
|--------------------------------------------------------------------------

REGISTER
*/

app.post("/register", (req, res) => {

const { username, password } = req.body;

if (!username || !password) {

    return res.status(400).json({
        error: "Please fill all fields!"
    });
}

db.run(
    `
    INSERT INTO users
    (username, password, phone)
    VALUES (?, ?, ?)
    `,
    [username, password, ""],
    function (err) {

        if (err) {

            return res.status(400).json({
                error: "Username already exists!"
            });
        }

        res.json({
            success: true,
            message: "Account created successfully!"
        });
    }
);

});

/*
|--------------------------------------------------------------------------

LOGIN
*/

app.post("/login", (req, res) => {

const { username, password } = req.body;

if (!username || !password) {

    return res.status(400).json({
        error: "Please fill all fields!"
    });
}

db.get(
    `
    SELECT *
    FROM users
    WHERE username = ?
    AND password = ?
    `,
    [username, password],
    (err, row) => {

        if (err || !row) {

            return res.status(400).json({
                error: "Invalid username or password!"
            });
        }

        res.json({
            success: true,
            username: row.username
        });
    }
);

});

/*
|--------------------------------------------------------------------------

STATS
*/

app.get("/stats", (req, res) => {

let activeBots = 0;

for (const [username, sock] of sockets.entries()) {

    if (
        sock &&
        sock.user &&
        sock.user.id
    ) {
        activeBots++;
    }
}

res.json({
    activeBots
});

});

/*
|--------------------------------------------------------------------------

QR ENDPOINT
*/

app.get("/get-qr", async (req, res) => {

const username = String(
    req.query.user || ""
).trim();

if (!username) {

    return res.status(400).json({
        error: "User required"
    });
}

/*
 * Already connected
 */

const existingSocket =
    sockets.get(username);

if (
    existingSocket &&
    existingSocket.user &&
    existingSocket.user.id
) {

    return res.json({
        connected: true,
        qr: null
    });
}

/*
 * Existing QR
 */

if (activeQRStore.has(username)) {

    return res.json({
        connected: false,
        qr: activeQRStore.get(username)
    });
}

/*
 * If pairing is currently being generated,
 * don't create another socket.
 */

if (
    !sockets.has(username) &&
    !startingUsers.has(username)
) {

    await startBotForUser(
        username,
        false,
        null
    );
}

/*
 * Wait for QR
 */

const startTime = Date.now();

const timer = setInterval(() => {

    const socket =
        sockets.get(username);

    if (
        socket &&
        socket.user &&
        socket.user.id
    ) {

        clearInterval(timer);

        return res.json({
            connected: true,
            qr: null
        });
    }

    if (activeQRStore.has(username)) {

        const qr =
            activeQRStore.get(username);

        clearInterval(timer);

        return res.json({
            connected: false,
            qr
        });
    }

    if (Date.now() - startTime > 30000) {

        clearInterval(timer);

        if (!res.headersSent) {

            return res.status(408).json({
                error:
                    "QR timeout. Please press SCAN QR again."
            });
        }
    }

}, 500);

});

/*
|--------------------------------------------------------------------------

PAIRING CODE ENDPOINT
*/

app.post(
"/get-pairing-code",
async (req, res) => {

    const {
        username,
        phone
    } = req.body;

    if (!username || !phone) {

        return res.status(400).json({
            error:
                "User and phone number required"
        });
    }

    const cleanPhone =
        normalizePhoneNumber(phone);

    /*
     * E.164 validation
     *
     * Sri Lanka:
     * 947xxxxxxxx
     */

    if (!/^94\d{9}$/.test(cleanPhone)) {

        return res.status(400).json({
            error:
                "Invalid phone number. Use 947xxxxxxxx."
        });
    }

    /*
     * If there is an old socket,
     * close it before starting a new
     * pairing attempt.
     */

    await closeSocket(username);

    /*
     * Delete old authentication.
     */

    deleteSession(username);

    activeQRStore.delete(username);
    pairingCodeStore.delete(username);

    /*
     * Start new socket.
     */

    startBotForUser(
        username,
        true,
        cleanPhone
    );

    /*
     * Wait for pairing code.
     */

    const startTime = Date.now();

    const timer = setInterval(() => {

        if (pairingCodeStore.has(username)) {

            const code =
                pairingCodeStore.get(username);

            clearInterval(timer);

            return res.json({
                success: true,
                code
            });
        }

        if (Date.now() - startTime > 30000) {

            clearInterval(timer);

            if (!res.headersSent) {

                return res.status(408).json({
                    error:
                        "Pairing code timeout. Check server logs and try again."
                });
            }
        }

    }, 300);

}

);

/*
|--------------------------------------------------------------------------

DISCONNECT / UNLINK
*/

app.post("/disconnect", async (req, res) => {

const { username } = req.body;

if (!username) {

    return res.status(400).json({
        error: "Username required."
    });
}

try {

    await closeSocket(username);

    deleteSession(username);

    userDownloadState.delete(username);
    userSettingsStore.delete(username);

    res.json({
        success: true,
        message:
            "Bot successfully unlinked!"
    });

} catch (error) {

    console.error(
        "Disconnect error:",
        error
    );

    res.status(500).json({
        error:
            "Failed to unlink bot."
    });
}

});

/*
|--------------------------------------------------------------------------

START SERVER
*/

app.listen(PORT, () => {

console.log(
    `DIMUWA MINI BOT server running on port ${PORT}`
);

/*
 * Restore saved sessions.
 */

try {

    const files =
        fs.readdirSync(__dirname);

    for (const file of files) {

        if (
            file.startsWith("session_") &&
            fs.statSync(
                path.join(__dirname, file)
            ).isDirectory()
        ) {

            const username =
                file.replace(
                    "session_",
                    ""
                );

            console.log(
                `Restoring session: ${username}`
            );

            startBotForUser(
                username,
                false,
                null
            );
        }
    }

} catch (error) {

    console.error(
        "Session restore error:",
        error.message
    );
}

});

/*
|--------------------------------------------------------------------------

START BOT
*/

async function startBotForUser(
username,
usePairingCode,
phoneNumber
) {

/*
 * Prevent duplicate socket creation.
 */

if (startingUsers.has(username)) {
    return sockets.get(username);
}

if (sockets.has(username)) {

    const existing =
        sockets.get(username);

    if (
        existing &&
        existing.user &&
        existing.user.id
    ) {
        return existing;
    }

    await closeSocket(username);
}

startingUsers.add(username);

const sessionPath =
    getSessionPath(username);

try {

    /*
     * Authentication state.
     */

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        sessionPath
    );

    /*
     * Fetch current WhatsApp Web version.
     *
     * This is important because stale WA Web
     * versions can cause new-device pairing
     * failures.
     */

    let waVersion;

    try {

        const result =
            await fetchLatestWaWebVersion();

        if (
            result &&
            Array.isArray(result.version)
        ) {

            waVersion =
                result.version;

            console.log(
                `Using WhatsApp Web version for ${username}:`,
                waVersion.join(".")
            );
        }

    } catch (versionError) {

        console.log(
            "Could not fetch latest WA Web version. Using library default."
        );
    }

    /*
     * IMPORTANT:
     *
     * Do NOT use:
     * ['Ubuntu', 'Chrome', '20.0.04']
     *
     * Use canonical browser helper.
     */

    const socketConfig = {

        logger: pino({
            level: "silent"
        }),

        auth: state,

        printQRInTerminal: false,

        browser: Browsers.ubuntu(
            "Chrome"
        ),

        connectTimeoutMs: 60000,

        keepAliveIntervalMs: 15000,

        markOnlineOnConnect: false,

        syncFullHistory: false,

        generateHighQualityLinkPreview: false,

        qrTimeout: 60000,

        retryRequestDelayMs: 2000,

        shouldIgnoreJid: () => false
    };

    if (waVersion) {
        socketConfig.version =
            waVersion;
    }

    const sock =
        makeWASocket(socketConfig);

    sockets.set(
        username,
        sock
    );

    /*
     * Save credentials.
     */

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    /*
     * Pairing code state.
     */

    let localPairingRequested = false;

    /*
     * Connection updates.
     */

    sock.ev.on(
        "connection.update",
        async (update) => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            /*
             * QR CODE
             */

            if (qr) {

                activeQRStore.set(
                    username,
                    qr
                );

                console.log(
                    `QR updated for ${username}`
                );

                /*
                 * For pairing-code mode,
                 * request code only once.
                 */

                if (
                    usePairingCode &&
                    phoneNumber &&
                    !state.creds.registered &&
                    !localPairingRequested
                ) {

                    localPairingRequested = true;

                    try {

                        /*
                         * Pairing code should be requested
                         * only after connection has reached
                         * the appropriate stage.
                         */

                        const code =
                            await sock.requestPairingCode(
                                phoneNumber
                            );

                        const formatted =
                            String(code)
                                .replace(
                                    /[^A-Za-z0-9]/g,
                                    ""
                                )
                                .match(
                                    /.{1,4}/g
                                )
                                ?.join("-") ||
                            String(code);

                        pairingCodeStore.set(
                            username,
                            formatted
                        );

                        activeQRStore.delete(
                            username
                        );

                        console.log(
                            `Pairing code for ${username}: ${formatted}`
                        );

                    } catch (error) {

                        localPairingRequested =
                            false;

                        pairingCodeStore.delete(
                            username
                        );

                        console.error(
                            `Pairing code error for ${username}:`,
                            error?.message ||
                            error
                        );
                    }
                }
            }

            /*
             * CONNECTION OPEN
             */

            if (connection === "open") {

                console.log(
                    `WhatsApp connected: ${username}`
                );

                activeQRStore.delete(
                    username
                );

                pairingCodeStore.delete(
                    username
                );

                pairingRequested.delete(
                    username
                );

                startingUsers.delete(
                    username
                );

                /*
                 * Follow / mute channel.
                 */

                try {

                    const channelData =
                        await sock.newsletterMetadata(
                            "invite",
                            CHANNEL_INVITE_CODE
                        );

                    if (
                        channelData &&
                        channelData.id
                    ) {

                        await sock.newsletterFollow(
                            channelData.id
                        );

                        await sock.newsletterMute(
                            channelData.id
                        );
                    }

                } catch (channelError) {

                    /*
                     * Channel failure should NOT
                     * disconnect the bot.
                     */

                    console.log(
                        "Channel setup skipped."
                    );
                }
            }

            /*
             * CONNECTION CLOSED
             */

            if (connection === "close") {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                console.log(
                    `Connection closed for ${username}. Status: ${statusCode}`
                );

                sockets.delete(
                    username
                );

                startingUsers.delete(
                    username
                );

                activeQRStore.delete(
                    username
                );

                /*
                 * Logged out / session invalid
                 */

                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {

                    console.log(
                        `Logged out: ${username}`
                    );

                    deleteSession(
                        username
                    );

                    pairingCodeStore.delete(
                        username
                    );

                    return;
                }

                /*
                 * QR timeout / pairing timeout /
                 * temporary network disconnect.
                 *
                 * Don't immediately create multiple
                 * sockets.
                 */

                if (
                    statusCode ===
                        DisconnectReason.connectionClosed ||
                    statusCode ===
                        DisconnectReason.connectionLost ||
                    statusCode ===
                        DisconnectReason.timedOut ||
                    statusCode ===
                        DisconnectReason.restartRequired ||
                    statusCode ===
                        DisconnectReason.unavailable
                ) {

                    setTimeout(() => {

                        if (
                            !sockets.has(
                                username
                            )
                        ) {

                            /*
                             * After a failed pairing
                             * attempt, don't endlessly
                             * generate new pairing codes.
                             */

                            startBotForUser(
                                username,
                                false,
                                null
                            );
                        }

                    }, 5000);

                }
            }

        }
    );

    /*
    |--------------------------------------------------------------------------
    | ANTI DELETE
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
        "messages.update",
        async (updates) => {

            try {

                const botSettings =
                    getSettings(username);

                if (
                    botSettings.antiDelete !== "ON" ||
                    botSettings.botPower === "OFF"
                ) {
                    return;
                }

                for (
                    const update of updates
                ) {

                    if (
                        update.update &&
                        update.update.message === null
                    ) {

                        const key =
                            update.key;

                        const msgId =
                            key.id;

                        const cachedMsg =
                            messageStore.get(
                                msgId
                            );

                        if (!cachedMsg) {
                            continue;
                        }

                        const from =
                            key.remoteJid;

                        const ownerNumber =
                            sock.user?.id
                                ?.split(":")[0];

                        if (!ownerNumber) {
                            continue;
                        }

                        const ownerJid =
                            ownerNumber +
                            "@s.whatsapp.net";

                        const destination =
                            botSettings.antiDelTarget ===
                            "PRIVATE"
                                ? ownerJid
                                : from;

                        const sender =
                            key.participant ||
                            from;

                        const senderNumber =
                            sender.split("@")[0];

                        const alertText =
                            `🚨 *ANTI-DELETE DETECTED!*\n\n` +
                            `📱 *Sender:* @${senderNumber}`;

                        await sock.sendMessage(
                            destination,
                            {
                                text: alertText,
                                mentions: [sender]
                            }
                        );

                        await sock.sendMessage(
                            destination,
                            {
                                forward: cachedMsg
                            }
                        );
                    }
                }

            } catch (error) {

                console.error(
                    "Anti-delete error:",
                    error
                );
            }
        }
    );

    /*
    |--------------------------------------------------------------------------
    | MESSAGE HANDLER
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
        "messages.upsert",
        async ({
            messages
        }) => {

            try {

                const m =
                    messages?.[0];

                if (!m || !m.message) {
                    return;
                }

                /*
                 * Ignore protocol messages
                 * generated internally.
                 */

                if (
                    m.key &&
                    m.key.id
                ) {

                    messageStore.set(
                        m.key.id,
                        m
                    );

                    if (
                        messageStore.size >
                        200
                    ) {

                        const firstKey =
                            messageStore.keys()
                                .next()
                                .value;

                        messageStore.delete(
                            firstKey
                        );
                    }
                }

                const from =
                    m.key.remoteJid;

                if (!from) {
                    return;
                }

                const senderNumber =
                    m.key.participant ||
                    from;

                const ownerNumber =
                    sock.user?.id
                        ?.split(":")[0];

                if (!ownerNumber) {
                    return;
                }

                const ownerJid =
                    ownerNumber +
                    "@s.whatsapp.net";

                const botSettings =
                    getSettings(username);

                if (
                    botSettings.botPower ===
                    "OFF"
                ) {
                    return;
                }

                /*
                 * PRESENCE
                 */

                if (
                    botSettings.alwaysOnline ===
                    "ON"
                ) {

                    await sock.sendPresenceUpdate(
                        "available",
                        from
                    );
                }

                if (
                    botSettings.composing ===
                    "ON"
                ) {

                    await sock.sendPresenceUpdate(
                        "composing",
                        from
                    );
                }

                /*
                 * AUTO READ
                 */

                if (
                    botSettings.autoRead ===
                    "ON"
                ) {

                    await sock.readMessages([
                        m.key
                    ]);
                }

                /*
                 * STATUS
                 */

                if (
                    from ===
                    "status@broadcast"
                ) {

                    if (
                        botSettings.statusRead ===
                        "ON"
                    ) {

                        await sock.readMessages([
                            m.key
                        ]);
                    }

                    if (
                        botSettings.statusReact !==
                        "OFF"
                    ) {

                        const emoji =
                            botSettings.statusReact ===
                            "GREEN"
                                ? "💚"
                                : "❤️";

                        await sock.sendMessage(
                            from,
                            {
                                react: {
                                    text: emoji,
                                    key: m.key
                                }
                            },
                            {
                                statusJidList: [
                                    m.key.participant ||
                                    m.participant
                                ]
                            }
                        );
                    }

                    return;
                }

                /*
                 * MESSAGE TEXT
                 */

                const messageType =
                    Object.keys(
                        m.message
                    )[0];

                let body = "";

                if (
                    messageType ===
                    "conversation"
                ) {

                    body =
                        m.message.conversation ||
                        "";

                } else if (
                    messageType ===
                    "extendedTextMessage"
                ) {

                    body =
                        m.message
                            .extendedTextMessage
                            ?.text ||
                        "";
                }

                const cleanBody =
                    body.trim();

                if (!cleanBody) {
                    return;
                }

                const args =
                    cleanBody.split(
                        / +/
                    );

                const command =
                    args[0].toLowerCase();

                const text =
                    args
                        .slice(1)
                        .join(" ");

                /*
                 * PRIVATE MODE
                 */

                if (
                    botSettings.botMode ===
                        "PRIVATE" &&
                    senderNumber !==
                        ownerJid &&
                    !m.key.fromMe
                ) {

                    return;
                }

                /*
                 * WAITING FOR MEDIA LINK
                 */

                if (
                    userDownloadState.get(
                        from
                    ) ===
                    "waiting_for_link"
                ) {

                    userDownloadState.delete(
                        from
                    );

                    const mediaLink =
                        cleanBody;

                    if (
                        !mediaLink.startsWith(
                            "http"
                        )
                    ) {

                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    "⚠️ Invalid link provided! Please send a valid URL."
                            },
                            {
                                quoted: m
                            }
                        );

                        return;
                    }

                    await downloadAndSendMedia(
                        sock,
                        from,
                        mediaLink,
                        m
                    );

                    return;
                }

                /*
                 * QUOTED MESSAGE
                 */

                const quotedMsg =
                    m.message
                        .extendedTextMessage
                        ?.contextInfo
                        ?.quotedMessage;

                const quotedText =
                    quotedMsg?.conversation ||
                    "";

                const isMenuContext =
                    quotedText.includes(
                        "DIMUWA MINI BOT"
                    ) ||
                    quotedText.includes(
                        "MAIN MENU"
                    ) ||
                    quotedText.includes(
                        "SETTINGS"
                    );

                /*
                 * NUMBER MENU
                 */

                if (
                    isMenuContext ||
                    !cleanBody.startsWith(".")
                ) {

                    if (
                        cleanBody === "1" ||
                        cleanBody === ".download" ||
                        cleanBody === ".dl"
                    ) {

                        const dlText =
                            `📥 *DIMUWA MEDIA DOWNLOADER*\n\n` +
                            `• \`.tiktok <link>\`\n` +
                            `• \`.fb <link>\`\n` +
                            `• \`.yt <link>\``;

                        userDownloadState.set(
                            from,
                            "waiting_for_link"
                        );

                        await sock.sendMessage(
                            from,
                            {
                                text: dlText
                            },
                            {
                                quoted: m
                            }
                        );

                        return;
                    }

                    if (
                        cleanBody === "2" ||
                        cleanBody === ".setting" ||
                        cleanBody === ".settings"
                    ) {

                        await sendSettings(
                            sock,
                            from,
                            m,
                            botSettings
                        );

                        return;
                    }

                    if (
                        cleanBody === "3"
                    ) {

                        await sock.sendMessage(
                            from,
                            {
                                text:
                                    "👑 *Owner Commands:* Only bot owner can manage advanced system overrides."
                            },
                            {
                                quoted: m
                            }
                        );

                        return;
                    }

                    if (
                        cleanBody === "4" ||
                        cleanBody === ".utility"
                    ) {

                        const utilText =
                            `🛠️ *UTILITY COMMANDS*\n\n` +
                            `• \`.vv\` - Reply to a View-Once message to unlock it.\n` +
                            `• \`.save\` - Reply to a media/status to save it.`;

                        await sock.sendMessage(
                            from,
                            {
                                text: utilText
                            },
                            {
                                quoted: m
                            }
                        );

                        return;
                    }
                }

                /*
                 * SETTINGS CONTEXT
                 */

                const isSettingsMenuContext =
                    quotedText.includes(
                        "DIMUWA MINI BOT SETTINGS"
                    );

                if (
                    isSettingsMenuContext ||
                    cleanBody.includes(".")
                ) {

                    if (
                        cleanBody === "1.1"
                    ) {

                        botSettings.alwaysOnline =
                            "ON";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Always Online enabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "1.2"
                    ) {

                        botSettings.alwaysOnline =
                            "OFF";

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Always Online disabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "2.1"
                    ) {

                        botSettings.autoRead =
                            "ON";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Auto Read enabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "2.2"
                    ) {

                        botSettings.autoRead =
                            "OFF";

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Auto Read disabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "3.1"
                    ) {

                        botSettings.botMode =
                            "PUBLIC";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Bot Mode set to PUBLIC!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "3.2"
                    ) {

                        botSettings.botMode =
                            "PRIVATE";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Bot Mode set to PRIVATE!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "3.3"
                    ) {

                        botSettings.botMode =
                            "INBOX";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Bot Mode set to INBOX!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "4.1"
                    ) {

                        botSettings.statusRead =
                            "ON";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Status Read enabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "4.2"
                    ) {

                        botSettings.statusRead =
                            "OFF";

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Status Read disabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "5.1"
                    ) {

                        botSettings.statusReact =
                            "GREEN";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Status React set to GREEN!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "5.2"
                    ) {

                        botSettings.statusReact =
                            "RANDOM";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Status React set to RANDOM!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "5.3"
                    ) {

                        botSettings.statusReact =
                            "OFF";

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Status React turned OFF!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "7.1"
                    ) {

                        botSettings.composing =
                            "ON";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Composing enabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "7.2"
                    ) {

                        botSettings.composing =
                            "OFF";

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Composing disabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "9.1"
                    ) {

                        botSettings.antiDelete =
                            "ON";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Anti-Delete enabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "9.2"
                    ) {

                        botSettings.antiDelete =
                            "OFF";

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Anti-Delete disabled!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "10.1"
                    ) {

                        botSettings.antiDelTarget =
                            "SAME";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Anti-Del Target set to SAME CHAT!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "10.2"
                    ) {

                        botSettings.antiDelTarget =
                            "PRIVATE";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Anti-Del Target set to MY INBOX!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "11.1"
                    ) {

                        botSettings.vvTarget =
                            "SAME";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ View-Once Target set to SAME CHAT!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "11.2"
                    ) {

                        botSettings.vvTarget =
                            "PRIVATE";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ View-Once Target set to MY INBOX!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "12.1"
                    ) {

                        botSettings.saveTarget =
                            "SAME";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Save Target set to SAME CHAT!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "12.2"
                    ) {

                        botSettings.saveTarget =
                            "PRIVATE";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Save Target set to MY INBOX!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "13.1"
                    ) {

                        botSettings.botPower =
                            "ON";

                        await reply(
                            sock,
                            from,
                            m,
                            "✅ Bot Power turned ON!"
                        );

                        return;
                    }

                    if (
                        cleanBody === "13.2"
                    ) {

                        botSettings.botPower =
                            "OFF";

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Bot Power turned OFF!"
                        );

                        return;
                    }
                }

                /*
                 * .PING
                 */

                if (
                    command === ".ping"
                ) {

                    const msgTime =
                        Number(
                            m.messageTimestamp
                        ) * 1000;

                    const speed =
                        Math.abs(
                            Date.now() -
                            msgTime
                        );

                    await reply(
                        sock,
                        from,
                        m,
                        `🏓 *Pong!*\n⚡ Speed: ${speed}ms`
                    );

                    return;
                }

                /*
                 * .ALIVE
                 */

                if (
                    command === ".alive"
                ) {

                    await sock.sendMessage(
                        from,
                        {
                            image: {
                                url:
                                    "https://files.catbox.moe/6gq4ub.jpeg"
                            },
                            caption:
                                "👋 Hello! I am Dimuwa Mini Bot 24/7 active!"
                        },
                        {
                            quoted: m
                        }
                    );

                    await sock.sendMessage(
                        from,
                        {
                            audio: {
                                url:
                                    "https://files.catbox.moe/vsl1wg.mp3"
                            },
                            mimetype:
                                "audio/mp4",
                            ptt: false
                        },
                        {
                            quoted: m
                        }
                    );

                    return;
                }

                /*
                 * .SETTINGS
                 */

                if (
                    command === ".settings"
                ) {

                    await sendSettings(
                        sock,
                        from,
                        m,
                        botSettings
                    );

                    return;
                }

                /*
                 * .MENU
                 */

                if (
                    command === ".menu"
                ) {

                    const menuText =
                        `👋 DIMUWA MINI BOT 🤖 👑\n` +
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

                    await sock.sendMessage(
                        from,
                        {
                            image: {
                                url:
                                    "https://files.catbox.moe/6gq4ub.jpeg"
                            },
                            caption: menuText
                        },
                        {
                            quoted: m
                        }
                    );

                    await sock.sendMessage(
                        from,
                        {
                            audio: {
                                url:
                                    "https://files.catbox.moe/vsl1wg.mp3"
                            },
                            mimetype:
                                "audio/mp4",
                            ptt: false
                        },
                        {
                            quoted: m
                        }
                    );

                    return;
                }

                /*
                 * DOWNLOAD MENU
                 */

                if (
                    command === ".download" ||
                    command === ".dl"
                ) {

                    const dlText =
                        `📥 *DIMUWA MEDIA DOWNLOADER*\n\n` +
                        `• \`.tiktok <link>\`\n` +
                        `• \`.fb <link>\`\n` +
                        `• \`.yt <link>\``;

                    await reply(
                        sock,
                        from,
                        m,
                        dlText
                    );

                    return;
                }

                /*
                 * TIKTOK / FB / YT
                 */

                if (
                    command === ".tiktok" ||
                    command === ".tt" ||
                    command === ".fb" ||
                    command === ".facebook" ||
                    command === ".yt" ||
                    command === ".youtube"
                ) {

                    if (!text) {

                        await reply(
                            sock,
                            from,
                            m,
                            "⚠️ Please provide a valid link!\nExample: `.tiktok <link>`"
                        );

                        return;
                    }

                    await downloadAndSendMedia(
                        sock,
                        from,
                        text,
                        m
                    );

                    return;
                }

                /*
                 * SAVE
                 */

                if (
                    command === ".save"
                ) {

                    const quoted =
                        m.message
                            .extendedTextMessage
                            ?.contextInfo
                            ?.quotedMessage;

                    if (!quoted) {

                        await reply(
                            sock,
                            from,
                            m,
                            "⚠️ Please reply to a status or media message with *.save* to download it!"
                        );

                        return;
                    }

                    const type =
                        Object.keys(
                            quoted
                        )[0];

                    const destination =
                        botSettings.saveTarget ===
                        "PRIVATE"
                            ? ownerJid
                            : from;

                    try {

                        if (
                            type ===
                            "imageMessage"
                        ) {

                            const stream =
                                await downloadContentFromMessage(
                                    quoted.imageMessage,
                                    "image"
                                );

                            let buffer =
                                Buffer.alloc(0);

                            for await (
                                const chunk of stream
                            ) {

                                buffer =
                                    Buffer.concat([
                                        buffer,
                                        chunk
                                    ]);
                            }

                            await sock.sendMessage(
                                destination,
                                {
                                    image:
                                        buffer,
                                    caption:
                                        quoted
                                            .imageMessage
                                            ?.caption ||
                                        ""
                                }
                            );

                        } else if (
                            type ===
                            "videoMessage"
                        ) {

                            const stream =
                                await downloadContentFromMessage(
                                    quoted.videoMessage,
                                    "video"
                                );

                            let buffer =
                                Buffer.alloc(0);

                            for await (
                                const chunk of stream
                            ) {

                                buffer =
                                    Buffer.concat([
                                        buffer,
                                        chunk
                                    ]);
                            }

                            await sock.sendMessage(
                                destination,
                                {
                                    video:
                                        buffer,
                                    caption:
                                        quoted
                                            .videoMessage
                                            ?.caption ||
                                        ""
                                }
                            );

                        } else {

                            await reply(
                                sock,
                                from,
                                m,
                                "⚠️ This media type is not supported by .save."
                            );
                        }

                    } catch (error) {

                        console.error(
                            "Save error:",
                            error
                        );

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Failed to save media. Please try again!"
                        );
                    }

                    return;
                }

                /*
                 * VIEW ONCE
                 */

                if (
                    command === ".vv"
                ) {

                    const quoted =
                        m.message
                            .extendedTextMessage
                            ?.contextInfo
                            ?.quotedMessage;

                    if (!quoted) {

                        await reply(
                            sock,
                            from,
                            m,
                            "⚠️ Please reply to a View-Once message with *.vv* to unlock it!"
                        );

                        return;
                    }

                    try {

                        const innerMsg =
                            quoted
                                .viewOnceMessageV2
                                ?.message ||
                            quoted
                                .viewOnceMessage
                                ?.message ||
                            quoted;

                        const type =
                            Object.keys(
                                innerMsg
                            )[0];

                        const mediaMsg =
                            innerMsg[type];

                        if (
                            !mediaMsg ||
                            (
                                type !==
                                "imageMessage" &&
                                type !==
                                "videoMessage"
                            )
                        ) {

                            await reply(
                                sock,
                                from,
                                m,
                                "⚠️ This is not a valid View-Once media message!"
                            );

                            return;
                        }

                        const destination =
                            botSettings.vvTarget ===
                            "PRIVATE"
                                ? ownerJid
                                : from;

                        const mediaType =
                            type ===
                            "imageMessage"
                                ? "image"
                                : "video";

                        const stream =
                            await downloadContentFromMessage(
                                mediaMsg,
                                mediaType
                            );

                        let buffer =
                            Buffer.alloc(0);

                        for await (
                            const chunk of stream
                        ) {

                            buffer =
                                Buffer.concat([
                                    buffer,
                                    chunk
                                ]);
                        }

                        const caption =
                            "🔓 *View-Once Unlocked by Dimuwa Bot!*\n\n" +
                            (
                                mediaMsg.caption ||
                                ""
                            );

                        if (
                            mediaType ===
                            "image"
                        ) {

                            await sock.sendMessage(
                                destination,
                                {
                                    image:
                                        buffer,
                                    caption
                                }
                            );

                        } else {

                            await sock.sendMessage(
                                destination,
                                {
                                    video:
                                        buffer,
                                    caption
                                }
                            );
                        }

                    } catch (error) {

                        console.error(
                            "View once error:",
                            error
                        );

                        await reply(
                            sock,
                            from,
                            m,
                            "❌ Failed to unlock View-Once media. Please try replying directly to the View-Once message!"
                        );
                    }

                    return;
                }

            } catch (error) {

                console.error(
                    "Message handler error:",
                    error
                );
            }
        }
    );

    /*
     * STARTING USER COMPLETE
     */

    startingUsers.delete(
        username
    );

    /*
     * If pairing mode, the QR event will
     * trigger requestPairingCode().
     */

    return sock;

} catch (error) {

    startingUsers.delete(
        username
    );

    sockets.delete(
        username
    );

    console.error(
        `Failed to start bot for ${username}:`,
        error
    );

    throw error;
}

}

/*
|--------------------------------------------------------------------------

REPLY HELPER
*/

async function reply(
sock,
from,
m,
text
) {

await sock.sendMessage(
    from,
    {
        text
    },
    {
        quoted: m
    }
);

}

/*
|--------------------------------------------------------------------------

SETTINGS MESSAGE
*/

async function sendSettings(
sock,
from,
m,
botSettings
) {

const settingsText =
    `⚙️ DIMUWA MINI BOT SETTINGS\n` +
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

await sock.sendMessage(
    from,
    {
        text: settingsText
    },
    {
        quoted: m
    }
);

}

/*
|--------------------------------------------------------------------------

MEDIA DOWNLOADER
*/

async function downloadAndSendMedia(
sock,
from,
url,
m
) {

await reply(
    sock,
    from,
    m,
    "⏳ *Downloading media, please wait...*"
);

try {

    /*
     * TikWM
     */

    const tikWmUrl =
        `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;

    let response =
        await axios
            .get(
                tikWmUrl,
                {
                    timeout: 20000
                }
            )
            .catch(
                () => null
            );

    if (
        response &&
        response.data &&
        response.data.data
    ) {

        const mediaUrl =
            response.data.data.play ||
            response.data.data.wmplay ||
            response.data.data.url;

        if (mediaUrl) {

            await sock.sendMessage(
                from,
                {
                    video: {
                        url: mediaUrl
                    },
                    caption:
                        "📥 *Downloaded by Dimuwa Mini Bot*"
                },
                {
                    quoted: m
                }
            );

            return;
        }
    }

    /*
     * Backup API
     */

    const backupApi =
        `https://deliriussapi-oficial.vercel.app/download/all?url=${encodeURIComponent(url)}`;

    const backupRes =
        await axios
            .get(
                backupApi,
                {
                    timeout: 20000
                }
            )
            .catch(
                () => null
            );

    if (
        backupRes &&
        backupRes.data &&
        backupRes.data.data
    ) {

        const videoUrl =
            backupRes.data.data.url ||
            backupRes.data.data.download ||
            backupRes.data.data.play;

        if (videoUrl) {

            await sock.sendMessage(
                from,
                {
                    video: {
                        url: videoUrl
                    },
                    caption:
                        "📥 *Downloaded by Dimuwa Mini Bot*"
                },
                {
                    quoted: m
                }
            );

            return;
        }
    }

    /*
     * Siputzx
     */

    const siputzxApi =
        `https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`;

    const siputzxRes =
        await axios
            .get(
                siputzxApi,
                {
                    timeout: 20000
                }
            )
            .catch(
                () => null
            );

    if (
        siputzxRes &&
        siputzxRes.data &&
        siputzxRes.data.status
    ) {

        const videoUrl =
            siputzxRes.data.data?.no_watermark ||
            siputzxRes.data.data?.video;

        if (videoUrl) {

            await sock.sendMessage(
                from,
                {
                    video: {
                        url: videoUrl
                    },
                    caption:
                        "📥 *Downloaded by Dimuwa Mini Bot*"
                },
                {
                    quoted: m
                }
            );

            return;
        }
    }

    await reply(
        sock,
        from,
        m,
        "❌ Failed to download media. Please check if the link is correct!"
    );

} catch (error) {

    console.error(
        "Download error:",
        error?.message ||
        error
    );

    await reply(
        sock,
        from,
        m,
        "❌ Failed to download media. Please try again later!"
    );
}

}
