import fs from "fs";
import zmq from "zeromq";
import wav from "wav-decoder";

async function run() {
  // Read WAV file
  const buffer = fs.readFileSync("sample-15s.wav");
  const wavData = await wav.decode(buffer);

  console.log("Sample rate:", wavData.sampleRate);
  console.log("Channels:", wavData.channelData.length);

  // Just use the first channel for now
  const samples = wavData.channelData[0]; // Float32Array normalized [-1,1]

  // Setup PUB socket
  const sock = new zmq.Publisher();
  await sock.connect("tcp://127.0.0.1:5555");
  console.log("Publisher bound to tcp://127.0.0.1:5555");

  // Send in chunks
  const chunkSize = 1024;
  for (let i = 0; i < samples.length; i += chunkSize) {
    const slice = samples.subarray(i, i + chunkSize);
    // Convert Float32Array to Buffer
    const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
    await sock.send(buf);
    await new Promise(r => setTimeout(r, 10));
  }

  console.log("Finished sending WAV samples");
}

run();
