/**
 * Express backend for Radio TX Studio
 * Streams uploaded WAV files over ZMQ PUB socket (no TCP stream)
 *
 * Endpoints:
 *  POST /api/upload-audio  – upload WAV (multipart key 'file')
 *  GET  /api/files         – list uploaded WAVs
 *  POST /api/play          – start publishing selected WAV over ZMQ
 *  POST /api/pause         – stop publishing
 *  GET  /api/stream-status – current status
 *
 * WebSocket (same HTTP port) sends live status updates.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const zmq = require('zeromq');
const wavDecoder = require('wav-decoder');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// Serve uploaded files if needed
app.use('/uploads', express.static(UPLOAD_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// File uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

// Runtime state
const STATE = {
  playing: false,
  currentFile: null,
  bytesSent: 0
};

let zmqSock = null;
let playTimer = null;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(data);
  });
}

// List all WAV files
app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => /\.wav$/i.test(f))
    .map(f => ({ id: f, name: f }));
  files.sort((a, b) => b.id.localeCompare(a.id));
  res.json({ files });
});

// Upload WAV
app.post('/api/upload-audio', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  broadcast({ type: 'files-updated' });
  res.json({ id: req.file.filename, name: req.file.originalname });
});

// Play selected WAV via ZMQ
app.post('/api/play', async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });
    const filePath = path.join(UPLOAD_DIR, fileId);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });

    // Stop any current stream
    cleanupStream(true);

    // Decode wav to Float32
    const buffer = fs.readFileSync(filePath);
    const wavData = await wavDecoder.decode(buffer);
    const samples = wavData.channelData[0]; // first channel

    const ZMQ_HOST = process.env.ZMQ_HOST || '127.0.0.1';
    const ZMQ_PORT = process.env.ZMQ_PORT || 5555;
    zmqSock = new zmq.Publisher();
    await zmqSock.connect(`tcp://${ZMQ_HOST}:${ZMQ_PORT}`);
    console.log(`Publishing on tcp://${ZMQ_HOST}:${ZMQ_PORT}`);

    STATE.playing = true;
    STATE.currentFile = fileId;
    STATE.bytesSent = 0;
    broadcast({ type: 'status', playing: true, currentFile: STATE.currentFile });

    // Send chunks of 1024 samples ~100 times/sec
    let index = 0;
    const chunkSize = 1024;
    playTimer = setInterval(async () => {
      if (!STATE.playing || index >= samples.length) {
        console.log('Finished sending samples');
        cleanupStream();
        broadcast({ type: 'status', playing: false });
        return;
      }
      const slice = samples.subarray(index, index + chunkSize);
      const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
      await zmqSock.send(buf);
      STATE.bytesSent += buf.length;
      index += chunkSize;
    }, 10);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to play' });
  }
});

// Pause/stop
app.post('/api/pause', (req, res) => {
  cleanupStream(false);
  STATE.playing = false;
  broadcast({ type: 'status', playing: false });
  res.json({ ok: true });
});

// Status
app.get('/api/stream-status', (req, res) => {
  res.json({
    playing: STATE.playing,
    currentFileId: STATE.currentFile,
    bytesSent: STATE.bytesSent
  });
});

// WebSocket welcome
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'welcome', version: 'zmq-integration' }));
  ws.send(JSON.stringify({ type: 'status', playing: STATE.playing, currentFile: STATE.currentFile }));
});

function cleanupStream(resetBytes = false) {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  if (zmqSock) { try { zmqSock.close(); } catch {} zmqSock = null; }
  if (resetBytes) STATE.bytesSent = 0;
}

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`HTTP API running on http://localhost:${PORT}`);
  console.log(`ZMQ publisher default: tcp://127.0.0.1:5555`);
});
