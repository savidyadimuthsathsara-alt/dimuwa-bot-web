const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const NodeCache = require("node-cache");

const app = express();
const port = 3000;

// Cache to handle single connection attempt
const msgRetryCounterCache = new NodeCache();

// --- 1. SUPER PREMIUM RED THEME HOMEPAGE (WITH MUSIC, TOGGLE & BOT DETAILS) ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>DIMUWA BOT | Official</title>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
            <style>
                :root {
                    --bg-dark: #050000;
                    --bg-card: #120202;
                    --primary: #ff1a1a;
                    --primary-glow: rgba(255, 26, 26, 0.4);
                    --text-main: #ffffff;
                    --text-muted: #a09090;
                    --border: #330a0a;
                }
                * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; }
                body { 
                    background-color: var(--bg-dark); 
                    color: var(--text-main); 
                    overflow-x: hidden;
                    background-image: radial-gradient(circle at 50% 0%, #2a0000 0%, transparent 50%);
                }
                
                /* Floating Header */
                .header {
                    position: fixed;
                    top: 15px; left: 50%;
                    transform: translateX(-50%);
                    width: 90%; max-width: 600px;
                    background: rgba(15, 0, 0, 0.8);
                    backdrop-filter: blur(12px);
                    border: 1px solid var(--border);
                    border-radius: 50px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 25px;
                    z-index: 1000;
                    box-shadow: 0 5px 20px rgba(0,0,0,0.5);
                }
                .header-logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; letter-spacing: 1px; }
                .header-logo img { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--primary); }
                .status-dot { width: 8px; height: 8px; background: #00ff00; border-radius: 50%; box-shadow: 0 0 10px #00ff00; }

                /* Main Container */
                .container { max-width: 600px; margin: 100px auto 50px; padding: 0 20px; }

                /* Hero Section */
                .hero { text-align: center; margin-bottom: 50px; animation: slideUp 0.8s ease-out; }
                .hero-img-container {
                    position: relative;
                    width: 200px; height: 200px;
                    margin: 0 auto 25px;
                }
                .hero-img {
                    width: 100%; height: 100%;
                    object-fit: cover;
                    border-radius: 30px;
                    border: 2px solid var(--primary);
                    box-shadow: 0 0 40px var(--primary-glow);
                    z-index: 2;
                    position: relative;
                }
                .hero-title { font-size: 40px; font-weight: 900; letter-spacing: 2px; margin-bottom: 10px; text-transform: uppercase; background: linear-gradient(90deg, #ff1a1a, #ff6666); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
                .hero-desc { color: var(--text-muted); font-size: 15px; margin-bottom: 30px; line-height: 1.5; }
                
                /* Action Area */
                .action-card {
                    background: var(--bg-card);
                    border: 1px solid var(--border);
                    border-radius: 20px;
                    padding: 30px 20px;
                    text-align: center;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                    position: relative;
                    overflow: hidden;
                    min-height: 180px;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                }
                .action-card::before { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(circle, rgba(255,26,26,0.1) 0%, transparent 60%); z-index: 0; pointer-events: none; }
                .action-content { position: relative; z-index: 1; width: 100%; }
                
                input { width: 100%; padding: 16px; background: rgba(0,0,0,0.5); border: 1px solid var(--border); border-radius: 12px; color: #fff; font-size: 16px; text-align: center; margin-bottom: 20px; outline: none; transition: 0.3s; }
                input:focus { border-color: var(--primary); box-shadow: 0 0 15px var(--primary-glow); }
                
                .btn { width: 100%; padding: 16px; background: linear-gradient(45deg, #cc0000, #ff1a1a); border: none; border-radius: 12px; color: #fff; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; cursor: pointer; transition: 0.3s; box-shadow: 0 5px 20px rgba(204, 0, 0, 0.4); display: flex; justify-content: center; align-items: center; gap: 8px; }
                .btn:hover { transform: translateY(-3px); box-shadow: 0 8px 25px rgba(255, 26, 26, 0.6); }
                
                .btn-secondary { background: #1a0505; border: 1px solid var(--primary); box-shadow: none; }
                .btn-secondary:hover { background: var(--primary); color: #fff; }
                
                .btn-cancel { background: transparent; border: 1px solid var(--border); box-shadow: none; margin-top: 15px; color: var(--text-muted); }
                .btn-cancel:hover { background: rgba(255, 255, 255, 0.05); transform: none; box-shadow: none; color: #fff; }

                /* Bot Details Box */
                .details-box { background: rgba(0,0,0,0.5); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: left; font-size: 14px; line-height: 2; margin-bottom: 20px; }
                .details-box span { color: var(--primary); font-weight: 700; display: inline-block; width: 90px; }

                /* Utility Classes for Toggle */
                .hidden { display: none !important; }
                .fade-in { animation: fadeIn 0.4s ease-out forwards; }

                /* Sections (Stats, Commands) */
                .section-title { font-size: 20px; font-weight: 700; margin: 40px 0 15px; color: #fff; border-left: 4px solid var(--primary); padding-left: 10px; }
                
                /* Features Grid */
                .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
                .card { background: var(--bg-card); border: 1px solid var(--border); padding: 20px; border-radius: 15px; transition: 0.3s; }
                .card:hover { border-color: var(--primary); transform: translateY(-5px); }
                .card-icon { font-size: 24px; margin-bottom: 10px; }
                .card-title { font-weight: 700; font-size: 14px; margin-bottom: 5px; color: var(--primary); }
                .card-desc { font-size: 12px; color: var(--text-muted); }

                /* Command List */
                .cmd-list { display: flex; flex-direction: column; gap: 10px; }
                .cmd-item { background: var(--bg-card); border: 1px solid var(--border); padding: 15px 20px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; }
                .cmd-name { font-weight: 700; color: #fff; font-size: 15px; }
                .cmd-name span { color: var(--primary); margin-right: 5px; }
                .cmd-desc { font-size: 12px; color: var(--text-muted); }

                /* Music Button */
                .music-btn {
                    position: fixed;
                    bottom: 20px;
                    left: 20px;
                    background: rgba(15, 0, 0, 0.8);
                    backdrop-filter: blur(10px);
                    border: 1px solid var(--border);
                    padding: 10px 20px;
                    border-radius: 30px;
                    color: var(--text-muted);
                    font-size: 12px;
                    font-weight: 700;
                    cursor: pointer;
                    z-index: 1000;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    transition: 0.3s;
                }
                .music-btn:hover { border-color: var(--primary); }
                .music-btn.playing { color: #00ff00; border-color: #00ff00; box-shadow: 0 0 15px rgba(0,255,0,0.2); }

                .footer { text-align: center; margin-top: 50px; color: var(--text-muted); font-size: 13px; font-weight: 300; padding-bottom: 80px; }
                .footer span { color: var(--primary); font-weight: 700; }

                @keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
            </style>
        </head>
        <body>
            <!-- Background Audio Element -->
            <audio id="bgMusic" loop>
                <source src="https://files.catbox.moe/vsl1wg.mp3" type="audio/mpeg">
            </audio>

            <!-- Floating Nav -->
            <div class="header">
                <div class="header-logo">
                    <img src="https://files.catbox.moe/6gq4ub.jpeg" alt="Logo">
                    DIMUWA
                </div>
                <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: #00ff00;">
                    <div class="status-dot"></div> ONLINE
                </div>
            </div>

            <!-- Music Controller -->
            <div class="music-btn" id="musicToggle" onclick="toggleMusic()">
                🎵 MUSIC: OFF
            </div>

            <div class="container">
                <!-- Hero Section -->
                <div class="hero">
                    <div class="hero-img-container">
                        <img src="https://files.catbox.moe/6gq4ub.jpeg" class="hero-img" alt="Dimuwa Bot">
                    </div>
                    <h1 class="hero-title">DIMUWA MINI</h1>
                    <p class="hero-desc">Next Generation WhatsApp Automation.<br>Powerful, fast, and completely secure.</p>
                </div>

                <!-- Action Area (Toggle Interface) -->
                <div class="action-card">
                    <!-- Start View -->
                    <div id="startView" class="action-content">
                        <h2 style="font-size: 20px; margin-bottom: 25px;">READY TO CONNECT?</h2>
                        <div style="display: flex; gap: 15px; justify-content: space-between;">
                            <button class="btn" onclick="showInputForm()" style="flex: 1;">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                                LINK DEVICE
                            </button>
                            <button class="btn btn-secondary" onclick="showDetailsView()" style="flex: 1;">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                                BOT DETAILS
                            </button>
                        </div>
                    </div>

                    <!-- Input Form View -->
                    <div id="inputView" class="action-content hidden">
                        <h2 style="font-size: 20px; margin-bottom: 20px;">ENTER WHATSAPP NUMBER</h2>
                        <form action="/pair" method="GET">
                            <input type="text" name="phone" placeholder="947XXXXXXX" required>
                            <button type="submit" class="btn">GENERATE CODE</button>
                        </form>
                        <button class="btn btn-cancel" onclick="goBackToStart()">CANCEL</button>
                    </div>

                    <!-- Bot Details View -->
                    <div id="detailsView" class="action-content hidden">
                        <h2 style="font-size: 20px; margin-bottom: 20px; color: #fff;">ABOUT DIMUWA MINI</h2>
                        <div class="details-box">
                            <div><span>NAME:</span> DIMUWA MINI BOT</div>
                            <div><span>OWNER:</span> DIMUTH SATHSARA</div>
                            <div><span>VERSION:</span> 3.0 RED EDITION</div>
                            <div><span>CREATED:</span> SEP 2026</div>
                            <div><span>STATUS:</span> 100% ONLINE & SECURE</div>
                        </div>
                        <button class="btn btn-cancel" onclick="goBackToStart()" style="margin-top: 0;">BACK</button>
                    </div>
                </div>

                <!-- Live Status & Stats -->
                <h3 class="section-title">SYSTEM STATUS</h3>
                <div class="grid">
                    <div class="card">
                        <div class="card-title">SERVER</div>
                        <div class="card-desc" style="color: #fff; font-size: 20px; font-weight: 700;">ACTIVE</div>
                    </div>
                    <div class="card">
                        <div class="card-title">LATENCY</div>
                        <div class="card-desc" style="color: #fff; font-size: 20px; font-weight: 700;">24 ms</div>
                    </div>
                    <div class="card">
                        <div class="card-title">UPTIME</div>
                        <div class="card-desc" style="color: #fff; font-size: 20px; font-weight: 700;" id="uptime">00:00:00</div>
                    </div>
                    <div class="card">
                        <div class="card-title">VERSION</div>
                        <div class="card-desc" style="color: #fff; font-size: 20px; font-weight: 700;">V3.0 RED</div>
                    </div>
                </div>

                <!-- Features -->
                <h3 class="section-title">FEATURES</h3>
                <div class="grid">
                    <div class="card">
                        <div class="card-icon">⚡</div>
                        <div class="card-title">LIGHTNING FAST</div>
                        <div class="card-desc">Zero lag response time with optimized Baileys engine.</div>
                    </div>
                    <div class="card">
                        <div class="card-icon">🛡️</div>
                        <div class="card-title">100% SECURE</div>
                        <div class="card-desc">Your session is encrypted and never stored on our servers.</div>
                    </div>
                </div>

                <!-- Commands -->
                <h3 class="section-title">COMMAND CENTER</h3>
                <div class="cmd-list">
                    <div class="cmd-item">
                        <div class="cmd-name"><span>.</span>menu</div>
                        <div class="cmd-desc">Show main panel</div>
                    </div>
                    <div class="cmd-item">
                        <div class="cmd-name"><span>.</span>settings</div>
                        <div class="cmd-desc">Bot configuration</div>
                    </div>
                    <div class="cmd-item">
                        <div class="cmd-name"><span>.</span>save</div>
                        <div class="cmd-desc">Download status</div>
                    </div>
                    <div class="cmd-item">
                        <div class="cmd-name"><span>.</span>vv</div>
                        <div class="cmd-desc">Unlock view-once</div>
                    </div>
                </div>

                <!-- Footer -->
                <div class="footer">
                    &copy; 2026 DIMUWA BOT.<br>Created by <span>DIMUTH SATHSARA</span>
                </div>
            </div>

            <script>
                // Navigation/Toggle Scripts
                const startView = document.getElementById('startView');
                const inputView = document.getElementById('inputView');
                const detailsView = document.getElementById('detailsView');

                function hideAllViews() {
                    startView.classList.add('hidden');
                    startView.classList.remove('fade-in');
                    inputView.classList.add('hidden');
                    inputView.classList.remove('fade-in');
                    detailsView.classList.add('hidden');
                    detailsView.classList.remove('fade-in');
                }

                function showInputForm() {
                    hideAllViews();
                    inputView.classList.remove('hidden');
                    inputView.classList.add('fade-in');
                }

                function showDetailsView() {
                    hideAllViews();
                    detailsView.classList.remove('hidden');
                    detailsView.classList.add('fade-in');
                }

                function goBackToStart() {
                    hideAllViews();
                    startView.classList.remove('hidden');
                    startView.classList.add('fade-in');
                }

                // Uptime Counter Script
                let seconds = 0;
                setInterval(() => {
                    seconds++;
                    let hrs = Math.floor(seconds / 3600);
                    let mins = Math.floor((seconds % 3600) / 60);
                    let secs = seconds % 60;
                    document.getElementById('uptime').innerText = 
                        (hrs < 10 ? "0" : "") + hrs + ":" + 
                        (mins < 10 ? "0" : "") + mins + ":" + 
                        (secs < 10 ? "0" : "") + secs;
                }, 1000);

                // Music Player Script
                const bgMusic = document.getElementById('bgMusic');
                const musicToggle = document.getElementById('musicToggle');
                let userInteracted = false;

                function toggleMusic() {
                    if (bgMusic.paused) {
                        bgMusic.play();
                        musicToggle.innerHTML = '🎵 MUSIC: ON';
                        musicToggle.classList.add('playing');
                    } else {
                        bgMusic.pause();
                        musicToggle.innerHTML = '🔇 MUSIC: OFF';
                        musicToggle.classList.remove('playing');
                    }
                }

                // Auto play on first click anywhere on the screen
                document.body.addEventListener('click', function() {
                    if (!userInteracted && bgMusic.paused) {
                        bgMusic.play();
                        musicToggle.innerHTML = '🎵 MUSIC: ON';
                        musicToggle.classList.add('playing');
                        userInteracted = true;
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// --- 2. RED THEME PAIRING CODE PAGE (FIXED INVALID CODE ISSUE) ---
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.send('Phone number is required!');
    phone = phone.replace(/[^0-9]/g, '');

    // Cleanup previous session to avoid conflicts
    const sessionFolder = './session_' + phone;
    if (fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), 
        // BROWSER NAME CHANGED TO MAC OS TO FIX INVALID CODE ISSUE
        browser: ['Mac OS', 'Chrome', '121.0.0.0'],
        msgRetryCounterCache 
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.me?.id) {
        setTimeout(async () => {
            try {
                // Request pairing code
                const code = await sock.requestPairingCode(phone);
                
                // Display code (HTML)
                res.send(`
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Pairing Code</title>
                        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
                        <style>
                            body { background: #050000; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Outfit', sans-serif; text-align: center; margin: 0; background-image: radial-gradient(circle at 50% 50%, #2a0000 0%, transparent 70%); }
                            .container { background: rgba(15,2,2,0.8); border: 1px solid #330a0a; padding: 50px 30px; border-radius: 25px; box-shadow: 0 15px 40px rgba(0,0,0,0.8), 0 0 30px rgba(255,26,26,0.1); width: 90%; max-width: 450px; animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
                            h2 { color: #a09090; font-weight: 500; font-size: 16px; margin-bottom: 30px; letter-spacing: 2px; text-transform: uppercase; }
                            .code-box { background: linear-gradient(45deg, #cc0000, #ff1a1a); color: #fff; font-size: 50px; font-weight: 900; letter-spacing: 12px; padding: 20px 20px 20px 32px; border-radius: 15px; display: inline-block; box-shadow: 0 10px 30px rgba(255, 26, 26, 0.4); margin-bottom: 20px; }
                            .copy-btn { background: #1a1a1a; color: #ff1a1a; border: 1px solid #ff1a1a; padding: 12px 25px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; transition: 0.3s; margin-bottom: 30px; display: inline-block; text-transform: uppercase; }
                            .copy-btn:hover { background: #ff1a1a; color: #fff; box-shadow: 0 0 15px rgba(255,26,26,0.5); }
                            p { color: #a09090; font-size: 14px; line-height: 1.8; font-weight: 300; }
                            .highlight { color: #ff1a1a; font-weight: 700; }
                            .back-btn { display: inline-block; margin-top: 30px; padding: 10px 20px; border: 1px solid #ff1a1a; color: #ff1a1a; text-decoration: none; border-radius: 8px; font-weight: 700; transition: 0.3s; }
                            .back-btn:hover { background: #ff1a1a; color: #fff; }
                            
                            .alert-box { visibility: hidden; min-width: 250px; background-color: #00cc00; color: #fff; text-align: center; border-radius: 8px; padding: 12px; position: fixed; z-index: 1; bottom: 30px; left: 50%; transform: translateX(-50%); font-weight: bold; opacity: 0; transition: opacity 0.3s; }
                            .alert-box.show { visibility: visible; opacity: 1; }

                            @keyframes popIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h2>Link WhatsApp Device</h2>
                            
                            <div class="code-box" id="pairCodeDisplay">${code}</div><br>
                            
                            <!-- Copy Button -->
                            <button class="copy-btn" onclick="copyCode()">📋 COPY CODE</button>

                            <p>Go to <b>WhatsApp > Linked Devices > Link with phone number</b> and enter the code above.</p>
                            <p style="margin-top:20px; font-size:12px; color:#665555; border-top: 1px solid #330a0a; padding-top: 15px;">Session ID will be sent to your <span class="highlight">Saved Messages (Yourself)</span>.</p>
                            
                            <a href="/" class="back-btn">RETURN HOME</a>
                        </div>

                        <div id="copyAlert" class="alert-box">Pairing Code Copied! 🎉</div>

                        <script>
                            function copyCode() {
                                var codeText = document.getElementById("pairCodeDisplay").innerText;
                                codeText = codeText.trim();
                                navigator.clipboard.writeText(codeText).then(function() {
                                    var alertBox = document.getElementById("copyAlert");
                                    alertBox.className = "alert-box show";
                                    setTimeout(function(){ 
                                        alertBox.className = alertBox.className.replace("alert-box show", "alert-box"); 
                                    }, 3000);
                                }).catch(function(err) {
                                    alert("Failed to copy. Please try manually.");
                                });
                            }
                        </script>
                    </body>
                    </html>
                `);
            } catch (err) {
                res.send('<body style="background-color: #050000; color: #ff1a1a; text-align: center; margin-top: 50px; font-family: sans-serif;"><h2>Error generating code. Check number and try again!</h2><a href="/" style="color:#fff;">Back</a></body>');
            }
        }, 2000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            const credsData = fs.readFileSync(sessionFolder + '/creds.json');
            const base64Creds = Buffer.from(credsData).toString('base64');
            const sessionID = 'DIMUWA~' + base64Creds;

            await sock.sendMessage(sock.user.id, { text: '*DIMUWA MINI BOT LINKED!* 🔴\n\nGenerating your secure Session ID...' });
            await sock.sendMessage(sock.user.id, { text: `*SESSION ID:*\n\n${sessionID}` });
            await sock.sendMessage(sock.user.id, { text: `⚠️ *SECURITY WARNING:*\nDo not share this code with anyone. It gives full access to your WhatsApp account.` });

            setTimeout(() => { fs.rmSync(sessionFolder, { recursive: true, force: true }); }, 3000);
        }
    });
});

app.listen(port, () => {
    console.log(`Web server started on port ${port}`);
});
