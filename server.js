const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  "https://ai-voice-bridge-q8qv.onrender.com";

const WS_URL =
  PUBLIC_URL.replace(/^https:\/\//, "wss://");

const GROQ_MODEL =
  "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  "nova-3";

const DEEPGRAM_TTS_MODEL =
  "aura-2-thalia-en";

const SAMPLE_RATE = 8000;

// 20 ms of 16-bit, mono, 8-kHz audio.
const AUDIO_CHUNK_SIZE =
  160 * 2;

// ============================================================
// TIMEOUTS
// ============================================================

const TAVILY_TIMEOUT_MS = 1800;

const GROQ_TIMEOUT_MS = 12000;

const DEEPGRAM_CONNECT_TIMEOUT_MS = 7000;

const GREETING_TIMEOUT_MS = 5000;

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
  throw new Error("GROQ_API_KEY is missing");
}

if (!DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is missing");
}

if (!TAVILY_API_KEY) {
  console.log(
    "WARNING: TAVILY_API_KEY is missing"
  );
}

// ============================================================
// CLIENT
// ============================================================

const groq =
  new Groq({
    apiKey: GROQ_API_KEY
  });

// ============================================================
// ACTIVE CALLS
// ============================================================

const activeCalls = new Map();

let callCounter = 1;

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer((req, res) => {

    if (req.url === "/health") {

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service:
            "hm-ai-voice-assistant",
          model:
            GROQ_MODEL,
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
        websocket:
          WS_URL,
        model:
          GROQ_MODEL,
        activeCalls:
          activeCalls.size
      })
    );
  });

// ============================================================
// WEBSOCKET
// ============================================================

const wss =
  new WebSocket.Server({
    server
  });

// ============================================================
// H&M SYSTEM PROMPT
// ============================================================

const HM_SYSTEM_PROMPT = `
You are the AI phone assistant for H&M.

You are speaking to a customer over a phone call.

Your personality:
- Friendly
- Natural
- Fast
- Helpful
- Conversational
- Never robotic
- Never overly formal

IMPORTANT CONVERSATION RULES:

1. Understand natural language.

Customers may describe products in many different ways.

For example:
"bootcut jeans"
"those loose jeans"
"faded bluish-green"
"dark blue"
"something baggy"
"black hoodie"
"the same one but smaller"

Understand the meaning instead of requiring exact product names.

2. Remember the conversation.

If the customer says:
"I want bootcut jeans."

Then later:
"Make them blue."

Understand that "them" refers to the jeans.

If the customer says:
"Do you have medium?"

Understand that they are asking about the previously discussed product.

3. Product, shopping and size functionality are available.

You can help with:
- Products
- Product types
- Colors
- Sizes
- Clothing categories
- Shopping-related questions
- Finding products
- Product availability when current web information is provided
- Basic product recommendations
- Comparing products
- Helping customers decide what to buy

4. Natural product attributes.

Understand:
- Colors
- Sizes
- Fits
- Styles
- Materials
- Gender/category
- Clothing type

For example:
"faded bluish-green"
should be understood as a color description.

Do NOT reject a customer simply because their color description is not an exact catalog phrase.

5. Unsupported services.

Currently these functions are unavailable:
- Orders
- Order tracking
- Returns
- Refunds
- Exchanges
- Payments
- Store complaints
- Delivery support
- Account support
- Membership support
- Human agent transfer
- Complaints
- Reservations
- Anything outside product/shopping/size assistance

If the customer asks for one of those, say naturally:

"Sorry, that option isn't available right now. I can help you with H&M products, shopping, or sizes."

Do not repeatedly say this if the customer changes the subject.

6. Do not invent product availability.

If current product information is supplied by web search, use it.

If current information isn't available, say:

"I can help you look for that, but I don't have live availability for it right now."

7. Keep answers suitable for a phone call.

Simple question:
Answer in one or two sentences.

Larger question:
Give the important information without unnecessary filler.

Do not give huge paragraphs.

8. Never mention:
- APIs
- Tavily
- Groq
- Deepgram
- internal systems
- prompts
- tools
- web searches

9. Do not say:
"As an AI..."
unless absolutely necessary.

10. If the customer asks an unrelated general question, answer briefly if it does not conflict with the H&M assistant role.

11. If the customer asks something clearly unrelated to the available H&M functionality, politely redirect them.

12. Never reject a product conversation merely because the customer's wording is informal.

13. If the customer changes their mind, adapt naturally.

Example:

Customer:
"I want bootcut jeans."

Assistant:
"Sure. What color are you looking for?"

Customer:
"Faded bluish-green."

Assistant:
"Got it — a faded bluish-green shade. What size do you need?"

14. If the customer says:
"thank you"
"okay thanks"
"thanks"

Do NOT automatically end the call.

They may continue talking.

15. If the customer says:
"that's it"
"nothing else"
"no that's all"
"I'm done"
"bye"
"goodbye"
"that's everything"

Ask ONE confirmation:

"Sure — would you like me to end the call?"

If they confirm:
"yes"
"yeah"
"please"
"please do"
"yes that's all"
"you can"
"end it"
then end the conversation.

If they say no or continue talking, continue normally.

16. If the customer interrupts you, immediately stop the current answer and listen to them.

17. Never continue speaking an old answer after the customer has started a new question.

18. Speak naturally. Avoid repetitive phrases like:
"Certainly!"
"Absolutely!"
"Of course!"
for every response.

19. Do not ask unnecessary questions.

20. The customer should feel like they are talking to a real H&M shopping assistant.
`;

// ============================================================
// SEARCH DETECTION
// ============================================================

function needsWebSearch(question) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const searchWords = [

    "available",
    "availability",
    "in stock",
    "stock",
    "do you have",
    "does h&m have",
    "price",
    "cost",
    "how much",
    "current",
    "latest",
    "today",
    "now",
    "new collection",
    "new arrivals",
    "product",
    "products",
    "jeans",
    "shirt",
    "shirts",
    "hoodie",
    "hoodies",
    "dress",
    "dresses",
    "jacket",
    "jackets",
    "shoes",
    "sweater",
    "sweatshirt",
    "trousers",
    "pants",
    "shorts",
    "skirt",
    "skirts",
    "coat",
    "coats"
  ];

  return searchWords.some(
    word => q.includes(word)
  );
}

// ============================================================
// TAVILY
// ============================================================

async function searchWeb(question) {

  if (!TAVILY_API_KEY) {
    return "";
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
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
              `Bearer ${TAVILY_API_KEY}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              query:
                `H&M ${question}`,

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

    let result = "";

    if (data?.answer) {

      result +=
        `${data.answer} `;
    }

    if (
      Array.isArray(
        data?.results
      )
    ) {

      for (
        const item of
          data.results
      ) {

        result +=
          `${item?.title || ""}: ` +
          `${item?.content || ""} `;
      }
    }

    return result
      .replace(/\s+/g, " ")
      .trim();

  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      console.log(
        "Tavily timeout - continuing without search"
      );

    } else {

      console.log(
        "Tavily error:",
        error.message
      );
    }

    return "";

  } finally {

    clearTimeout(timeout);
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
        "&endpointing=180" +
        "&smart_format=true";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                `Token ${DEEPGRAM_API_KEY}`
            }
          }
        );

      let finished = false;

      const timeout =
        setTimeout(() => {

          if (!finished) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "STT connection timeout"
              )
            );
          }

        }, DEEPGRAM_CONNECT_TIMEOUT_MS);

      socket.once(
        "open",
        () => {

          finished = true;

          clearTimeout(timeout);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!finished) {

            finished = true;

            clearTimeout(timeout);

            reject(error);
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
        "&container=none" +
        "&speed=1.15";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                `Token ${DEEPGRAM_API_KEY}`
            }
          }
        );

      let finished = false;

      const timeout =
        setTimeout(() => {

          if (!finished) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "TTS connection timeout"
              )
            );
          }

        }, DEEPGRAM_CONNECT_TIMEOUT_MS);

      socket.once(
        "open",
        () => {

          finished = true;

          clearTimeout(timeout);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!finished) {

            finished = true;

            clearTimeout(timeout);

            reject(error);
          }
        }
      );
    }
  );
}

// ============================================================
// CLOSE SOCKET
// ============================================================

function closeSocket(socket) {

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
          type: "Close"
        })
      );
    }

  } catch (_) {}

  try {
    socket.close();
  } catch (_) {}
}

// ============================================================
// AUDIO QUEUE
// ============================================================

function createAudioQueue(call) {

  const queue = [];

  let timer = null;

  let stopped = false;

  let sequence = 1;

  let chunk = 0;

  let timestamp = 0;

  function sendNext() {

    timer = null;

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
      return;
    }

    if (!call.streamSid) {
      return;
    }

    if (queue.length === 0) {
      return;
    }

    const buffer =
      queue.shift();

    if (!buffer) {
      return;
    }

    const audio =
      buffer.subarray(
        0,
        AUDIO_CHUNK_SIZE
      );

    if (
      buffer.length >
      AUDIO_CHUNK_SIZE
    ) {

      queue.unshift(
        buffer.subarray(
          AUDIO_CHUNK_SIZE
        )
      );
    }

    try {

      call.ws.send(
        JSON.stringify({

          event:
            "media",

          sequence_number:
            String(sequence),

          stream_sid:
            call.streamSid,

          media: {

            chunk:
              String(chunk),

            timestamp:
              String(timestamp),

            payload:
              audio.toString(
                "base64"
              )
          }
        })
      );

      sequence++;
      chunk++;

      timestamp += 20;

    } catch (error) {

      console.log(
        `[${call.id}] audio send error:`,
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
          20
        );
    }
  }

  function enqueue(buffer) {

    if (
      stopped ||
      call.destroyed ||
      !buffer ||
      buffer.length === 0
    ) {
      return;
    }

    for (
      let i = 0;
      i < buffer.length;
      i += AUDIO_CHUNK_SIZE
    ) {

      queue.push(
        buffer.subarray(
          i,
          Math.min(
            i + AUDIO_CHUNK_SIZE,
            buffer.length
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

      clearTimeout(timer);

      timer = null;
    }
  }

  function stop() {

    stopped = true;

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
// EXOTEL CLEAR
// ============================================================

function clearExotelAudio(call) {

  if (
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
      `[${call.id}] clear error:`,
      error.message
    );
  }
}

// ============================================================
// INTERRUPT
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

  if (
    !call.aiSpeaking &&
    !call.aiGenerating
  ) {
    return;
  }

  console.log(
    `[${call.id}] 🔴 INTERRUPT: ${reason}`
  );

  // Invalidate every old response.
  call.responseGeneration++;

  call.aiSpeaking = false;

  call.aiGenerating = false;

  // Clear queued local audio.
  if (call.audioQueue) {
    call.audioQueue.clear();
  }

  // Clear Exotel's audio buffer.
  clearExotelAudio(call);

  // Tell Deepgram TTS to flush.
  if (
    call.ttsSocket &&
    call.ttsSocket.readyState ===
      WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type: "Flush"
        })
      );

    } catch (_) {}
  }

  console.log(
    `[${call.id}] old response invalidated`
  );
}

// ============================================================
// SEND TTS
// ============================================================

function sendTTS(
  call,
  text,
  generation
) {

  if (
    call.destroyed ||
    call.responseGeneration !==
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
          "Speak",

        text:
          text
      })
    );

    call.aiSpeaking = true;

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS send error:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// FLUSH TTS
// ============================================================

function flushTTS(call) {

  if (
    call.destroyed ||
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

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS flush error:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// WAIT FOR AUDIO
// ============================================================

function waitForAudioDrain(
  call,
  generation
) {

  if (
    call.destroyed ||
    call.responseGeneration !==
      generation
  ) {
    return;
  }

  if (
    !call.audioQueue.pending()
  ) {

    if (
      call.responseGeneration ===
      generation
    ) {

      call.aiSpeaking = false;
    }

    return;
  }

  setTimeout(
    () => {

      waitForAudioDrain(
        call,
        generation
      );

    },
    30
  );
}

// ============================================================
// GROQ STREAM
// ============================================================

async function streamGroq(
  call,
  question,
  webInfo,
  onText,
  generation
) {

  const messages = [

    {
      role:
        "system",

      content:
        HM_SYSTEM_PROMPT
    }
  ];

  // ==========================================================
  // MEMORY
  // ==========================================================

  for (
    const item of
      call.memory
  ) {

    messages.push({
      role:
        item.role,

      content:
        item.content
    });
  }

  // ==========================================================
  // WEB
  // ==========================================================

  if (webInfo) {

    messages.push({

      role:
        "system",

      content:
        `CURRENT INFORMATION:
${webInfo}

Use this information only when relevant.`
    });
  }

  // ==========================================================
  // USER
  // ==========================================================

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
      () => controller.abort(),
      GROQ_TIMEOUT_MS
    );

  try {

    const stream =
      await groq.chat.completions.create(
        {
          model:
            GROQ_MODEL,

          messages,

          temperature:
            0.2,

          max_tokens:
            150,

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

    let fullAnswer = "";

    let pending = "";

    for await (
      const chunk of
        stream
    ) {

      if (
        call.destroyed ||
        call.responseGeneration !==
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

      fullAnswer += token;

      pending += token;

      // ------------------------------------------------------
      // SENTENCES
      // ------------------------------------------------------

      let match;

      while (
        (
          match =
            pending.match(
              /^([\s\S]*?[.!?])(?:\s+|$)/
            )
        )
      ) {

        if (
          call.destroyed ||
          call.responseGeneration !==
            generation
        ) {
          break;
        }

        const sentence =
          match[1]
            .replace(/\s+/g, " ")
            .trim();

        pending =
          pending
            .slice(
              match[0].length
            )
            .trimStart();

        if (sentence) {

          await onText(
            sentence
          );
        }
      }

      // ------------------------------------------------------
      // EARLY CHUNK
      // ------------------------------------------------------

      if (
        pending.length >= 50
      ) {

        const lastSpace =
          pending.lastIndexOf(
            " "
          );

        if (
          lastSpace >= 25
        ) {

          const piece =
            pending
              .slice(
                0,
                lastSpace
              )
              .trim();

          pending =
            pending
              .slice(
                lastSpace + 1
              )
              .trimStart();

          if (piece) {

            await onText(
              piece
            );
          }
        }
      }
    }

    if (
      pending.trim() &&
      !call.destroyed &&
      call.responseGeneration ===
        generation
    ) {

      await onText(
        pending
          .replace(/\s+/g, " ")
          .trim()
      );
    }

    return fullAnswer
      .replace(/\s+/g, " ")
      .trim();

  } finally {

    clearTimeout(timeout);
  }
}

// ============================================================
// END-OF-CALL DETECTION
// ============================================================

function isEndingPhrase(text) {

  const q =
    text
      .toLowerCase()
      .replace(/[.!?,]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const endings = [

    "that's it",
    "thats it",
    "nothing else",
    "no that's all",
    "no thats all",
    "that's all",
    "thats all",
    "i'm done",
    "im done",
    "i am done",
    "bye",
    "goodbye",
    "that's everything",
    "thats everything"
  ];

  return endings.includes(q);
}

// ============================================================
// END CONFIRMATION
// ============================================================

function isConfirmation(text) {

  const q =
    text
      .toLowerCase()
      .replace(/[.!?,]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  return [
    "yes",
    "yeah",
    "yep",
    "yup",
    "please",
    "please do",
    "yes please",
    "end it",
    "you can",
    "go ahead"
  ].includes(q);
}

// ============================================================
// END CALL
// ============================================================

async function handleEndRequest(
  call
) {

  if (
    call.endConfirmationPending
  ) {
    return;
  }

  call.endConfirmationPending =
    true;

  const generation =
    ++call.responseGeneration;

  interruptAI(
    call,
    "end confirmation"
  );

  const text =
    "Sure. Would you like me to end the call?";

  sendTTS(
    call,
    text,
    generation
  );

  flushTTS(call);

  call.pendingHangupConfirmation =
    true;
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

  const clean =
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (!clean) {
    return;
  }

  console.log(
    `[${call.id}] QUESTION: ${clean}`
  );

  // ==========================================================
  // CONFIRM END
  // ==========================================================

  if (
    call.pendingHangupConfirmation
  ) {

    if (
      isConfirmation(clean)
    ) {

      console.log(
        `[${call.id}] CUSTOMER CONFIRMED END`
      );

      call.endConfirmed =
        true;

      // We invalidate current TTS.
      interruptAI(
        call,
        "confirmed call end"
      );

      /*
       * IMPORTANT:
       *
       * Closing the WebSocket is NOT guaranteed to terminate
       * the underlying Exotel call in every Exotel configuration.
       *
       * If your Exotel flow has a dedicated hangup API,
       * connect that API here.
       *
       * For now we close our media stream cleanly.
       */

      try {

        if (
          call.ws &&
          call.ws.readyState ===
            WebSocket.OPEN
        ) {

          call.ws.close();
        }

      } catch (_) {}

      return;
    }

    // Customer changed their mind.
    call.pendingHangupConfirmation =
      false;

    call.endConfirmationPending =
      false;
  }

  // ==========================================================
  // END PHRASE
  // ==========================================================

  if (
    isEndingPhrase(clean)
  ) {

    await handleEndRequest(
      call
    );

    return;
  }

  // ==========================================================
  // INTERRUPT OLD RESPONSE
  // ==========================================================

  if (
    call.aiSpeaking ||
    call.aiGenerating
  ) {

    interruptAI(
      call,
      "new customer question"
    );
  }

  // ==========================================================
  // GENERATION ID
  // ==========================================================

  const generation =
    ++call.responseGeneration;

  call.aiGenerating =
    true;

  call.aiSpeaking =
    false;

  const started =
    Date.now();

  try {

    // ========================================================
    // SEARCH
    // ========================================================

    let webInfo = "";

    if (
      needsWebSearch(clean)
    ) {

      console.log(
        `[${call.id}] LIVE SEARCH`
      );

      webInfo =
        await searchWeb(
          clean
        );

    }

    if (
      call.destroyed ||
      call.responseGeneration !==
        generation
    ) {
      return;
    }

    // ========================================================
    // TTS CALLBACK
    // ========================================================

    let sentSomething =
      false;

    const onText =
      async text => {

        if (
          call.destroyed ||
          call.responseGeneration !==
            generation
        ) {
          return;
        }

        const sent =
          sendTTS(
            call,
            text,
            generation
          );

        if (sent) {
          sentSomething = true;
        }
      };

    // ========================================================
    // GROQ
    // ========================================================

    const answer =
      await streamGroq(
        call,
        clean,
        webInfo,
        onText,
        generation
      );

    if (
      call.destroyed ||
      call.responseGeneration !==
        generation
    ) {
      return;
    }

    // ========================================================
    // FLUSH
    // ========================================================

    if (sentSomething) {

      flushTTS(call);

      waitForAudioDrain(
        call,
        generation
      );
    }

    // ========================================================
    // MEMORY
    // ========================================================

    if (answer) {

      call.memory.push({

        role:
          "user",

        content:
          clean
      });

      call.memory.push({

        role:
          "assistant",

        content:
          answer
      });

      // Keep last 6 exchanges.
      if (
        call.memory.length >
        12
      ) {

        call.memory =
          call.memory.slice(
            -12
          );
      }
    }

    console.log(
      `[${call.id}] AI: ${answer}`
    );

    console.log(
      `[${call.id}] RESPONSE TIME: ${
        Date.now() - started
      } ms`
    );

  } catch (error) {

    if (
      call.destroyed ||
      call.responseGeneration !==
        generation
    ) {
      return;
    }

    console.log(
      `[${call.id}] PROCESS ERROR:`,
      error.message
    );

    try {

      sendTTS(
        call,
        "Sorry, I had trouble with that. Could you say it again?",
        generation
      );

      flushTTS(call);

    } catch (_) {}

  } finally {

    if (
      call.responseGeneration ===
      generation
    ) {

      call.aiGenerating =
        false;
    }
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

  if (!clean) {
    return;
  }

  // Immediately interrupt current AI.
  if (
    call.aiSpeaking ||
    call.aiGenerating
  ) {

    interruptAI(
      call,
      "caller speaking"
    );
  }

  // Don't allow unlimited queued questions.
  call.questionQueue =
    [];

  call.questionQueue.push(
    clean
  );

  runQueue(call);
}

// ============================================================
// QUESTION QUEUE RUNNER
// ============================================================

async function runQueue(call) {

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
// CREATE CALL
// ============================================================

function createCall(ws) {

  const id =
    `CALL-${callCounter++}`;

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

    memory:
      [],

    questionQueue:
      [],

    queueRunning:
      false,

    speechParts:
      [],

    lastInterim:
      "",

    audioQueue:
      null,

    aiSpeaking:
      false,

    aiGenerating:
      false,

    responseGeneration:
      0,

    endConfirmationPending:
      false,

    pendingHangupConfirmation:
      false,

    greetingSent:
      false,

    startupAudio:
      [],

    startupAudioBytes:
      0,

    setupComplete:
      false
  };

  call.audioQueue =
    createAudioQueue(
      call
    );

  return call;
}

// ============================================================
// GREETING
// ============================================================

async function sendGreeting(call) {

  if (
    call.destroyed ||
    call.greetingSent
  ) {
    return;
  }

  if (
    !call.streamSid ||
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {

    return;
  }

  call.greetingSent =
    true;

  const generation =
    ++call.responseGeneration;

  call.aiSpeaking =
    true;

  console.log(
    `[${call.id}] 👋 GREETING`
  );

  sendTTS(
    call,
    "Hi, welcome to H&M. How can I help you today?",
    generation
  );

  flushTTS(call);
}

// ============================================================
// PROCESS STARTUP AUDIO
// ============================================================

function flushStartupAudio(call) {

  if (
    !call.sttSocket ||
    call.sttSocket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  if (
    call.startupAudio.length ===
    0
  ) {
    return;
  }

  console.log(
    `[${call.id}] sending buffered startup audio`
  );

  for (
    const audio of
      call.startupAudio
  ) {

    try {

      call.sttSocket.send(
        audio
      );

    } catch (error) {

      console.log(
        `[${call.id}] startup audio error:`,
        error.message
      );

      break;
    }
  }

  call.startupAudio =
    [];

  call.startupAudioBytes =
    0;
}

// ============================================================
// DEEPGRAM SETUP
// ============================================================

async function setupDeepgram(call) {

  try {

    const [
      stt,
      tts
    ] =
      await Promise.all([
        createDeepgramSTT(),
        createDeepgramTTS()
      ]);

    if (
      call.destroyed
    ) {

      closeSocket(stt);
      closeSocket(tts);

      return;
    }

    call.sttSocket =
      stt;

    call.ttsSocket =
      tts;

    call.sttReady =
      true;

    call.ttsReady =
      true;

    call.setupComplete =
      true;

    console.log(
      `[${call.id}] ✅ DEEPGRAM READY`
    );

    // ========================================================
    // STT
    // ========================================================

    stt.on(
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

          const transcript =
            message
              ?.channel
              ?.alternatives?.[0]
              ?.transcript || "";

          if (!transcript) {
            return;
          }

          // ==================================================
          // INTERIM
          // ==================================================

          if (
            !message.is_final
          ) {

            call.lastInterim =
              transcript;

            // =================================================
            // REAL BARGE-IN
            // =================================================

            if (
              call.aiSpeaking ||
              call.aiGenerating
            ) {

              const spoken =
                transcript
                  .trim();

              if (
                spoken.length >= 2
              ) {

                console.log(
                  `[${call.id}] 🎤 BARGE-IN: ${spoken}`
                );

                interruptAI(
                  call,
                  "caller speech detected"
                );
              }
            }

            return;
          }

          // ==================================================
          // FINAL
          // ==================================================

          call.speechParts.push(
            transcript
          );

          call.lastInterim =
            "";

          if (
            message.speech_final
          ) {

            const question =
              call.speechParts
                .join(" ")
                .replace(
                  /\s+/g,
                  " "
                )
                .trim();

            call.speechParts =
              [];

            if (question) {

              console.log(
                `[${call.id}] 🎤 FINAL: ${question}`
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
    // TTS
    // ========================================================

    tts.on(
      "message",
      (data, isBinary) => {

        if (
          call.destroyed
        ) {
          return;
        }

        try {

          // ==================================================
          // AUDIO
          // ==================================================

          if (
            isBinary ||
            Buffer.isBuffer(data)
          ) {

            const audio =
              Buffer.from(data);

            if (
              audio.length > 0 &&
              call.aiSpeaking
            ) {

              call.audioQueue.enqueue(
                audio
              );
            }

            return;
          }

          // ==================================================
          // JSON
          // ==================================================

          let message;

          try {

            message =
              JSON.parse(
                data.toString()
              );

          } catch (_) {

            return;
          }

          if (
            message.type ===
            "Flushed"
          ) {

            call.audioFlushTime =
              Date.now();
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
    // SOCKET EVENTS
    // ========================================================

    stt.on(
      "close",
      () => {

        call.sttReady =
          false;

        console.log(
          `[${call.id}] STT CLOSED`
        );
      }
    );

    tts.on(
      "close",
      () => {

        call.ttsReady =
          false;

        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    );

    stt.on(
      "error",
      error => {

        console.log(
          `[${call.id}] STT ERROR:`,
          error.message
        );
      }
    );

    tts.on(
      "error",
      error => {

        console.log(
          `[${call.id}] TTS ERROR:`,
          error.message
        );
      }
    );

    // ========================================================
    // SEND BUFFERED AUDIO
    // ========================================================

    flushStartupAudio(call);

    // ========================================================
    // GREETING
    // ========================================================

    await sendGreeting(call);

  } catch (error) {

    console.log(
      `[${call.id}] DEEPGRAM SETUP ERROR:`,
      error.message
    );

    call.sttReady =
      false;

    call.ttsReady =
      false;
  }
}

// ============================================================
// DESTROY CALL
// ============================================================

function destroyCall(call) {

  if (
    !call ||
    call.destroyed
  ) {
    return;
  }

  console.log(
    `[${call.id}] 🧹 CLEANING CALL`
  );

  call.destroyed =
    true;

  call.responseGeneration++;

  call.aiSpeaking =
    false;

  call.aiGenerating =
    false;

  call.questionQueue =
    [];

  call.speechParts =
    [];

  call.startupAudio =
    [];

  if (
    call.audioQueue
  ) {

    call.audioQueue.stop();
  }

  closeSocket(
    call.sttSocket
  );

  closeSocket(
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
    `[${call.id}] ACTIVE CALLS:`,
    activeCalls.size
  );
}

// ============================================================
// EXOTEL CONNECTION
// ============================================================

wss.on(
  "connection",
  ws => {

    const call =
      createCall(ws);

    activeCalls.set(
      call.id,
      call
    );

    console.log(
      "================================================"
    );

    console.log(
      `[${call.id}] 📞 EXOTEL CONNECTED`
    );

    console.log(
      `[${call.id}] ACTIVE CALLS:`,
      activeCalls.size
    );

    console.log(
      "================================================"
    );

    // ========================================================
    // START DEEPGRAM IMMEDIATELY
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
              `[${call.id}] Exotel stream connected`
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

            // If Deepgram already finished setup,
            // greet immediately.
            if (
              call.ttsReady &&
              !call.greetingSent
            ) {

              sendGreeting(
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

            const payload =
              message
                ?.media
                ?.payload;

            if (!payload) {
              return;
            }

            const audio =
              Buffer.from(
                payload,
                "base64"
              );

            // =================================================
            // STT READY
            // =================================================

            if (
              call.sttSocket &&
              call.sttSocket.readyState ===
                WebSocket.OPEN
            ) {

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

            // =================================================
            // STT NOT READY
            //
            // Buffer a small amount rather than dropping
            // the caller's first words.
            // =================================================

            if (
              call.startupAudioBytes <
              64000
            ) {

              call.startupAudio.push(
                audio
              );

              call.startupAudioBytes +=
                audio.length;
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

            call.speechParts =
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
              `[${call.id}] 📞 EXOTEL STOP`
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
    // CLOSE
    // ========================================================

    ws.on(
      "close",
      () => {

        console.log(
          `[${call.id}] 📞 EXOTEL DISCONNECTED`
        );

        destroyCall(
          call
        );
      }
    );

    // ========================================================
    // ERROR
    // ========================================================

    ws.on(
      "error",
      error => {

        console.log(
          `[${call.id}] EXOTEL ERROR:`,
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
      "================================================"
    );

    console.log(
      "        H&M AI VOICE ASSISTANT"
    );

    console.log(
      "================================================"
    );

    console.log(
      "Groq:",
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
      "Active calls:",
      activeCalls.size
    );

    console.log(
      "================================================"
    );
  }
);
