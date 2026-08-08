const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// ==================================================
// CONFIG
// ==================================================

const PORT = 3000;

// CURRENT CLOUDFLARE URL FOR EXOTEL WEBSOCKET
const PUBLIC_URL =
  "https://ai-voice-bridge-q8qv.onrender.com";

const WS_URL =
  PUBLIC_URL.replace("https://", "wss://");

// ==================================================
// GROQ
// ==================================================

// PASTE YOUR NEW GROQ API KEY BETWEEN THE QUOTES
const GROQ_API_KEY =
  "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";

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ==================================================
// N8N
// ==================================================

const N8N_WEBHOOK_URL =
  "https://voltage-immediate-activated-jesse.trycloudflare.com/webhook/ai-phone";

// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer((req, res) => {

  console.log(
    "HTTP request:",
    req.method,
    req.url
  );

  // Health check
  if (req.url === "/health") {

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        status: "ok"
      })
    );

    return;
  }

  // Exotel asks for WebSocket URL
  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  res.end(
    JSON.stringify({
      url: WS_URL
    })
  );
});

// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss = new WebSocket.Server({
  server: server
});

// ==================================================
// CREATE WAV FROM RAW PCM
// ==================================================

function createWav(pcmBuffer) {

  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;

  const byteRate =
    sampleRate *
    channels *
    bitsPerSample / 8;

  const blockAlign =
    channels *
    bitsPerSample / 8;

  const wav =
    Buffer.alloc(
      44 + pcmBuffer.length
    );

  wav.write("RIFF", 0);

  wav.writeUInt32LE(
    36 + pcmBuffer.length,
    4
  );

  wav.write("WAVE", 8);

  wav.write("fmt ", 12);

  wav.writeUInt32LE(
    16,
    16
  );

  wav.writeUInt16LE(
    1,
    20
  );

  wav.writeUInt16LE(
    channels,
    22
  );

  wav.writeUInt32LE(
    sampleRate,
    24
  );

  wav.writeUInt32LE(
    byteRate,
    28
  );

  wav.writeUInt16LE(
    blockAlign,
    32
  );

  wav.writeUInt16LE(
    bitsPerSample,
    34
  );

  wav.write("data", 36);

  wav.writeUInt32LE(
    pcmBuffer.length,
    40
  );

  pcmBuffer.copy(
    wav,
    44
  );

  return wav;
}

// ==================================================
// AUDIO LEVEL / RMS
// ==================================================

function getRMS(buffer) {

  if (
    !buffer ||
    buffer.length < 2
  ) {
    return 0;
  }

  let sum = 0;
  let count = 0;

  for (
    let i = 0;
    i + 1 < buffer.length;
    i += 2
  ) {

    const sample =
      buffer.readInt16LE(i);

    sum +=
      sample * sample;

    count++;
  }

  if (count === 0) {
    return 0;
  }

  return Math.sqrt(
    sum / count
  );
}

// ==================================================
// GROQ SPEECH TO TEXT
// ==================================================

async function transcribeAudio(
  pcmBuffer
) {

  console.log("");
  console.log(
    "Sending caller audio to Groq Whisper..."
  );

  const wav =
    createWav(
      pcmBuffer
    );

  const file =
    new File(
      [wav],
      "caller.wav",
      {
        type: "audio/wav"
      }
    );

  const transcription =
    await groq.audio.transcriptions.create({

      file: file,

      model:
        "whisper-large-v3-turbo",

      language:
        "en",

      response_format:
        "json"
    });

  const text =
    (transcription.text || "")
      .trim();

  console.log(
    "CALLER SAID:",
    text
  );

  return text;
}

// ==================================================
// N8N
// ==================================================

async function askN8N(
  question,
  callSid
) {

  console.log("");
  console.log(
    "Sending question to n8n..."
  );

  const response =
    await fetch(
      N8N_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({

          text:
            question,

          chatInput:
            question,

          sessionId:
            callSid
        })
      }
    );

  if (!response.ok) {

    const error =
      await response.text();

    throw new Error(
      `n8n HTTP ${response.status}: ${error}`
    );
  }

  const raw =
    await response.text();

  console.log(
    "n8n raw response:",
    raw
  );

  let data;

  try {

    data =
      JSON.parse(raw);

  } catch {

    throw new Error(
      "n8n returned invalid JSON"
    );
  }

  const answer =
    data.output ||
    data.text ||
    data["name: text"] ||
    data.answer ||
    data.response;

  if (!answer) {

    throw new Error(
      "No AI answer found in n8n response"
    );
  }

  console.log(
    "AI ANSWER:",
    answer
  );

  return String(answer);
}

// ==================================================
// GROQ TTS
// ==================================================

async function generateSpeech(
  text
) {

  console.log("");
  console.log(
    "Sending AI answer to Groq TTS..."
  );

  const cleanText =
    text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

  const response =
    await groq.audio.speech.create({

      model:
        "canopylabs/orpheus-v1-english",

      voice:
        "hannah",

      input:
        cleanText,

      response_format:
        "wav"
    });

  const wavBuffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  console.log(
    "Groq TTS WAV received:",
    wavBuffer.length,
    "bytes"
  );

  return wavBuffer;
}

// ==================================================
// CONVERT WAV -> EXOTEL PCM
// ==================================================

function convertWavToExotelPCM(
  wavBuffer
) {

  return new Promise(
    (resolve, reject) => {

      console.log(
        "Converting TTS WAV to Exotel PCM..."
      );

      const ffmpeg =
        spawn(
          ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",

            "-i",
            "pipe:0",

            "-f",
            "s16le",

            "-ar",
            "8000",

            "-ac",
            "1",

            "pipe:1"
          ]
        );

      const output = [];
      const errors = [];

      ffmpeg.stdout.on(
        "data",
        (chunk) => {
          output.push(chunk);
        }
      );

      ffmpeg.stderr.on(
        "data",
        (chunk) => {
          errors.push(chunk);
        }
      );

      ffmpeg.on(
        "error",
        (error) => {
          reject(error);
        }
      );

      ffmpeg.on(
        "close",
        (code) => {

          if (code !== 0) {

            reject(
              new Error(
                "FFmpeg failed: " +
                Buffer
                  .concat(errors)
                  .toString()
              )
            );

            return;
          }

          resolve(
            Buffer.concat(output)
          );
        }
      );

      ffmpeg.stdin.write(
        wavBuffer
      );

      ffmpeg.stdin.end();
    }
  );
}

// ==================================================
// SEND AUDIO TO EXOTEL
// ==================================================

function sendAudioToExotel(
  ws,
  streamSid,
  pcmBuffer
) {

  if (
    ws.readyState !==
    WebSocket.OPEN
  ) {

    console.log(
      "WebSocket is not open."
    );

    return;
  }

  // 20 ms of:
  // 8000 Hz
  // 16-bit
  // mono
  //
  // 8000 x 0.02 x 2 = 320 bytes

  const CHUNK_SIZE = 320;

  let chunkNumber = 0;

  for (
    let offset = 0;
    offset < pcmBuffer.length;
    offset += CHUNK_SIZE
  ) {

    const chunk =
      pcmBuffer.subarray(
        offset,
        Math.min(
          offset + CHUNK_SIZE,
          pcmBuffer.length
        )
      );

    const message = {

      event:
        "media",

      stream_sid:
        streamSid,

      media: {

        payload:
          chunk.toString(
            "base64"
          )
      }
    };

    ws.send(
      JSON.stringify(
        message
      )
    );

    chunkNumber++;
  }

  console.log(
    "Sent",
    chunkNumber,
    "audio chunks to Exotel."
  );

  console.log(
    "Audio sent to caller."
  );
}

// ==================================================
// PROCESS SPEECH
// ==================================================

async function processSpeech(
  ws,
  streamSid,
  callSid,
  pcmBuffer
) {

  try {

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      "PROCESSING CALLER SPEECH"
    );

    console.log(
      "========================================"
    );

    // 1. SPEECH TO TEXT

    const question =
      await transcribeAudio(
        pcmBuffer
      );

    if (!question) {

      console.log(
        "No speech detected."
      );

      return;
    }

    // 2. N8N

    const answer =
      await askN8N(
        question,
        callSid
      );

    // 3. TTS

    const wav =
      await generateSpeech(
        answer
      );

    // 4. CONVERT

    const pcm =
      await convertWavToExotelPCM(
        wav
      );

    console.log(
      "Converted PCM:",
      pcm.length,
      "bytes"
    );

    // 5. SEND TO CALLER

    sendAudioToExotel(
      ws,
      streamSid,
      pcm
    );

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      "ANSWER SENT TO CALLER"
    );

    console.log(
      "========================================"
    );

  } catch (error) {

    console.error("");
    console.error(
      "VOICE PROCESSING ERROR:"
    );

    console.error(
      error.message
    );

    console.error("");
  }
}

// ==================================================
// EXOTEL WEBSOCKET
// ==================================================

wss.on(
  "connection",
  (ws) => {

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "EXOTEL WEBSOCKET CONNECTED"
    );

    console.log(
      "================================"
    );

    let streamSid =
      null;

    let callSid =
      null;

    let audioChunks =
      [];

    let speechActive =
      false;

    let silenceMs =
      0;

    let processing =
      false;

    let totalAudioBytes =
      0;

    ws.on(
      "message",
      async (data) => {

        try {

          const message =
            JSON.parse(
              data.toString()
            );

          // ========================================
          // CONNECTED
          // ========================================

          if (
            message.event ===
            "connected"
          ) {

            console.log(
              "Event: connected"
            );

            console.log(
              "Exotel WebSocket connected."
            );

            return;
          }

          // ========================================
          // START
          // ========================================

          if (
            message.event ===
            "start"
          ) {

            streamSid =
              message.stream_sid ||
              message.start?.stream_sid;

            callSid =
              message.start?.call_sid;

            console.log(
              "Event: start"
            );

            console.log(
              "Stream SID:",
              streamSid
            );

            console.log(
              "Call SID:",
              callSid
            );

            console.log(
              "Audio format:",
              message.start?.media_format
            );

            return;
          }

          // ========================================
          // MEDIA
          // ========================================

          if (
            message.event ===
            "media"
          ) {

            if (
              !message.media?.payload
            ) {
              return;
            }

            const audio =
              Buffer.from(
                message.media.payload,
                "base64"
              );

            console.log(
              "Audio received:",
              audio.length,
              "bytes"
            );

            if (processing) {
              return;
            }

            const rms =
              getRMS(audio);

            console.log(
              "Audio level:",
              Math.round(rms)
            );

            const SPEECH_THRESHOLD =
              500;

            const isSpeaking =
              rms >
              SPEECH_THRESHOLD;

            // ======================================
            // SPEECH
            // ======================================

            if (isSpeaking) {

              speechActive =
                true;

              silenceMs =
                0;

              audioChunks.push(
                audio
              );

              totalAudioBytes +=
                audio.length;

              return;
            }

            // ======================================
            // SILENCE
            // ======================================

            if (
              speechActive
            ) {

              audioChunks.push(
                audio
              );

              totalAudioBytes +=
                audio.length;

              silenceMs += 20;
            }

            // ======================================
            // END OF SPEECH
            // ======================================

            if (
              speechActive &&
              silenceMs >= 700
            ) {

              console.log(
                "End of speech detected."
              );

              speechActive =
                false;

              silenceMs =
                0;

              const completeAudio =
                Buffer.concat(
                  audioChunks
                );

              audioChunks =
                [];

              totalAudioBytes =
                0;

              if (
                completeAudio.length <
                4000
              ) {

                console.log(
                  "Audio too short, ignoring."
                );

                return;
              }

              processing =
                true;

              await processSpeech(
                ws,
                streamSid,
                callSid,
                completeAudio
              );

              processing =
                false;

              return;
            }

            // ======================================
            // MAXIMUM AUDIO LENGTH
            // ======================================

            const MAX_AUDIO_BYTES =
              8 *
              8000 *
              2;

            if (
              totalAudioBytes >
              MAX_AUDIO_BYTES
            ) {

              console.log(
                "Maximum speech length reached."
              );

              speechActive =
                false;

              silenceMs =
                0;

              const completeAudio =
                Buffer.concat(
                  audioChunks
                );

              audioChunks =
                [];

              totalAudioBytes =
                0;

              processing =
                true;

              await processSpeech(
                ws,
                streamSid,
                callSid,
                completeAudio
              );

              processing =
                false;
            }

            return;
          }

          // ========================================
          // DTMF
          // ========================================

          if (
            message.event ===
            "dtmf"
          ) {

            console.log(
              "DTMF:",
              message.dtmf?.digit
            );

            return;
          }

          // ========================================
          // STOP
          // ========================================

          if (
            message.event ===
            "stop"
          ) {

            console.log(
              "Event: stop"
            );

            audioChunks =
              [];

            totalAudioBytes =
              0;

            return;
          }

        } catch (error) {

          console.error(
            "WebSocket message error:",
            error.message
          );
        }
      }
    );

    ws.on(
      "close",
      () => {

        console.log(
          "Exotel WebSocket disconnected."
        );
      }
    );

    ws.on(
      "error",
      (error) => {

        console.error(
          "WebSocket error:",
          error.message
        );
      }
    );
  }
);

// ==================================================
// START SERVER
// ==================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "--------------------------------"
    );

    console.log(
      "AI VOICE BRIDGE"
    );

    console.log(
      "--------------------------------"
    );

    console.log(
      "HTTP: http://localhost:" +
      PORT
    );

    console.log(
      "WebSocket: ws://localhost:" +
      PORT
    );

    console.log(
      "Public WebSocket:",
      WS_URL
    );

    console.log("");

    console.log(
      "Groq API key:",
      GROQ_API_KEY !==
      "PASTE_YOUR_NEW_GROQ_KEY_HERE"
        ? "FOUND"
        : "MISSING"
    );

    console.log(
      "n8n webhook:",
      N8N_WEBHOOK_URL !==
      "YOUR_N8N_WEBHOOK_URL_HERE"
        ? "FOUND"
        : "MISSING"
    );

    console.log("");

    console.log(
      "Waiting for Exotel..."
    );
  }
);