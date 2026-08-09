const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// ==================================================
// CONFIG
// ==================================================

const PORT = process.env.PORT || 10000;

const PUBLIC_URL =
  "https://ai-voice-bridge-q8qv.onrender.com";

const WS_URL =
  PUBLIC_URL.replace("https://", "wss://");

// ==================================================
// ENVIRONMENT VARIABLES
// ==================================================

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ||
  "JBFqnCBsd6RMkjVDRZzb";

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL;

// ==================================================
// STARTUP CHECK
// ==================================================

console.log("");
console.log("================================");
console.log("AI VOICE BRIDGE");
console.log("================================");

console.log(
  "ElevenLabs API:",
  ELEVENLABS_API_KEY ? "CONFIGURED" : "MISSING"
);

console.log(
  "ElevenLabs Voice:",
  ELEVENLABS_VOICE_ID
);

console.log(
  "n8n Webhook:",
  N8N_WEBHOOK_URL ? "CONFIGURED" : "MISSING"
);

console.log("");

// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer(async (req, res) => {

  console.log(
    "# HTTP request:",
    req.method,
    req.url
  );

  // ----------------------------------------------
  // HEALTH
  // ----------------------------------------------

  if (req.url === "/health") {

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "ai-voice-bridge"
      })
    );

    return;
  }

  // ----------------------------------------------
  // DEFAULT
  // ----------------------------------------------

  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  res.end(
    JSON.stringify({
      status: "ok",
      websocket: WS_URL
    })
  );
});

// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss = new WebSocket.Server({
  server
});

// ==================================================
// PCM -> WAV
// ==================================================

function pcmToWav(
  pcmBuffer,
  sampleRate = 8000
) {

  const channels = 1;
  const bitsPerSample = 16;

  const byteRate =
    sampleRate *
    channels *
    bitsPerSample /
    8;

  const blockAlign =
    channels *
    bitsPerSample /
    8;

  const wav = Buffer.alloc(
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
// CONVERT 8KHZ PCM -> 16KHZ WAV
// ==================================================

function convertCallerAudioForSTT(
  pcmBuffer
) {

  return new Promise((resolve, reject) => {

    console.log(
      "Converting caller audio 8kHz -> 16kHz..."
    );

    const inputWav =
      pcmToWav(
        pcmBuffer,
        8000
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

          "-ar",
          "16000",

          "-ac",
          "1",

          "-f",
          "wav",

          "pipe:1"
        ]
      );

    const output = [];
    const errors = [];

    ffmpeg.stdout.on(
      "data",
      chunk => {
        output.push(chunk);
      }
    );

    ffmpeg.stderr.on(
      "data",
      chunk => {
        errors.push(chunk);
      }
    );

    ffmpeg.on(
      "error",
      reject
    );

    ffmpeg.on(
      "close",
      code => {

        if (code !== 0) {

          reject(
            new Error(
              "FFmpeg STT conversion failed: " +
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
      inputWav
    );

    ffmpeg.stdin.end();
  });
}

// ==================================================
// ELEVENLABS SPEECH TO TEXT
// ==================================================

async function transcribeCallerAudio(
  pcmBuffer
) {

  console.log("");
  console.log("================================");
  console.log("ELEVENLABS SPEECH TO TEXT");
  console.log("================================");

  if (!ELEVENLABS_API_KEY) {

    throw new Error(
      "ELEVENLABS_API_KEY is missing"
    );
  }

  if (
    !pcmBuffer ||
    pcmBuffer.length < 1600
  ) {

    console.log(
      "Audio too short."
    );

    return "";
  }

  console.log(
    "Caller PCM:",
    pcmBuffer.length,
    "bytes"
  );

  // Convert 8kHz caller audio
  // into 16kHz WAV.

  const wavBuffer =
    await convertCallerAudioForSTT(
      pcmBuffer
    );

  console.log(
    "STT WAV:",
    wavBuffer.length,
    "bytes"
  );

  // Node 24 supports Blob and FormData.

  const form =
    new FormData();

  const audioBlob =
    new Blob(
      [wavBuffer],
      {
        type: "audio/wav"
      }
    );

  form.append(
    "file",
    audioBlob,
    "caller.wav"
  );

  form.append(
    "model_id",
    "scribe_v2"
  );

  form.append(
    "language_code",
    "en"
  );

  form.append(
    "tag_audio_events",
    "false"
  );

  form.append(
    "diarize",
    "false"
  );

  form.append(
    "no_verbatim",
    "true"
  );

  console.log(
    "Sending audio to ElevenLabs Scribe..."
  );

  const response =
    await fetch(
      "https://api.elevenlabs.io/v1/speech-to-text",
      {
        method: "POST",

        headers: {
          "xi-api-key":
            ELEVENLABS_API_KEY
        },

        body: form
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      "ElevenLabs STT HTTP " +
      response.status +
      ": " +
      errorText
    );
  }

  const result =
    await response.json();

  const text =
    String(
      result.text || ""
    )
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "CALLER SAID:",
    text
  );

  return text;
}

// ==================================================
// SEND QUESTION TO N8N
// ==================================================

async function askN8N(
  question
) {

  console.log("");
  console.log(
    "Sending question to n8n..."
  );

  if (!N8N_WEBHOOK_URL) {

    throw new Error(
      "N8N_WEBHOOK_URL is missing"
    );
  }

  const response =
    await fetch(
      N8N_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            text: question,
            chatInput: question
          })
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      "n8n HTTP " +
      response.status +
      ": " +
      errorText
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
    data.response ||
    data.answer ||
    data.message;

  if (!answer) {

    throw new Error(
      "No AI answer found in n8n response"
    );
  }

  const finalAnswer =
    String(answer)
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "AI ANSWER:",
    finalAnswer
  );

  return finalAnswer;
}

// ==================================================
// MU-LAW -> PCM16
// ==================================================

function muLawToPCM16(
  muLawBuffer
) {

  const pcm =
    Buffer.alloc(
      muLawBuffer.length * 2
    );

  for (
    let i = 0;
    i < muLawBuffer.length;
    i++
  ) {

    let u =
      (~muLawBuffer[i]) &
      0xff;

    const sign =
      u & 0x80;

    const exponent =
      (u >> 4) & 0x07;

    const mantissa =
      u & 0x0f;

    let sample =
      ((mantissa << 3) + 132)
      << exponent;

    sample -= 132;

    if (sign) {
      sample = -sample;
    }

    if (sample > 32767) {
      sample = 32767;
    }

    if (sample < -32768) {
      sample = -32768;
    }

    pcm.writeInt16LE(
      sample,
      i * 2
    );
  }

  return pcm;
}

// ==================================================
// SEND PCM AUDIO TO EXOTEL
// ==================================================

function sendAudioToExotel(
  ws,
  streamSid,
  pcmBuffer
) {

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {

    console.log(
      "Cannot send audio: WebSocket is not open."
    );

    return;
  }

  // 100ms of 8kHz mono PCM16
  // = 800 samples
  // = 1600 bytes

  const CHUNK_SIZE = 1600;

  let chunkNumber = 0;
  let timestamp = 0;

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

    ws.send(
      JSON.stringify({

        event: "media",

        sequence_number:
          String(
            chunkNumber + 1
          ),

        stream_sid:
          streamSid,

        media: {

          chunk:
            String(
              chunkNumber
            ),

          timestamp:
            String(
              timestamp
            ),

          payload:
            chunk.toString(
              "base64"
            )
        }
      })
    );

    chunkNumber++;

    timestamp += 100;
  }

  console.log(
    "Sent",
    chunkNumber,
    "audio chunks to Exotel."
  );

  ws.send(
    JSON.stringify({

      event: "mark",

      stream_sid:
        streamSid,

      mark: {
        name:
          "ai_response_complete"
      }
    })
  );
}

// ==================================================
// ELEVENLABS TEXT TO SPEECH
// ==================================================

async function speakAnswer(
  ws,
  streamSid,
  answer
) {

  console.log("");
  console.log("================================");
  console.log("ELEVENLABS TEXT TO SPEECH");
  console.log("================================");

  if (!ELEVENLABS_API_KEY) {

    throw new Error(
      "ELEVENLABS_API_KEY is missing"
    );
  }

  let text =
    String(answer)
      .replace(/\s+/g, " ")
      .trim();

  // Keep phone responses reasonably short.

  text =
    text.slice(0, 1000);

  console.log(
    "TTS text:",
    text
  );

  console.log(
    "Generating ElevenLabs speech..."
  );

  // ElevenLabs supports μ-law output,
  // which is commonly used for telephony.
  //
  // We request 8kHz μ-law and then convert
  // it to PCM16 for the Exotel media stream.

  const ttsUrl =
    "https://api.elevenlabs.io/v1/text-to-speech/" +
    encodeURIComponent(ELEVENLABS_VOICE_ID) +
    "?output_format=ulaw_8000";

  const response =
    await fetch(
      ttsUrl,
      {
        method: "POST",

        headers: {
          "xi-api-key":
            ELEVENLABS_API_KEY,

          "Content-Type":
            "application/json",

          "Accept":
            "audio/basic"
        },

        body:
          JSON.stringify({
            text: text,

            model_id:
              "eleven_flash_v2_5"
          })
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      "ElevenLabs TTS HTTP " +
      response.status +
      ": " +
      errorText
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  const muLawBuffer =
    Buffer.from(
      arrayBuffer
    );

  console.log(
    "ElevenLabs μ-law:",
    muLawBuffer.length,
    "bytes"
  );

  // Convert μ-law -> PCM16.

  const pcmBuffer =
    muLawToPCM16(
      muLawBuffer
    );

  console.log(
    "Converted PCM:",
    pcmBuffer.length,
    "bytes"
  );

  // Send generated speech to caller.

  sendAudioToExotel(
    ws,
    streamSid,
    pcmBuffer
  );

  console.log(
    "ANSWER SENT TO CALLER"
  );
}

// ==================================================
// PROCESS COMPLETE QUESTION
// ==================================================

async function processQuestion(
  ws,
  streamSid,
  audioBuffer
) {

  try {

    console.log("");
    console.log(
      "################################"
    );

    console.log(
      "PROCESSING CALLER QUESTION"
    );

    console.log(
      "################################"
    );

    // ----------------------------------------------
    // SPEECH -> TEXT
    // ----------------------------------------------

    const question =
      await transcribeCallerAudio(
        audioBuffer
      );

    if (!question) {

      console.log(
        "No speech detected."
      );

      return;
    }

    // ----------------------------------------------
    // TEXT -> N8N
    // ----------------------------------------------

    const answer =
      await askN8N(
        question
      );

    // ----------------------------------------------
    // TEXT -> SPEECH
    // ----------------------------------------------

    await speakAnswer(
      ws,
      streamSid,
      answer
    );

  } catch (error) {

    console.log("");
    console.log(
      "################################"
    );

    console.log(
      "VOICE PROCESSING ERROR"
    );

    console.log(
      "################################"
    );

    console.error(
      error
    );
  }
}

// ==================================================
// EXOTEL WEBSOCKET CONNECTION
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

    let streamSid = null;

    let callSid = null;

    let audioChunks = [];

    let speechStarted = false;

    let silenceFrames = 0;

    let processing = false;

    // Exotel is sending
    // 320-byte / 20ms frames
    // in your current connection.

    const SPEECH_THRESHOLD = 350;

    // 35 x 20ms = approximately 700ms.

    const SILENCE_FRAME_LIMIT = 35;

    // ==================================================
    // AUDIO LEVEL
    // ==================================================

    function getAudioLevel(
      buffer
    ) {

      if (
        !buffer ||
        buffer.length < 2
      ) {

        return 0;
      }

      let total = 0;

      const samples =
        Math.floor(
          buffer.length / 2
        );

      for (
        let i = 0;
        i < samples;
        i++
      ) {

        const sample =
          buffer.readInt16LE(
            i * 2
          );

        total +=
          Math.abs(sample);
      }

      return (
        total / samples
      );
    }

    // ==================================================
    // RESET SPEECH
    // ==================================================

    function resetSpeech() {

      audioChunks = [];

      speechStarted = false;

      silenceFrames = 0;
    }

    // ==================================================
    // FINISH SPEECH
    // ==================================================

    async function finishSpeech() {

      if (processing) {
        return;
      }

      processing = true;

      const fullAudio =
        Buffer.concat(
          audioChunks
        );

      console.log("");
      console.log(
        "================================"
      );

      console.log(
        "END OF SPEECH"
      );

      console.log(
        "Audio buffer:",
        fullAudio.length,
        "bytes"
      );

      console.log(
        "================================"
      );

      resetSpeech();

      try {

        await processQuestion(
          ws,
          streamSid,
          fullAudio
        );

      } finally {

        processing = false;
      }
    }

    // ==================================================
    // MESSAGE
    // ==================================================

    ws.on(
      "message",
      async (data) => {

        try {

          const message =
            JSON.parse(
              data.toString()
            );

          const event =
            message.event;

          console.log(
            "Event:",
            event
          );

          // ============================================
          // CONNECTED
          // ============================================

          if (
            event === "connected"
          ) {

            console.log(
              "Exotel WebSocket connected."
            );

            return;
          }

          // ============================================
          // START
          // ============================================

          if (
            event === "start"
          ) {

            streamSid =
              message.stream_sid ||
              message.start?.stream_sid ||
              message.start?.streamSid ||
              null;

            callSid =
              message.start?.call_sid ||
              message.start?.callSid ||
              null;

            console.log(
              "Stream started."
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

            resetSpeech();

            return;
          }

          // ============================================
          // MEDIA
          // ============================================

          if (
            event === "media"
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

            const level =
              getAudioLevel(
                audio
              );

            console.log(
              "Audio:",
              audio.length,
              "bytes | level:",
              Math.round(level)
            );

            // --------------------------------------------
            // Don't process caller audio while the
            // AI response is being generated/sent.
            // --------------------------------------------

            if (processing) {
              return;
            }

            // --------------------------------------------
            // SPEECH START
            // --------------------------------------------

            if (
              level >
              SPEECH_THRESHOLD
            ) {

              if (!speechStarted) {

                console.log(
                  ">>> SPEECH STARTED"
                );

                speechStarted = true;
              }

              silenceFrames = 0;

              audioChunks.push(
                audio
              );

              return;
            }

            // --------------------------------------------
            // SPEECH CONTINUATION
            // --------------------------------------------

            if (speechStarted) {

              audioChunks.push(
                audio
              );

              silenceFrames++;

              console.log(
                "Silence:",
                silenceFrames,
                "/",
                SILENCE_FRAME_LIMIT
              );

              // ------------------------------------------
              // SPEECH END
              // ------------------------------------------

              if (
                silenceFrames >=
                SILENCE_FRAME_LIMIT
              ) {

                await finishSpeech();
              }
            }

            return;
          }

          // ============================================
          // DTMF
          // ============================================

          if (
            event === "dtmf"
          ) {

            console.log(
              "DTMF:",
              message.dtmf?.digit
            );

            return;
          }

          // ============================================
          // MARK
          // ============================================

          if (
            event === "mark"
          ) {

            console.log(
              "Exotel mark:",
              message.mark?.name
            );

            return;
          }

          // ============================================
          // CLEAR
          // ============================================

          if (
            event === "clear"
          ) {

            console.log(
              "Exotel CLEAR received."
            );

            resetSpeech();

            return;
          }

          // ============================================
          // STOP
          // ============================================

          if (
            event === "stop"
          ) {

            console.log(
              "Stream stopped."
            );

            resetSpeech();

            return;
          }

        } catch (error) {

          console.log(
            "Message parsing error:",
            error.message
          );
        }
      }
    );

    // ==================================================
    // CLOSE
    // ==================================================

    ws.on(
      "close",
      () => {

        console.log(
          "Exotel WebSocket disconnected."
        );
      }
    );

    // ==================================================
    // ERROR
    // ==================================================

    ws.on(
      "error",
      error => {

        console.log(
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
      "HTTP:",
      `http://localhost:${PORT}`
    );

    console.log(
      "WebSocket:",
      `ws://localhost:${PORT}`
    );

    console.log(
      "Public WebSocket:",
      WS_URL
    );

    console.log("");

    console.log(
      "Waiting for Exotel..."
    );

    console.log("");
  }
);
