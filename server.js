const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

const PUBLIC_URL =
  "https://ai-voice-bridge-q8qv.onrender.com";

const WS_URL =
  PUBLIC_URL.replace("https://", "wss://");

const GROQ_MODEL =
  "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  "nova-3";

const DEEPGRAM_TTS_MODEL =
  "aura-2-thalia-en";

// ============================================================
// PERFORMANCE SETTINGS
// ============================================================

// Faster speech detection.
const STT_ENDPOINTING_MS = 180;

// Don't wait too long for Tavily.
const TAVILY_TIMEOUT_MS = 1200;

// Safety timeout for Groq.
const GROQ_TIMEOUT_MS = 9000;

// ============================================================
// EXOTEL AUDIO
// ============================================================

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;

// 20 ms of 8kHz 16-bit mono PCM.
const AUDIO_CHUNK_SIZE =
  160 * BYTES_PER_SAMPLE;

const AUDIO_INTERVAL_MS = 20;

// ============================================================
// ENVIRONMENT
// ============================================================

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY;

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY;

if (!GROQ_API_KEY) {
  throw new Error(
    "GROQ_API_KEY is missing"
  );
}

if (!DEEPGRAM_API_KEY) {
  throw new Error(
    "DEEPGRAM_API_KEY is missing"
  );
}

if (!TAVILY_API_KEY) {
  console.log(
    "WARNING: TAVILY_API_KEY is missing"
  );
}

// ============================================================
// GROQ CLIENT
// ============================================================

const groq =
  new Groq({
    apiKey: GROQ_API_KEY
  });

// ============================================================
// ACTIVE CALLS
// ============================================================

const activeCalls =
  new Map();

let nextCallNumber = 1;

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (req, res) => {

      if (req.url === "/health") {

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            status: "ok",
            service:
              "h-and-m-ai-voice-assistant",
            model:
              GROQ_MODEL,
            stt:
              DEEPGRAM_STT_MODEL,
            tts:
              DEEPGRAM_TTS_MODEL,
            activeCalls:
              activeCalls.size
          })
        );

        return;
      }

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service:
            "h-and-m-ai-voice-assistant",
          websocket:
            WS_URL,
          activeCalls:
            activeCalls.size
        })
      );
    }
  );

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss =
  new WebSocket.Server({
    server
  });

// ============================================================
// H&M END CALL DETECTION
// ============================================================

function isEndCallPhrase(
  text
) {

  const q =
    String(text)
      .toLowerCase()
      .trim()
      .replace(/[.!?,]/g, "");

  const phrases = [

    "that's it",
    "thats it",

    "nothing else",

    "no that's all",
    "no thats all",

    "that's all",
    "thats all",

    "i'm done",
    "im done",

    "bye",

    "goodbye",

    "that's everything",
    "thats everything"
  ];

  return phrases.some(
    phrase =>
      q === phrase ||
      q.startsWith(
        phrase + " "
      )
  );
}

// ============================================================
// INTERRUPT WORDS
// ============================================================

function isExplicitInterrupt(
  text
) {

  const q =
    String(text)
      .toLowerCase()
      .trim();

  return /^(stop|wait|hold on|hang on|no wait|be quiet|that's enough|thats enough|enough|pause)\b/i
    .test(q);
}

// ============================================================
// WEB SEARCH DETECTION
// ============================================================

function needsWebSearch(
  question
) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const liveWords = [

    "today",
    "tonight",
    "tomorrow",
    "now",
    "currently",
    "current",
    "latest",
    "recent",
    "news",

    "weather",
    "temperature",

    "open now",
    "closed now",

    "opening hours",
    "opening time",

    "timing",
    "timings",

    "price",
    "prices",
    "cost",

    "score",
    "scores",

    "schedule",
    "scheduled",

    "traffic",

    "event",
    "events"
  ];

  for (
    const word of liveWords
  ) {

    if (
      q.includes(word)
    ) {

      return true;
    }
  }

  // General local search.
  const localWords = [

    "restaurant",
    "restaurants",

    "cafe",
    "cafes",

    "hotel",
    "hotels",

    "mall",

    "cinema",

    "hospital",

    "airport",

    "shop",
    "shops",

    "store",
    "stores",

    "where is",
    "where are",

    "located",
    "location",

    "near me",
    "nearby",

    "how far",

    "distance",

    "directions"
  ];

  for (
    const word of localWords
  ) {

    if (
      q.includes(word)
    ) {

      return true;
    }
  }

  return false;
}

// ============================================================
// TAVILY
// ============================================================

async function searchWeb(
  question
) {

  if (!TAVILY_API_KEY) {
    return "";
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      TAVILY_TIMEOUT_MS
    );

  try {

    const response =
      await fetch(
        "https://api.tavily.com/search",
        {
          method: "POST",

          headers: {
            Authorization:
              "Bearer " +
              TAVILY_API_KEY,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              query:
                question,

              search_depth:
                "basic",

              topic:
                "general",

              max_results:
                2,

              include_answer:
                true,

              include_raw_content:
                false
            }),

          signal:
            controller.signal
        }
      );

    if (!response.ok) {

      console.log(
        "Tavily HTTP:",
        response.status
      );

      return "";
    }

    const data =
      await response.json();

    let information =
      "";

    if (data?.answer) {

      information +=
        String(
          data.answer
        ) + " ";
    }

    if (
      Array.isArray(
        data?.results
      )
    ) {

      for (
        const result of
          data.results
      ) {

        information +=
          `${result?.title || ""}: ${
            result?.content || ""
          } `;
      }
    }

    return information
      .replace(/\s+/g, " ")
      .trim();

  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      console.log(
        "Tavily timeout"
      );

    } else {

      console.log(
        "Tavily error:",
        error.message
      );
    }

    return "";

  } finally {

    clearTimeout(
      timeout
    );
  }
}

// ============================================================
// DEEPGRAM STT
// ============================================================

function createDeepgramSTT() {

  return new Promise(
    (resolve, reject) => {

      const url =
        "wss://api.deepgram.com/v1/listen" +
        "?model=" +
        encodeURIComponent(
          DEEPGRAM_STT_MODEL
        ) +
        "&language=en-US" +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&channels=1" +
        "&interim_results=true" +
        "&punctuate=true" +
        "&endpointing=" +
        STT_ENDPOINTING_MS +
        "&smart_format=true";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                "Token " +
                DEEPGRAM_API_KEY
            }
          }
        );

      let settled =
        false;

      const timeout =
        setTimeout(
          () => {

            if (!settled) {

              try {
                socket.close();
              } catch (_) {}

              reject(
                new Error(
                  "Deepgram STT timeout"
                )
              );
            }

          },
          7000
        );

      socket.once(
        "open",
        () => {

          settled =
            true;

          clearTimeout(
            timeout
          );

          resolve(
            socket
          );
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(
              timeout
            );

            reject(
              error
            );
          }
        }
      );
    }
  );
}

// ============================================================
// DEEPGRAM TTS
// ============================================================

function createDeepgramTTS() {

  return new Promise(
    (resolve, reject) => {

      const url =
        "wss://api.deepgram.com/v1/speak" +
        "?model=" +
        encodeURIComponent(
          DEEPGRAM_TTS_MODEL
        ) +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&container=none";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                "Token " +
                DEEPGRAM_API_KEY
            }
          }
        );

      let settled =
        false;

      const timeout =
        setTimeout(
          () => {

            if (!settled) {

              try {
                socket.close();
              } catch (_) {}

              reject(
                new Error(
                  "Deepgram TTS timeout"
                )
              );
            }

          },
          7000
        );

      socket.once(
        "open",
        () => {

          settled =
            true;

          clearTimeout(
            timeout
          );

          resolve(
            socket
          );
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(
              timeout
            );

            reject(
              error
            );
          }
        }
      );
    }
  );
}

// ============================================================
// CLOSE DEEPGRAM
// ============================================================

function closeDeepgramSocket(
  socket
) {

  if (!socket) {
    return;
  }

  try {

    if (
      socket.readyState ===
      WebSocket.OPEN
    ) {

      socket.send(
        JSON.stringify({
          type:
            "Close"
        })
      );
    }

  } catch (_) {}

  try {
    socket.close();
  } catch (_) {}
}

// ============================================================
// EXOTEL AUDIO QUEUE
// ============================================================

function createAudioQueue(
  call
) {

  const queue = [];

  let timer =
    null;

  let sequenceNumber =
    1;

  let chunkNumber =
    0;

  let timestamp =
    0;

  let stopped =
    false;

  function sendNext() {

    timer =
      null;

    if (
      stopped ||
      call.destroyed
    ) {

      return;
    }

    if (
      !call.ws ||
      call.ws.readyState !==
        WebSocket.OPEN
    ) {

      queue.length = 0;

      return;
    }

    if (!call.streamSid) {
      return;
    }

    if (
      queue.length === 0
    ) {

      return;
    }

    const chunk =
      queue.shift();

    try {

      call.ws.send(
        JSON.stringify({

          event:
            "media",

          sequence_number:
            String(
              sequenceNumber
            ),

          stream_sid:
            call.streamSid,

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

      sequenceNumber++;

      chunkNumber++;

      timestamp +=
        AUDIO_INTERVAL_MS;

    } catch (error) {

      console.log(
        `[${call.id}] AUDIO SEND ERROR:`,
        error.message
      );

      return;
    }

    if (
      queue.length > 0
    ) {

      timer =
        setTimeout(
          sendNext,
          AUDIO_INTERVAL_MS
        );
    }
  }

  function enqueue(
    pcmBuffer
  ) {

    if (
      stopped ||
      call.destroyed ||
      !pcmBuffer ||
      pcmBuffer.length === 0
    ) {

      return;
    }

    for (
      let offset = 0;
      offset < pcmBuffer.length;
      offset += AUDIO_CHUNK_SIZE
    ) {

      queue.push(
        Buffer.from(
          pcmBuffer.subarray(
            offset,
            Math.min(
              offset +
                AUDIO_CHUNK_SIZE,
              pcmBuffer.length
            )
          )
        )
      );
    }

    if (!timer) {
      sendNext();
    }
  }

  function clear() {

    queue.length = 0;

    if (timer) {

      clearTimeout(
        timer
      );

      timer =
        null;
    }
  }

  function stop() {

    stopped =
      true;

    clear();
  }

  function pending() {

    return (
      queue.length > 0 ||
      Boolean(timer)
    );
  }

  return {
    enqueue,
    clear,
    stop,
    pending
  };
}

// ============================================================
// EXOTEL CLEAR AUDIO
// ============================================================

function clearExotelAudio(
  call
) {

  if (
    call.destroyed ||
    !call.ws ||
    call.ws.readyState !==
      WebSocket.OPEN ||
    !call.streamSid
  ) {

    return;
  }

  try {

    call.ws.send(
      JSON.stringify({

        event:
          "clear",

        stream_sid:
          call.streamSid
      })
    );

  } catch (error) {

    console.log(
      `[${call.id}] CLEAR ERROR:`,
      error.message
    );
  }
}

// ============================================================
// SEND MARK
// ============================================================

function sendExotelMark(
  call
) {

  if (
    call.destroyed ||
    !call.ws ||
    call.ws.readyState !==
      WebSocket.OPEN ||
    !call.streamSid
  ) {

    return;
  }

  try {

    call.ws.send(
      JSON.stringify({

        event:
          "mark",

        stream_sid:
          call.streamSid,

        mark: {

          name:
            "ai_response_complete"
        }
      })
    );

  } catch (_) {}
}

// ============================================================
// SEND TTS
// ============================================================

function sendTextToTTS(
  call,
  text,
  generation
) {

  if (
    call.destroyed
  ) {

    return false;
  }

  if (
    call.ttsGeneration !==
    generation
  ) {

    return false;
  }

  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {

    console.log(
      `[${call.id}] TTS NOT READY`
    );

    return false;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({

        type:
          "Speak",

        text:
          text
      })
    );

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS SEND ERROR:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// FLUSH TTS
// ============================================================

function flushTTS(
  call,
  generation
) {

  if (
    call.destroyed ||
    call.ttsGeneration !==
      generation
  ) {

    return false;
  }

  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {

    return false;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({
        type:
          "Flush"
      })
    );

    call.ttsFlushPending =
      true;

    call.ttsFlushGeneration =
      generation;

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS FLUSH ERROR:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// WAIT FOR AUDIO DRAIN
// ============================================================

function waitForAudioDrain(
  call,
  generation
) {

  if (
    call.destroyed ||
    call.ttsGeneration !==
      generation
  ) {

    return;
  }

  if (
    call.audioSender.pending()
  ) {

    setTimeout(
      () => {

        waitForAudioDrain(
          call,
          generation
        );

      },
      30
    );

    return;
  }

  call.ttsPlaybackActive =
    false;

  call.aiSpeaking =
    false;

  call.ttsFlushPending =
    false;

  if (
    call.ttsGeneration ===
    generation
  ) {

    sendExotelMark(
      call
    );
  }
}

// ============================================================
// INTERRUPT AI
// ============================================================

function interruptAI(
  call,
  reason
) {

  if (
    !call ||
    call.destroyed
  ) {

    return;
  }

  console.log(
    `[${call.id}] 🔴 INTERRUPT:`,
    reason
  );

  // Immediately invalidate old response.
  call.ttsGeneration++;

  call.aiSpeaking =
    false;

  call.ttsPlaybackActive =
    false;

  call.ttsFlushPending =
    false;

  // Remove all audio that hasn't been played.
  if (
    call.audioSender
  ) {

    call.audioSender.clear();
  }

  // Clear Exotel's buffered audio.
  clearExotelAudio(
    call
  );

  // Reset speech state.
  call.speechFinalParts =
    [];

  call.lastInterim =
    "";

  // Flush Deepgram TTS.
  if (
    call.ttsSocket &&
    call.ttsSocket.readyState ===
      WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type:
            "Flush"
        })
      );

    } catch (_) {}
  }

  console.log(
    `[${call.id}] 🔥 AI AUDIO STOPPED`
  );
}

// ============================================================
// GROQ STREAM
// ============================================================

async function streamGroq(
  call,
  question,
  webInformation,
  onText,
  generation
) {

  const messages = [

    {
      role:
        "system",

      content:
        `
You are the official H&M phone shopping assistant.

You are speaking to a customer on a real phone call.

IMPORTANT VOICE RULES:
- Speak naturally.
- Keep answers short and conversational.
- Do not sound like a scripted IVR.
- Do not give huge lists unless the customer asks.
- Ask one useful follow-up question at a time.
- Remember everything the customer says during this call.
- If the customer interrupts you, stop the old response and continue with the customer's new request.
- Never mention APIs, models, prompts, web searches or internal systems.

H&M SHOPPING CAPABILITIES:

You can help customers with:
- Products
- Clothing
- Jeans
- Shirts
- T-shirts
- Dresses
- Jackets
- Coats
- Hoodies
- Sweaters
- Trousers
- Shorts
- Skirts
- Shoes
- Accessories
- Men's products
- Women's products
- Kids' products
- Product colors
- Product sizes
- Product materials
- Fits
- Styles
- Product recommendations
- Shopping questions

UNDERSTAND NATURAL COLORS:

Do NOT reject a customer because they describe a color differently.

Understand phrases such as:
- faded blue
- faded bluish-green
- blue-green
- washed blue
- washed black
- charcoal
- stone
- cream
- ivory
- off-white
- beige
- tan
- khaki
- olive
- sage
- forest green
- burgundy
- wine
- rust
- terracotta
- light grey
- dark grey
- dusty pink
- baby pink
- sky blue
- navy
- denim blue

If a customer gives an unusual color description, interpret it naturally and continue helping.

UNDERSTAND MATERIALS:

Understand:
- cotton
- organic cotton
- recycled cotton
- denim
- rigid denim
- stretch denim
- linen
- wool
- polyester
- recycled polyester
- viscose
- rayon
- leather
- faux leather
- suede
- knit
- jersey
- fleece
- satin

UNDERSTAND FITS:

Understand:
- slim
- skinny
- regular
- relaxed
- loose
- oversized
- baggy
- straight
- bootcut
- wide leg
- flare
- cropped
- high waist
- mid waist
- low waist

PRODUCT CONVERSATION:

If the customer says:
"I want bootcut jeans"

Do NOT immediately give a long answer.

Ask something useful like:
"What color or wash are you looking for?"

If they say:
"faded bluish-green"

Understand that as a color/wash preference.

Then ask:
"What size do you need?"

If they give a size, remember it.

If they give material, remember it.

Example:

Customer:
"I want bootcut jeans."

Assistant:
"Sure. What color or wash are you looking for?"

Customer:
"Something faded bluish-green."

Assistant:
"Got it. What size do you need?"

Customer:
"32."

Assistant:
"Got it — bootcut jeans, faded bluish-green, size 32."

Then continue naturally.

PRODUCT AVAILABILITY:

Do not invent exact stock unless current product information is provided.

If current product information is available, use it.

If it isn't available, say naturally:
"I can help narrow that down, but I don't have live stock information for that item right now."

UNAVAILABLE H&M SERVICES:

For now, these are NOT functional:
- Returns
- Refunds
- Order tracking
- Delivery support
- Account support
- Payments
- Complaints
- Store operations
- Loyalty
- Gift cards

If the customer asks about those, say:

"Sorry, that option isn't available through this assistant right now."

Then offer shopping help.

UNRELATED QUESTIONS:

You can answer simple general questions naturally.

Do not randomly say:
"I can only help with H&M products."

If the customer asks something completely unrelated, answer briefly when possible.

If the request requires a service unavailable through this assistant, explain that naturally.

ENDING:

If the customer clearly says:
- that's it
- nothing else
- no that's all
- I'm done
- bye
- goodbye
- that's everything

the application may end the call.

Do not repeatedly ask if they need anything else.

Keep the conversation natural.
`
    }
  ];

  // ============================================================
  // MEMORY
  // ============================================================

  for (
    const item of
      call.conversationHistory
  ) {

    messages.push({
      role:
        item.role,

      content:
        item.content
    });
  }

  // ============================================================
  // WEB INFO
  // ============================================================

  if (
    webInformation
  ) {

    messages.push({

      role:
        "system",

      content:
        "CURRENT INFORMATION:\n" +
        webInformation
    });
  }

  // ============================================================
  // USER
  // ============================================================

  messages.push({

    role:
      "user",

    content:
      question
  });

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {

        controller.abort();

      },
      GROQ_TIMEOUT_MS
    );

  try {

    const stream =
      await groq.chat.completions.create(
        {
          model:
            GROQ_MODEL,

          messages:
            messages,

          temperature:
            0.25,

          max_tokens:
            120,

          top_p:
            0.9,

          stream:
            true
        },
        {
          signal:
            controller.signal
        }
      );

    let fullAnswer =
      "";

    let pendingText =
      "";

    for await (
      const chunk of
        stream
    ) {

      // Old response?
      if (
        call.destroyed ||
        call.ttsGeneration !==
          generation
      ) {

        break;
      }

      const token =
        chunk
          ?.choices?.[0]
          ?.delta
          ?.content || "";

      if (!token) {
        continue;
      }

      fullAnswer +=
        token;

      pendingText +=
        token;

      // ========================================================
      // SENTENCE DETECTION
      // ========================================================

      let match;

      while (
        (
          match =
            pendingText.match(
              /^([\s\S]*?[.!?])(?:\s+|$)/
            )
        )
      ) {

        if (
          call.destroyed ||
          call.ttsGeneration !==
            generation
        ) {

          break;
        }

        const sentence =
          match[1]
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        pendingText =
          pendingText
            .slice(
              match[0].length
            )
            .trimStart();

        if (
          sentence
        ) {

          await onText(
            sentence
          );
        }
      }

      // ========================================================
      // FAST CHUNK
      // ========================================================

      if (
        pendingText.length >=
        38
      ) {

        const lastSpace =
          pendingText.lastIndexOf(
            " "
          );

        if (
          lastSpace >= 18
        ) {

          const chunkText =
            pendingText
              .slice(
                0,
                lastSpace
              )
              .trim();

          pendingText =
            pendingText
              .slice(
                lastSpace + 1
              )
              .trimStart();

          if (
            chunkText &&
            call.ttsGeneration ===
              generation
          ) {

            await onText(
              chunkText
            );
          }
        }
      }
    }

    // ========================================================
    // REMAINING TEXT
    // ========================================================

    if (
      pendingText.trim() &&
      !call.destroyed &&
      call.ttsGeneration ===
        generation
    ) {

      await onText(
        pendingText
          .replace(
            /\s+/g,
            " "
          )
          .trim()
      );
    }

    return fullAnswer
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  } finally {

    clearTimeout(
      timeout
    );
  }
}

// ============================================================
// PROCESS QUESTION
// ============================================================

async function processQuestion(
  call,
  question
) {

  if (
    call.destroyed
  ) {

    return;
  }

  const cleanQuestion =
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (
    !cleanQuestion
  ) {

    return;
  }

  console.log(
    `[${call.id}] CUSTOMER:`,
    cleanQuestion
  );

  // ============================================================
  // END CALL
  // ============================================================

  if (
    isEndCallPhrase(
      cleanQuestion
    )
  ) {

    console.log(
      `[${call.id}] END PHRASE DETECTED`
    );

    // We don't immediately kill the call.
    // Give the customer a short goodbye.
    const generation =
      ++call.ttsGeneration;

    call.aiSpeaking =
      true;

    call.ttsPlaybackActive =
      true;

    const sent =
      sendTextToTTS(
        call,
        "Thanks for calling H&M. Goodbye!",
        generation
      );

    if (sent) {

      flushTTS(
        call,
        generation
      );

      // Give audio a chance to leave.
      setTimeout(
        () => {

          if (
            !call.destroyed
          ) {

            destroyCall(
              call
            );
          }

        },
        1800
      );

    } else {

      destroyCall(
        call
      );
    }

    return;
  }

  // ============================================================
  // NEW GENERATION
  // ============================================================

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking =
    true;

  call.ttsPlaybackActive =
    true;

  call.ttsFlushPending =
    false;

  let sentTTS =
    false;

  const started =
    Date.now();

  try {

    // ==========================================================
    // WEB SEARCH
    // ==========================================================

    let webInformation =
      "";

    if (
      needsWebSearch(
        cleanQuestion
      )
    ) {

      console.log(
        `[${call.id}] SEARCH: YES`
      );

      webInformation =
        await searchWeb(
          cleanQuestion
        );

    } else {

      console.log(
        `[${call.id}] SEARCH: NO`
      );
    }

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation
    ) {

      return;
    }

    // ==========================================================
    // STREAM TTS
    // ==========================================================

    const sendText =
      async text => {

        if (
          call.destroyed ||
          call.ttsGeneration !==
            generation
        ) {

          return;
        }

        const sent =
          sendTextToTTS(
            call,
            text,
            generation
          );

        if (
          sent
        ) {

          sentTTS =
            true;

          call.aiSpeaking =
            true;

          call.ttsPlaybackActive =
            true;
        }
      };

    // ==========================================================
    // GROQ
    // ==========================================================

    const answer =
      await streamGroq(
        call,
        cleanQuestion,
        webInformation,
        sendText,
        generation
      );

    // ==========================================================
    // INTERRUPTED?
    // ==========================================================

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation
    ) {

      console.log(
        `[${call.id}] OLD RESPONSE DISCARDED`
      );

      return;
    }

    // ==========================================================
    // FLUSH
    // ==========================================================

    if (
      sentTTS
    ) {

      flushTTS(
        call,
        generation
      );

    } else {

      call.aiSpeaking =
        false;

      call.ttsPlaybackActive =
        false;
    }

    // ==========================================================
    // MEMORY
    // ==========================================================

    if (
      answer &&
      call.ttsGeneration ===
        generation
    ) {

      call.conversationHistory.push({

        role:
          "user",

        content:
          cleanQuestion
      });

      call.conversationHistory.push({

        role:
          "assistant",

        content:
          answer
      });

      // Keep last 5 exchanges.
      if (
        call.conversationHistory.length >
        10
      ) {

        call.conversationHistory =
          call.conversationHistory.slice(
            -10
          );
      }
    }

    console.log(
      `[${call.id}] AI:`,
      answer
    );

    console.log(
      `[${call.id}] RESPONSE START:`,
      Date.now() - started,
      "ms"
    );

  } catch (error) {

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation
    ) {

      return;
    }

    console.log(
      `[${call.id}] PROCESS ERROR:`,
      error.message
    );

    try {

      const sent =
        sendTextToTTS(
          call,
          "Sorry, I had trouble answering that.",
          generation
        );

      if (sent) {

        flushTTS(
          call,
          generation
        );
      }

    } catch (_) {}

  }
}

// ============================================================
// QUESTION QUEUE
// ============================================================

function enqueueQuestion(
  call,
  question
) {

  if (
    call.destroyed
  ) {

    return;
  }

  const clean =
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (
    !clean
  ) {

    return;
  }

  // ==========================================================
  // IF AI IS SPEAKING -> BARGE IN
  // ==========================================================

  if (
    call.aiSpeaking ||
    call.ttsPlaybackActive
  ) {

    interruptAI(
      call,
      "new customer speech"
    );

    // New question always wins.
    call.questionQueue =
      [];
  }

  call.questionQueue.push(
    clean
  );

  runQuestionQueue(
    call
  );
}

// ============================================================
// QUESTION QUEUE RUNNER
// ============================================================

async function runQuestionQueue(
  call
) {

  if (
    call.queueRunning ||
    call.destroyed
  ) {

    return;
  }

  call.queueRunning =
    true;

  try {

    while (
      call.questionQueue.length > 0 &&
      !call.destroyed
    ) {

      const question =
        call.questionQueue.shift();

      await processQuestion(
        call,
        question
      );
    }

  } catch (error) {

    console.log(
      `[${call.id}] QUEUE ERROR:`,
      error.message
    );

  } finally {

    call.queueRunning =
      false;
  }
}

// ============================================================
// GREETING
// ============================================================

async function speakGreeting(
  call
) {

  if (
    call.destroyed ||
    call.greetingSent
  ) {

    return;
  }

  // Wait for TTS.
  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {

    console.log(
      `[${call.id}] TTS not ready for greeting`
    );

    return;
  }

  call.greetingSent =
    true;

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking =
    true;

  call.ttsPlaybackActive =
    true;

  const greeting =
    "Hi, welcome to H&M. I can help you find products, choose sizes, colors, fits and materials, and help you with your shopping. What would you like to purchase today?";

  console.log(
    `[${call.id}] GREETING`
  );

  const sent =
    sendTextToTTS(
      call,
      greeting,
      generation
    );

  if (sent) {

    flushTTS(
      call,
      generation
    );

  } else {

    call.aiSpeaking =
      false;

    call.ttsPlaybackActive =
      false;

    call.greetingSent =
      false;
  }
}

// ============================================================
// CALL SESSION
// ============================================================

function createCallSession(
  ws
) {

  const id =
    "CALL-" +
    String(
      nextCallNumber++
    );

  const call = {

    id,

    ws,

    destroyed:
      false,

    streamSid:
      null,

    callSid:
      null,

    sttSocket:
      null,

    ttsSocket:
      null,

    sttReady:
      false,

    ttsReady:
      false,

    speechFinalParts:
      [],

    lastInterim:
      "",

    lastSpeechTime:
      0,

    conversationHistory:
      [],

    questionQueue:
      [],

    queueRunning:
      false,

    // ========================================================
    // TTS STATE
    // ========================================================

    aiSpeaking:
      false,

    ttsPlaybackActive:
      false,

    ttsFlushPending:
      false,

    ttsFlushGeneration:
      0,

    ttsGeneration:
      0,

    greetingSent:
      false,

    audioSender:
      null
  };

  call.audioSender =
    createAudioQueue(
      call
    );

  return call;
}

// ============================================================
// DESTROY CALL
// ============================================================

function destroyCall(
  call
) {

  if (
    !call ||
    call.destroyed
  ) {

    return;
  }

  console.log(
    `[${call.id}] CLEANING CALL`
  );

  call.destroyed =
    true;

  call.ttsGeneration++;

  call.aiSpeaking =
    false;

  call.ttsPlaybackActive =
    false;

  call.questionQueue =
    [];

  call.speechFinalParts =
    [];

  call.lastInterim =
    "";

  if (
    call.audioSender
  ) {

    call.audioSender.stop();
  }

  closeDeepgramSocket(
    call.sttSocket
  );

  closeDeepgramSocket(
    call.ttsSocket
  );

  call.sttSocket =
    null;

  call.ttsSocket =
    null;

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] CALL CLEANED`
  );

  console.log(
    "ACTIVE CALLS:",
    activeCalls.size
  );
}

// ============================================================
// DEEPGRAM SETUP
// ============================================================

async function setupDeepgram(
  call
) {

  try {

    const [
      sttSocket,
      ttsSocket
    ] =
      await Promise.all([

        createDeepgramSTT(),

        createDeepgramTTS()

      ]);

    if (
      call.destroyed
    ) {

      closeDeepgramSocket(
        sttSocket
      );

      closeDeepgramSocket(
        ttsSocket
      );

      return;
    }

    call.sttSocket =
      sttSocket;

    call.ttsSocket =
      ttsSocket;

    call.sttReady =
      true;

    call.ttsReady =
      true;

    console.log(
      `[${call.id}] DEEPGRAM READY`
    );

    // ========================================================
    // STT MESSAGES
    // ========================================================

    sttSocket.on(
      "message",
      raw => {

        if (
          call.destroyed
        ) {

          return;
        }

        try {

          const message =
            JSON.parse(
              raw.toString()
            );

          const alternative =
            message
              ?.channel
              ?.alternatives?.[0];

          const transcript =
            alternative
              ?.transcript || "";

          if (
            !transcript.trim()
          ) {

            return;
          }

          // ====================================================
          // INTERIM
          // ====================================================

          if (
            !message.is_final
          ) {

            call.lastInterim =
              transcript;

            call.lastSpeechTime =
              Date.now();

            // ==================================================
            // BARGE-IN
            // ==================================================

            if (
              (
                call.aiSpeaking ||
                call.ttsPlaybackActive
              ) &&
              transcript.trim().length >= 2
            ) {

              const lower =
                transcript
                  .toLowerCase()
                  .trim();

              console.log(
                `[${call.id}] INTERIM DURING AI:`,
                lower
              );

              if (
                isExplicitInterrupt(
                  lower
                )
              ) {

                interruptAI(
                  call,
                  "explicit interrupt"
                );
              }

              // Natural barge-in:
              // Don't wait for a final transcript.
              else if (
                lower.length >= 4
              ) {

                interruptAI(
                  call,
                  "natural barge-in"
                );
              }
            }

            return;
          }

          // ====================================================
          // FINAL
          // ====================================================

          call.speechFinalParts.push(
            transcript
          );

          call.lastInterim =
            "";

          if (
            message.speech_final
          ) {

            const question =
              call.speechFinalParts
                .join(" ")
                .replace(
                  /\s+/g,
                  " "
                )
                .trim();

            call.speechFinalParts =
              [];

            if (
              question
            ) {

              console.log(
                `[${call.id}] FINAL:`,
                question
              );

              enqueueQuestion(
                call,
                question
              );
            }
          }

        } catch (error) {

          console.log(
            `[${call.id}] STT MESSAGE ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // TTS AUDIO
    // ========================================================

    ttsSocket.on(
      "message",
      (data, isBinary) => {

        if (
          call.destroyed
        ) {

          return;
        }

        try {

          // ====================================================
          // BINARY AUDIO
          // ====================================================

          if (
            isBinary ||
            Buffer.isBuffer(data)
          ) {

            const audio =
              Buffer.from(
                data
              );

            // IMPORTANT:
            // We use ttsPlaybackActive instead of
            // aiSpeaking.
            //
            // This prevents late Deepgram audio
            // from being discarded.
            if (
              audio.length > 0 &&
              call.ttsPlaybackActive
            ) {

              call.audioSender.enqueue(
                audio
              );
            }

            return;
          }

          // ====================================================
          // JSON
          // ====================================================

          let message;

          try {

            message =
              JSON.parse(
                data.toString()
              );

          } catch (_) {

            return;
          }

          // ====================================================
          // TTS FLUSH COMPLETE
          // ====================================================

          if (
            message.type ===
            "Flushed"
          ) {

            const generation =
              call.ttsFlushGeneration;

            console.log(
              `[${call.id}] TTS FLUSHED`
            );

            waitForAudioDrain(
              call,
              generation
            );
          }

          if (
            message.type ===
            "Warning"
          ) {

            console.log(
              `[${call.id}] TTS WARNING:`,
              message.description ||
                message.code ||
                "unknown"
            );
          }

        } catch (error) {

          console.log(
            `[${call.id}] TTS MESSAGE ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // STT CLOSE
    // ========================================================

    sttSocket.on(
      "close",
      () => {

        call.sttReady =
          false;

        console.log(
          `[${call.id}] STT CLOSED`
        );
      }
    );

    // ========================================================
    // TTS CLOSE
    // ========================================================

    ttsSocket.on(
      "close",
      () => {

        call.ttsReady =
          false;

        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    );

    // ========================================================
    // SOCKET ERRORS
    // ========================================================

    sttSocket.on(
      "error",
      error => {

        console.log(
          `[${call.id}] STT ERROR:`,
          error.message
        );
      }
    );

    ttsSocket.on(
      "error",
      error => {

        console.log(
          `[${call.id}] TTS ERROR:`,
          error.message
        );
      }
    );

    // ========================================================
    // GREETING
    // ========================================================

    if (
      call.streamSid &&
      !call.greetingSent
    ) {

      await speakGreeting(
        call
      );
    }

  } catch (error) {

    console.log(
      `[${call.id}] DEEPGRAM SETUP ERROR:`,
      error.message
    );
  }
}

// ============================================================
// EXOTEL CONNECTION
// ============================================================

wss.on(
  "connection",
  ws => {

    const call =
      createCallSession(
        ws
      );

    activeCalls.set(
      call.id,
      call
    );

    console.log(
      "============================================"
    );

    console.log(
      `[${call.id}] EXOTEL CONNECTED`
    );

    console.log(
      "ACTIVE CALLS:",
      activeCalls.size
    );

    console.log(
      "============================================"
    );

    // ========================================================
    // START DEEPGRAM
    // ========================================================

    setupDeepgram(
      call
    );

    // ========================================================
    // EXOTEL EVENTS
    // ========================================================

    ws.on(
      "message",
      data => {

        if (
          call.destroyed
        ) {

          return;
        }

        try {

          const message =
            JSON.parse(
              data.toString()
            );

          const event =
            message.event;

          // ==================================================
          // CONNECTED
          // ==================================================

          if (
            event ===
            "connected"
          ) {

            console.log(
              `[${call.id}] STREAM CONNECTED`
            );

            return;
          }

          // ==================================================
          // START
          // ==================================================

          if (
            event ===
            "start"
          ) {

            call.streamSid =
              message.stream_sid ||
              message.start?.stream_sid ||
              message.start?.streamSid ||
              null;

            call.callSid =
              message.start?.call_sid ||
              message.start?.callSid ||
              null;

            console.log(
              `[${call.id}] CALL START:`,
              call.callSid
            );

            console.log(
              `[${call.id}] STREAM SID:`,
              call.streamSid
            );

            // If Deepgram already finished loading,
            // greet immediately.
            if (
              call.ttsReady &&
              !call.greetingSent
            ) {

              speakGreeting(
                call
              );
            }

            return;
          }

          // ==================================================
          // MEDIA
          // ==================================================

          if (
            event ===
            "media"
          ) {

            if (
              !message.media?.payload
            ) {

              return;
            }

            if (
              !call.sttSocket ||
              call.sttSocket.readyState !==
                WebSocket.OPEN
            ) {

              return;
            }

            const audio =
              Buffer.from(
                message.media.payload,
                "base64"
              );

            try {

              call.sttSocket.send(
                audio
              );

            } catch (error) {

              console.log(
                `[${call.id}] STT SEND ERROR:`,
                error.message
              );
            }

            return;
          }

          // ==================================================
          // CLEAR
          // ==================================================

          if (
            event ===
            "clear"
          ) {

            call.speechFinalParts =
              [];

            call.lastInterim =
              "";

            return;
          }

          // ==================================================
          // STOP
          // ==================================================

          if (
            event ===
            "stop"
          ) {

            console.log(
              `[${call.id}] EXOTEL STOP`
            );

            destroyCall(
              call
            );

            return;
          }

        } catch (error) {

          console.log(
            `[${call.id}] EXOTEL MESSAGE ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // WEBSOCKET CLOSE
    // ========================================================

    ws.on(
      "close",
      () => {

        console.log(
          `[${call.id}] EXOTEL DISCONNECTED`
        );

        destroyCall(
          call
        );
      }
    );

    // ========================================================
    // WEBSOCKET ERROR
    // ========================================================

    ws.on(
      "error",
      error => {

        console.log(
          `[${call.id}] EXOTEL WS ERROR:`,
          error.message
        );

        destroyCall(
          call
        );
      }
    );
  }
);

// ============================================================
// SERVER ERROR
// ============================================================

server.on(
  "error",
  error => {

    console.error(
      "SERVER ERROR:",
      error
    );
  }
);

// ============================================================
// START SERVER
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "============================================"
    );

    console.log(
      "        H&M AI VOICE ASSISTANT"
    );

    console.log(
      "============================================"
    );

    console.log(
      "LLM:",
      GROQ_MODEL
    );

    console.log(
      "STT:",
      DEEPGRAM_STT_MODEL
    );

    console.log(
      "TTS:",
      DEEPGRAM_TTS_MODEL
    );

    console.log(
      "Tavily:",
      TAVILY_API_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "WebSocket:",
      WS_URL
    );

    console.log(
      "============================================"
    );
  }
);
