// index.js
const { app, desktopCapturer, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('enable-features', 'VizDisplayCompositor');

let localStream = null;

async function init() {
    await app.whenReady();
    
    // Create a hidden window to act as the render context for capture
    const win = new BrowserWindow({ 
        show: false,
        width: 1920,
        height: 1080
    });
    
    await win.loadURL('about:blank');

    try {
        const sources = await desktopCapturer.getSources({ 
            types: ['screen', 'window'],
            thumbnailSize: { width: 1920, height: 1080 }
        });
        
        if (sources.length === 0) throw new Error("No display found");
        
        const source = sources.find(s => s.name.includes('Screen')) || sources[0];
        
        // Use the window's webContents to get the media stream
        localStream = await win.webContents.getMediaStreamSource({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    minWidth: 1280,
                    maxWidth: 1920,
                    minHeight: 720,
                    maxHeight: 1080
                }
            }
        });
        
        console.log("[ELECTRON] Screen capture active");
    } catch (err) {
        console.error("[ELECTRON] Capture failed:", err.message);
    }

    global.electronLocalStream = localStream;
    global.desktopCapturer = desktopCapturer;
    
    require('./payload.js');
}

init().catch(console.error);
