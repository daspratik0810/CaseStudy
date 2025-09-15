import zmq from "zeromq";

// Helper: generate a sine wave buffer
function generateSine(freq, sampleRate, numSamples) {
  const buffer = new ArrayBuffer(numSamples * 4); // float32 = 4 bytes
  const view = new Float32Array(buffer);
  for (let i = 0; i < numSamples; i++) {
    view[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return Buffer.from(buffer);
}

async function run() {
  const sock = new zmq.Publisher();
  await sock.connect("tcp://127.0.0.1:5555");
  console.log("Publisher bound to tcp://127.0.0.1:5555");

  const sampleRate = 48000;
  const freq = 1000;

  while (true) {
    const chunk = generateSine(freq, sampleRate, 1024);
    await sock.send(chunk);
    await new Promise(r => setTimeout(r, 10)); // pacing
  }
}

run();
