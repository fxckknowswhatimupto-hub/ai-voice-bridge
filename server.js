const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

const PORT = process.env.PORT || 10000;
const PUBLIC_URL = process.env.PUBLIC_URL || "https://ai-voice-bridge-q8qv.onrender.com";
const WS_URL = PUBLIC_URL.replace(/^https?:\/\//, "wss://");

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const DEEPGRAM_STT_MODEL = process.env.DEEPGRAM_STT_MODEL || "nova-3";
const DEEPGRAM_TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";

const SAMPLE_RATE = 8000;
const CHUNK_BYTES = 320;
const CHUNK_MS = 20;
const GROQ_TIMEOUT_MS = 10000;
const DEEPGRAM_CONNECT_TIMEOUT_MS = 7000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing");
if (!DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY is missing");

const groq = new Groq({ apiKey: GROQ_API_KEY });
const activeCalls = new Map();
let nextCallNumber = 1;

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/health") {
    return res.end(JSON.stringify({
      status: "ok",
      service: "h-and-m-ai-voice-assistant",
      model: GROQ_MODEL,
      activeCalls: activeCalls.size
    }));
  }

  res.end(JSON.stringify({
    status: "ok",
    websocket: WS_URL
  }));
});

const wss = new WebSocket.Server({ server });

function createDeepgramSocket(path, params) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();

    const socket = new WebSocket(
      `wss://api.deepgram.com/${path}?${query}`,
      {
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`
        }
      }
    );

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;

        try {
          socket.close();
        } catch {}

        reject(
          new Error(
            `Deepgram ${path} connection timeout`
          )
        );
      }
    }, DEEPGRAM_CONNECT_TIMEOUT_MS);

    socket.once("open", () => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      resolve(socket);
    });

    socket.once("error", err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function createSTT() {
  return createDeepgramSocket("v1/listen", {
    model: DEEPGRAM_STT_MODEL,
    language: "en-US",
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    interim_results: "true",
    punctuate: "true",
    endpointing: "180",
    smart_format: "true"
  });
}

function createTTS() {
  return createDeepgramSocket("v1/speak", {
    model: DEEPGRAM_TTS_MODEL,
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    container: "none",
    speed: "1.15"
  });
}

function closeSocket(socket) {
  if (!socket) return;

  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "Close"
        })
      );
    }
  } catch {}

  try {
    socket.close();
  } catch {}
}

function createAudioQueue(call) {
  const queue = [];

  let timer = null;
  let stopped = false;

  let sequence = 1;
  let chunk = 0;
  let timestamp = 0;

  function pump() {
    timer = null;

    if (
      stopped ||
      call.destroyed
    ) {
      return;
    }

    if (
      !call.ws ||
      call.ws.readyState !== WebSocket.OPEN ||
      !call.streamSid
    ) {
      return;
    }

    if (!queue.length) {
      return;
    }

    const audio = queue.shift();

    try {
      call.ws.send(
        JSON.stringify({
          event: "media",

          sequence_number:
            String(sequence++),

          stream_sid:
            call.streamSid,

          media: {
            chunk:
              String(chunk++),

            timestamp:
              String(timestamp),

            payload:
              audio.toString("base64")
          }
        })
      );

      timestamp += CHUNK_MS;

    } catch (e) {
      console.log(
        `[${call.id}] AUDIO SEND ERROR: ${e.message}`
      );

      return;
    }

    if (queue.length) {
      timer = setTimeout(
        pump,
        CHUNK_MS
      );
    }
  }

  return {
    enqueue(buffer) {
      if (
        stopped ||
        call.destroyed ||
        !buffer?.length
      ) {
        return;
      }

      for (
        let i = 0;
        i < buffer.length;
        i += CHUNK_BYTES
      ) {
        queue.push(
          buffer.subarray(
            i,
            Math.min(
              i + CHUNK_BYTES,
              buffer.length
            )
          )
        );
      }

      if (!timer) {
        pump();
      }
    },

    clear() {
      queue.length = 0;

      if (timer) {
        clearTimeout(timer);
      }

      timer = null;
    },

    stop() {
      stopped = true;
      this.clear();
    },

    pending() {
      return (
        queue.length > 0 ||
        !!timer
      );
    }
  };
}

// ============================================================
// PART 2 — FAKE H&M DATABASE + CUSTOMER DATA
// ============================================================

// ------------------------------------------------------------
// PRODUCT DATABASE
// ------------------------------------------------------------

const PRODUCTS = [

  {
    id: "HM-JEANS-001",
    name: "Bootcut Jeans",
    category: "jeans",
    gender: "women",
    price: 2499,
    currency: "INR",

    colors: [
      "blue",
      "dark blue",
      "light blue",
      "faded blue",
      "bluish green",
      "faded bluish green",
      "black"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "28",
      "30",
      "32",
      "34",
      "36"
    ],

    materials: [
      "cotton",
      "denim",
      "stretch denim",
      "cotton blend"
    ],

    description:
      "Bootcut jeans with a fitted upper leg and slightly flared hem.",

    stock: {
      "blue": ["28", "30", "32", "34"],
      "dark blue": ["28", "30", "32"],
      "light blue": ["28", "30", "32", "34", "36"],
      "faded blue": ["28", "30", "32"],
      "bluish green": ["30", "32"],
      "faded bluish green": ["28", "30", "32"],
      "black": ["28", "30", "32", "34"]
    }
  },

  {
    id: "HM-JEANS-002",
    name: "Slim Fit Jeans",
    category: "jeans",
    gender: "men",
    price: 1999,
    currency: "INR",

    colors: [
      "black",
      "dark blue",
      "blue",
      "light blue",
      "grey"
    ],

    sizes: [
      "28",
      "30",
      "32",
      "34",
      "36",
      "38"
    ],

    materials: [
      "denim",
      "cotton",
      "stretch denim"
    ],

    description:
      "Slim fit jeans with stretch denim and a tapered silhouette.",

    stock: {
      "black": ["30", "32", "34"],
      "dark blue": ["28", "30", "32", "34"],
      "blue": ["30", "32", "36"],
      "light blue": ["30", "32"],
      "grey": ["32", "34"]
    }
  },

  {
    id: "HM-TSHIRT-001",
    name: "Regular Fit Cotton T-Shirt",
    category: "t-shirts",
    gender: "unisex",
    price: 799,
    currency: "INR",

    colors: [
      "white",
      "black",
      "grey",
      "navy blue",
      "green",
      "red"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "XXL"
    ],

    materials: [
      "cotton",
      "organic cotton"
    ],

    description:
      "Regular-fit cotton T-shirt with a classic crew neck.",

    stock: {
      "white": ["S", "M", "L", "XL"],
      "black": ["XS", "S", "M", "L", "XL"],
      "grey": ["S", "M", "L"],
      "navy blue": ["M", "L", "XL"],
      "green": ["S", "M"],
      "red": ["M", "L"]
    }
  },

  {
    id: "HM-HOODIE-001",
    name: "Relaxed Fit Hoodie",
    category: "hoodies",
    gender: "unisex",
    price: 2299,
    currency: "INR",

    colors: [
      "black",
      "grey",
      "cream",
      "dark green",
      "navy blue"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "XXL"
    ],

    materials: [
      "cotton",
      "cotton blend",
      "fleece"
    ],

    description:
      "Soft relaxed-fit hoodie with a brushed interior.",

    stock: {
      "black": ["S", "M", "L", "XL"],
      "grey": ["M", "L", "XL"],
      "cream": ["S", "M"],
      "dark green": ["M", "L"],
      "navy blue": ["S", "M", "L"]
    }
  },

  {
    id: "HM-DRESS-001",
    name: "Fitted Midi Dress",
    category: "dresses",
    gender: "women",
    price: 2999,
    currency: "INR",

    colors: [
      "black",
      "red",
      "cream",
      "floral blue",
      "green"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L",
      "XL"
    ],

    materials: [
      "polyester",
      "cotton blend",
      "viscose"
    ],

    description:
      "Fitted midi dress with a clean silhouette and comfortable stretch.",

    stock: {
      "black": ["XS", "S", "M", "L"],
      "red": ["S", "M", "L"],
      "cream": ["XS", "S", "M"],
      "floral blue": ["S", "M"],
      "green": ["M", "L", "XL"]
    }
  },

  {
    id: "HM-JACKET-001",
    name: "Denim Jacket",
    category: "jackets",
    gender: "unisex",
    price: 3499,
    currency: "INR",

    colors: [
      "light blue",
      "dark blue",
      "black",
      "grey"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L",
      "XL"
    ],

    materials: [
      "denim",
      "cotton"
    ],

    description:
      "Classic denim jacket with a structured fit.",

    stock: {
      "light blue": ["S", "M", "L"],
      "dark blue": ["M", "L", "XL"],
      "black": ["XS", "S", "M"],
      "grey": ["M", "L"]
    }
  }

];

// ------------------------------------------------------------
// FAKE CUSTOMER DATABASE
// ------------------------------------------------------------

const CUSTOMERS = {

  "08667859535": {

    customerId: "CUST-1001",

    name: "Syed",

    phone: "08667859535",

    email: "syed@example.com",

    address: {
      line1: "12 Example Street",
      city: "Chennai",
      state: "Tamil Nadu",
      pincode: "600001"
    },

    preferences: {
      favoriteColors: [
        "blue",
        "black",
        "green"
      ],

      favoriteCategories: [
        "jeans",
        "t-shirts",
        "hoodies"
      ]
    },

    cart: [

      {
        productId: "HM-JEANS-001",
        productName: "Bootcut Jeans",
        color: "faded bluish green",
        size: "32",
        quantity: 1,
        price: 2499
      }

    ],

    orders: [

      {
        orderId: "HM10024581",

        status: "shipped",

        orderDate: "2026-08-05",

        estimatedDelivery:
          "2026-08-12",

        items: [

          {
            productId: "HM-TSHIRT-001",
            productName:
              "Regular Fit Cotton T-Shirt",
            color: "black",
            size: "L",
            quantity: 1,
            price: 799
          },

          {
            productId: "HM-JEANS-002",
            productName:
              "Slim Fit Jeans",
            color: "dark blue",
            size: "32",
            quantity: 1,
            price: 1999
          }

        ],

        total: 2798,

        payment:
          "Paid online",

        tracking: {
          courier:
            "H&M Logistics",

          trackingNumber:
            "HMTRK784512963",

          currentLocation:
            "Chennai Distribution Centre",

          lastUpdate:
            "2026-08-09 10:30",

          estimatedDelivery:
            "2026-08-12"
        }
      }

    ]
  }

};

// ------------------------------------------------------------
// DEFAULT CUSTOMER
// ------------------------------------------------------------

const DEFAULT_CUSTOMER = {

  customerId:
    "GUEST-0001",

  name:
    "Guest",

  phone:
    "",

  email:
    "",

  address: {
    line1: "",
    city: "",
    state: "",
    pincode: ""
  },

  preferences: {
    favoriteColors: [],
    favoriteCategories: []
  },

  cart: [],

  orders: []
};

// ============================================================
// CUSTOMER HELPERS
// ============================================================

function getCustomerByPhone(phone) {

  if (!phone) {
    return {
      ...DEFAULT_CUSTOMER
    };
  }

  const normalized =
    String(phone)
      .replace(/\D/g, "");

  if (
    CUSTOMERS[normalized]
  ) {

    return JSON.parse(
      JSON.stringify(
        CUSTOMERS[normalized]
      )
    );
  }

  return {
    ...DEFAULT_CUSTOMER,
    phone: normalized
  };
}

// ============================================================
// PRODUCT HELPERS
// ============================================================

function normalizeText(value) {

  return String(value || "")
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function productMatchesQuery(
  product,
  query
) {

  const q =
    normalizeText(query);

  const productText =
    normalizeText(
      [
        product.name,
        product.category,
        product.gender,
        product.description,
        ...(product.colors || []),
        ...(product.materials || []),
        ...(product.sizes || [])
      ].join(" ")
    );

  const words =
    q.split(" ")
      .filter(Boolean);

  if (
    words.length === 0
  ) {

    return false;
  }

  let matches = 0;

  for (
    const word of words
  ) {

    if (
      productText.includes(word)
    ) {

      matches++;
    }
  }

  return (
    matches >=
    Math.max(
      1,
      Math.ceil(
        words.length * 0.35
      )
    )
  );
}

// ============================================================
// FIND PRODUCTS
// ============================================================

function findProducts(
  query
) {

  const results =
    PRODUCTS.filter(
      product =>
        productMatchesQuery(
          product,
          query
        )
    );

  return results;
}

// ============================================================
// COLOR NORMALIZATION
// ============================================================

function normalizeColor(
  text
) {

  const q =
    normalizeText(text);

  const aliases = {

    "bluish green":
      "bluish green",

    "bluishgreen":
      "bluish green",

    "blue green":
      "bluish green",

    "blueish green":
      "bluish green",

    "faded bluish green":
      "faded bluish green",

    "faded blue green":
      "faded bluish green",

    "faded bluishgreen":
      "faded bluish green",

    "light blue":
      "light blue",

    "sky blue":
      "light blue",

    "dark blue":
      "dark blue",

    "navy":
      "navy blue",

    "navyblue":
      "navy blue",

    "off white":
      "cream",

    "offwhite":
      "cream"
  };

  if (
    aliases[q]
  ) {

    return aliases[q];
  }

  for (
    const product of PRODUCTS
  ) {

    for (
      const color of
        product.colors
    ) {

      if (
        normalizeText(color) ===
        q
      ) {

        return color;
      }
    }
  }

  return q;
}

// ============================================================
// SIZE NORMALIZATION
// ============================================================

function normalizeSize(
  text
) {

  const q =
    normalizeText(text)
      .toUpperCase();

  const aliases = {

    "EXTRA SMALL":
      "XS",

    "SMALL":
      "S",

    "MEDIUM":
      "M",

    "LARGE":
      "L",

    "EXTRA LARGE":
      "XL",

    "DOUBLE XL":
      "XXL"
  };

  return (
    aliases[q] ||
    q
  );
}

// ============================================================
// MATERIAL NORMALIZATION
// ============================================================

function normalizeMaterial(
  text
) {

  const q =
    normalizeText(text);

  const aliases = {

    "jean":
      "denim",

    "jeans":
      "denim",

    "cotton blend":
      "cotton blend",

    "stretchy denim":
      "stretch denim",

    "stretch denim":
      "stretch denim",

    "fleece":
      "fleece"
  };

  return (
    aliases[q] ||
    q
  );
}

// ============================================================
// CHECK PRODUCT AVAILABILITY
// ============================================================

function checkAvailability(
  product,
  color,
  size
) {

  if (
    !product
  ) {

    return {
      available: false,
      reason:
        "product_not_found"
    };
  }

  const normalizedColorValue =
    normalizeColor(
      color
    );

  const normalizedSizeValue =
    normalizeSize(
      size
    );

  if (
    color &&
    !product.colors.some(
      c =>
        normalizeText(c) ===
        normalizeText(
          normalizedColorValue
        )
    )
  ) {

    return {
      available: false,
      reason:
        "color_not_available"
    };
  }

  if (
    size &&
    !product.sizes.includes(
      normalizedSizeValue
    )
  ) {

    return {
      available: false,
      reason:
        "size_not_available"
    };
  }

  if (
    color &&
    size
  ) {

    const sizes =
      product.stock[
        normalizedColorValue
      ];

    if (
      !sizes ||
      !sizes.includes(
        normalizedSizeValue
      )
    ) {

      return {
        available: false,
        reason:
          "combination_not_available"
      };
    }
  }

  return {
    available: true
  };
}

// ============================================================
// SEARCH PRODUCTS WITH COLOR / SIZE / MATERIAL
// ============================================================

function searchProductsAdvanced(
  query
) {

  const q =
    normalizeText(query);

  const results =
    PRODUCTS.filter(
      product => {

        const productName =
          normalizeText(
            product.name
          );

        const category =
          normalizeText(
            product.category
          );

        const description =
          normalizeText(
            product.description
          );

        const colorMatch =
          product.colors.some(
            color =>
              q.includes(
                normalizeText(
                  color
                )
              )
          );

        const materialMatch =
          product.materials.some(
            material =>
              q.includes(
                normalizeText(
                  material
                )
              )
          );

        const nameMatch =
          q.includes(
            productName
          ) ||
          productName
            .split(" ")
            .some(
              word =>
                q.includes(word)
            );

        const categoryMatch =
          q.includes(
            category
          );

        const descriptionMatch =
          description
            .split(" ")
            .some(
              word =>
                word.length > 3 &&
                q.includes(word)
            );

        return (
          nameMatch ||
          categoryMatch ||
          colorMatch ||
          materialMatch ||
          descriptionMatch
        );
      }
    );

  return results;
}

// ============================================================
// FORMAT PRODUCT FOR AI
// ============================================================

function formatProduct(
  product
) {

  return {

    id:
      product.id,

    name:
      product.name,

    category:
      product.category,

    gender:
      product.gender,

    price:
      product.price,

    currency:
      product.currency,

    colors:
      product.colors,

    sizes:
      product.sizes,

    materials:
      product.materials,

    description:
      product.description
  };
}

// ============================================================
// GET ORDER
// ============================================================

function getOrder(
  customer,
  orderId
) {

  if (
    !customer ||
    !Array.isArray(
      customer.orders
    )
  ) {

    return null;
  }

  if (
    !orderId
  ) {

    return (
      customer.orders[
        0
      ] ||
      null
    );
  }

  const normalized =
    normalizeText(
      orderId
    );

  return (
    customer.orders.find(
      order =>
        normalizeText(
          order.orderId
        ) ===
        normalized
    ) ||
    null
  );
}

// ============================================================
// ORDER SUMMARY
// ============================================================

function formatOrderSummary(
  order
) {

  if (
    !order
  ) {

    return null;
  }

  return {

    orderId:
      order.orderId,

    status:
      order.status,

    orderDate:
      order.orderDate,

    estimatedDelivery:
      order.estimatedDelivery,

    total:
      order.total,

    payment:
      order.payment,

    items:
      order.items.map(
        item => ({
          name:
            item.productName,

          color:
            item.color,

          size:
            item.size,

          quantity:
            item.quantity,

          price:
            item.price
        })
      ),

    tracking:
      order.tracking
  };
}

// ============================================================
// CART SUMMARY
// ============================================================

function getCartSummary(
  customer
) {

  if (
    !customer ||
    !Array.isArray(
      customer.cart
    )
  ) {

    return {
      items: [],
      total: 0
    };
  }

  const items =
    customer.cart.map(
      item => {

        const quantity =
          Number(
            item.quantity || 1
          );

        return {
          ...item,
          quantity,
          subtotal:
            item.price *
            quantity
        };
      }
    );

  const total =
    items.reduce(
      (sum, item) =>
        sum +
        item.subtotal,
      0
    );

  return {
    items,
    total
  };
}

// ============================================================
// ADD TO CART
// ============================================================

function addToCart(
  customer,
  product,
  color,
  size,
  quantity = 1
) {

  if (
    !customer ||
    !product
  ) {

    return {
      success: false,
      message:
        "Product could not be added."
    };
  }

  const normalizedColorValue =
    color
      ? normalizeColor(color)
      : product.colors[0];

  const normalizedSizeValue =
    size
      ? normalizeSize(size)
      : product.sizes[0];

  const availability =
    checkAvailability(
      product,
      normalizedColorValue,
      normalizedSizeValue
    );

  if (
    !availability.available
  ) {

    return {
      success: false,
      message:
        "That exact product, colour and size combination is unavailable."
    };
  }

  const existing =
    customer.cart.find(
      item =>
        item.productId ===
          product.id &&
        normalizeText(
          item.color
        ) ===
          normalizeText(
            normalizedColorValue
          ) &&
        normalizeText(
          item.size
        ) ===
          normalizeText(
            normalizedSizeValue
          )
    );

  if (
    existing
  ) {

    existing.quantity =
      Number(
        existing.quantity || 0
      ) +
      Number(quantity || 1);

  } else {

    customer.cart.push({

      productId:
        product.id,

      productName:
        product.name,

      color:
        normalizedColorValue,

      size:
        normalizedSizeValue,

      quantity:
        Number(quantity || 1),

      price:
        product.price
    });
  }

  return {
    success: true,
    cart:
      getCartSummary(
        customer
      )
  };
}

// ============================================================
// H&M ASSISTANT — PRODUCT / SHOPPING LOGIC
// ============================================================

// ------------------------------------------------------------
// PRODUCT SEARCH
// ------------------------------------------------------------

function searchProducts(call, query) {
  const q = normalizeText(query);

  let products = fakeDatabase.products.filter((product) => {
    const searchable = [
      product.name,
      product.category,
      product.subcategory,
      product.description,
      ...(product.colors || []),
      ...(product.materials || []),
      ...(product.tags || [])
    ]
      .join(" ")
      .toLowerCase();

    return searchable.includes(q);
  });

  // Word-based matching if exact phrase failed.
  if (products.length === 0) {
    const words = q
      .split(/\s+/)
      .filter((word) => word.length >= 3);

    products = fakeDatabase.products.filter((product) => {
      const searchable = [
        product.name,
        product.category,
        product.subcategory,
        product.description,
        ...(product.colors || []),
        ...(product.materials || []),
        ...(product.tags || [])
      ]
        .join(" ")
        .toLowerCase();

      const matches = words.filter((word) =>
        searchable.includes(word)
      );

      return matches.length >= Math.max(1, Math.ceil(words.length * 0.4));
    });
  }

  return products.slice(0, 5);
}

// ------------------------------------------------------------
// SMART PRODUCT SEARCH
// ------------------------------------------------------------

function smartProductSearch(query) {
  const q = normalizeText(query);

  const colorAliases = {
    blue: ["blue", "navy", "denim", "light blue", "dark blue"],
    green: ["green", "olive", "khaki", "sage"],
    black: ["black"],
    white: ["white", "cream", "off white"],
    grey: ["grey", "gray", "charcoal"],
    brown: ["brown", "beige", "tan"],
    red: ["red", "burgundy"],
    pink: ["pink"],
    yellow: ["yellow"],
    orange: ["orange"],
    purple: ["purple", "lavender"]
  };

  const materialAliases = {
    cotton: ["cotton"],
    denim: ["denim"],
    linen: ["linen"],
    leather: ["leather"],
    wool: ["wool"],
    polyester: ["polyester"],
    viscose: ["viscose"],
    elastane: ["elastane", "stretch"]
  };

  const detectedColors = [];
  const detectedMaterials = [];

  for (const [canonical, aliases] of Object.entries(colorAliases)) {
    if (aliases.some((alias) => q.includes(alias))) {
      detectedColors.push(canonical);
    }
  }

  for (const [canonical, aliases] of Object.entries(materialAliases)) {
    if (aliases.some((alias) => q.includes(alias))) {
      detectedMaterials.push(canonical);
    }
  }

  const categoryWords = [
    "jeans",
    "shirt",
    "shirts",
    "tshirt",
    "t-shirt",
    "hoodie",
    "hoodies",
    "jacket",
    "jackets",
    "dress",
    "dresses",
    "trousers",
    "pants",
    "shorts",
    "skirt",
    "skirts",
    "sweater",
    "sweaters",
    "coat",
    "coats",
    "shoes",
    "sneakers",
    "boots"
  ];

  const detectedCategories = categoryWords.filter((word) =>
    q.includes(word)
  );

  let results = fakeDatabase.products;

  if (detectedCategories.length > 0) {
    results = results.filter((product) => {
      const text = [
        product.category,
        product.subcategory,
        product.name,
        ...(product.tags || [])
      ]
        .join(" ")
        .toLowerCase();

      return detectedCategories.some((category) =>
        text.includes(category)
      );
    });
  }

  if (detectedColors.length > 0) {
    results = results.filter((product) => {
      const productColors = (product.colors || []).map((color) =>
        color.toLowerCase()
      );

      return detectedColors.some((color) =>
        productColors.some(
          (productColor) =>
            productColor.includes(color) ||
            color.includes(productColor)
        )
      );
    });
  }

  if (detectedMaterials.length > 0) {
    results = results.filter((product) => {
      const materials = (product.materials || []).map((material) =>
        material.toLowerCase()
      );

      return detectedMaterials.some((material) =>
        materials.some(
          (productMaterial) =>
            productMaterial.includes(material) ||
            material.includes(productMaterial)
        )
      );
    });
  }

  // If filtering became too strict, fall back to normal search.
  if (results.length === 0) {
    results = searchProducts(null, q);
  }

  return {
    products: results.slice(0, 5),
    detectedColors,
    detectedMaterials,
    detectedCategories
  };
}

// ------------------------------------------------------------
// FIND PRODUCT BY ID
// ------------------------------------------------------------

function findProduct(productId) {
  return fakeDatabase.products.find(
    (product) =>
      String(product.id).toLowerCase() ===
      String(productId).toLowerCase()
  );
}

// ------------------------------------------------------------
// FIND PRODUCT BY NAME
// ------------------------------------------------------------

function findProductByName(name) {
  const q = normalizeText(name);

  let product = fakeDatabase.products.find(
    (item) =>
      normalizeText(item.name) === q
  );

  if (product) {
    return product;
  }

  product = fakeDatabase.products.find((item) =>
    normalizeText(item.name).includes(q)
  );

  if (product) {
    return product;
  }

  return fakeDatabase.products.find((item) => {
    const words = q.split(/\s+/).filter(Boolean);

    const productText = normalizeText(
      [
        item.name,
        item.category,
        item.subcategory,
        ...(item.tags || [])
      ].join(" ")
    );

    return words.some(
      (word) =>
        word.length >= 3 &&
        productText.includes(word)
    );
  });
}

// ------------------------------------------------------------
// SIZE DETECTION
// ------------------------------------------------------------

function detectSize(text) {
  const q = normalizeText(text);

  const patterns = [
    /\bxxxs\b/i,
    /\bxxs\b/i,
    /\bxs\b/i,
    /\bs\b/i,
    /\bm\b/i,
    /\bl\b/i,
    /\bxl\b/i,
    /\bxxl\b/i,
    /\bxxxl\b/i,
    /\b\d{2}\b/i
  ];

  for (const pattern of patterns) {
    const match = q.match(pattern);

    if (match) {
      return match[0].toUpperCase();
    }
  }

  return null;
}

// ------------------------------------------------------------
// COLOR DETECTION
// ------------------------------------------------------------

function detectColor(text) {
  const q = normalizeText(text);

  const colors = [
    "black",
    "white",
    "blue",
    "navy",
    "green",
    "olive",
    "sage",
    "grey",
    "gray",
    "charcoal",
    "brown",
    "beige",
    "tan",
    "red",
    "burgundy",
    "pink",
    "yellow",
    "orange",
    "purple",
    "lavender",
    "cream",
    "off white",
    "light blue",
    "dark blue",
    "faded blue",
    "faded bluish green",
    "bluish green"
  ];

  for (const color of colors) {
    if (q.includes(color)) {
      return color;
    }
  }

  return null;
}

// ------------------------------------------------------------
// MATERIAL DETECTION
// ------------------------------------------------------------

function detectMaterial(text) {
  const q = normalizeText(text);

  const materials = [
    "cotton",
    "denim",
    "linen",
    "leather",
    "wool",
    "polyester",
    "viscose",
    "elastane",
    "stretch"
  ];

  for (const material of materials) {
    if (q.includes(material)) {
      return material;
    }
  }

  return null;
}

// ------------------------------------------------------------
// PRODUCT AVAILABILITY
// ------------------------------------------------------------

function checkProductAvailability(
  product,
  size,
  color
) {
  if (!product) {
    return {
      available: false,
      reason: "product_not_found"
    };
  }

  if (
    color &&
    product.colors &&
    !product.colors.some((item) =>
      normalizeText(item).includes(
        normalizeText(color)
      )
    )
  ) {
    return {
      available: false,
      reason: "color_unavailable"
    };
  }

  if (
    size &&
    product.sizes &&
    !product.sizes.some(
      (item) =>
        normalizeText(item) ===
        normalizeText(size)
    )
  ) {
    return {
      available: false,
      reason: "size_unavailable"
    };
  }

  return {
    available: true,
    reason: null
  };
}

// ------------------------------------------------------------
// FORMAT PRODUCT FOR AI
// ------------------------------------------------------------

function formatProduct(product) {
  if (!product) {
    return "";
  }

  return [
    `Product: ${product.name}`,
    `Category: ${product.category}`,
    `Description: ${product.description}`,
    `Price: ${product.price}`,
    `Colors: ${(product.colors || []).join(", ")}`,
    `Materials: ${(product.materials || []).join(", ")}`,
    `Sizes: ${(product.sizes || []).join(", ")}`,
    `Stock: ${product.stock}`
  ].join("\n");
}

// ------------------------------------------------------------
// FORMAT MULTIPLE PRODUCTS
// ------------------------------------------------------------

function formatProducts(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return "No matching products found.";
  }

  return products
    .map((product, index) => {
      return (
        `${index + 1}. ` +
        formatProduct(product)
      );
    })
    .join("\n\n");
}

// ============================================================
// CART FUNCTIONS
// ============================================================

// ------------------------------------------------------------
// GET CART
// ------------------------------------------------------------

function getCart(call) {
  if (!call.customer) {
    return [];
  }

  if (!Array.isArray(call.customer.cart)) {
    call.customer.cart = [];
  }

  return call.customer.cart;
}

// ------------------------------------------------------------
// CART TOTAL
// ------------------------------------------------------------

function getCartTotal(call) {
  return getCart(call).reduce(
    (total, item) =>
      total +
      Number(item.price || 0) *
        Number(item.quantity || 1),
    0
  );
}

// ------------------------------------------------------------
// ADD TO CART
// ------------------------------------------------------------

function addToCart(
  call,
  product,
  size,
  color,
  quantity = 1
) {
  if (!product) {
    return {
      success: false,
      message: "Product not found."
    };
  }

  const availability =
    checkProductAvailability(
      product,
      size,
      color
    );

  if (!availability.available) {
    return {
      success: false,
      message:
        availability.reason ===
        "size_unavailable"
          ? `That product is not available in size ${size}.`
          : availability.reason ===
            "color_unavailable"
          ? `That product is not available in ${color}.`
          : "That product is not available."
    };
  }

  const cart = getCart(call);

  const existing =
    cart.find(
      (item) =>
        item.productId === product.id &&
        normalizeText(item.size) ===
          normalizeText(size || "") &&
        normalizeText(item.color) ===
          normalizeText(color || "")
    );

  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      size: size || null,
      color: color || null,
      quantity
    });
  }

  return {
    success: true,
    message: `${product.name} has been added to your cart.`,
    cart
  };
}

// ------------------------------------------------------------
// REMOVE FROM CART
// ------------------------------------------------------------

function removeFromCart(
  call,
  productName
) {
  const cart = getCart(call);

  const index =
    cart.findIndex(
      (item) =>
        normalizeText(item.name).includes(
          normalizeText(productName)
        )
    );

  if (index === -1) {
    return {
      success: false,
      message:
        "I couldn't find that product in your cart."
    };
  }

  const removed =
    cart.splice(index, 1)[0];

  return {
    success: true,
    message:
      `${removed.name} has been removed from your cart.`,
    cart
  };
}

// ------------------------------------------------------------
// CLEAR CART
// ------------------------------------------------------------

function clearCart(call) {
  call.customer.cart = [];

  return {
    success: true,
    message: "Your cart has been cleared."
  };
}

// ------------------------------------------------------------
// CHANGE CART ITEM
// ------------------------------------------------------------

function updateCartItem(
  call,
  productName,
  changes
) {
  const cart = getCart(call);

  const item =
    cart.find(
      (cartItem) =>
        normalizeText(cartItem.name).includes(
          normalizeText(productName)
        )
    );

  if (!item) {
    return {
      success: false,
      message:
        "I couldn't find that item in your cart."
    };
  }

  if (changes.size) {
    item.size = changes.size;
  }

  if (changes.color) {
    item.color = changes.color;
  }

  if (changes.quantity) {
    item.quantity =
      Math.max(
        1,
        Number(changes.quantity)
      );
  }

  return {
    success: true,
    message:
      `${item.name} has been updated.`,
    item
  };
}

// ------------------------------------------------------------
// CART SUMMARY
// ------------------------------------------------------------

function getCartSummary(call) {
  const cart = getCart(call);

  if (cart.length === 0) {
    return "Your cart is currently empty.";
  }

  const items = cart
    .map((item, index) => {
      const options = [];

      if (item.size) {
        options.push(`size ${item.size}`);
      }

      if (item.color) {
        options.push(item.color);
      }

      return (
        `${index + 1}. ${item.name}, ` +
        `${options.length ? options.join(", ") + ", " : ""}` +
        `quantity ${item.quantity}, ` +
        `price ${item.price}`
      );
    })
    .join(". ");

  return (
    `${items}. ` +
    `Your cart total is ${getCartTotal(call).toFixed(2)}.`
  );
}

// ============================================================
// ORDER FUNCTIONS
// ============================================================

// ------------------------------------------------------------
// FIND ORDER
// ------------------------------------------------------------

function findOrder(call, orderNumber) {
  if (!call.customer) {
    return null;
  }

  const orders =
    call.customer.orders || [];

  if (!orderNumber) {
    return orders[0] || null;
  }

  return orders.find(
    (order) =>
      normalizeText(order.orderNumber) ===
      normalizeText(orderNumber)
  );
}

// ------------------------------------------------------------
// GET LATEST ORDER
// ------------------------------------------------------------

function getLatestOrder(call) {
  if (
    !call.customer ||
    !Array.isArray(call.customer.orders)
  ) {
    return null;
  }

  return call.customer.orders[0] || null;
}

// ------------------------------------------------------------
// ORDER SUMMARY
// ------------------------------------------------------------

function formatOrder(order) {
  if (!order) {
    return "I couldn't find an order for you.";
  }

  const items =
    (order.items || [])
      .map(
        (item) =>
          `${item.name}, size ${item.size}, ` +
          `${item.color}, quantity ${item.quantity}`
      )
      .join("; ");

  return [
    `Order number ${order.orderNumber}`,
    `Items: ${items}`,
    `Total: ${order.total}`,
    `Status: ${order.status}`,
    `Estimated delivery: ${order.estimatedDelivery}`,
    `Tracking number: ${order.trackingNumber || "not available"}`
  ].join(". ");
}

// ------------------------------------------------------------
// TRACK ORDER
// ------------------------------------------------------------

function trackOrder(call, orderNumber) {
  const order =
    findOrder(
      call,
      orderNumber
    );

  if (!order) {
    return {
      success: false,
      message:
        "I couldn't find that order."
    };
  }

  return {
    success: true,
    order,
    message:
      `Your order ${order.orderNumber} is currently ${order.status}. ` +
      `The estimated delivery is ${order.estimatedDelivery}.`
  };
}

// ============================================================
// CUSTOMER FUNCTIONS
// ============================================================

// ------------------------------------------------------------
// CUSTOMER PROFILE
// ------------------------------------------------------------

function getCustomerProfile(call) {
  if (!call.customer) {
    return null;
  }

  return {
    name: call.customer.name,
    phone: call.customer.phone,
    email: call.customer.email,
    loyaltyPoints:
      call.customer.loyaltyPoints || 0
  };
}

// ------------------------------------------------------------
// ADDRESS
// ------------------------------------------------------------

function getCustomerAddress(call) {
  if (
    !call.customer ||
    !call.customer.address
  ) {
    return null;
  }

  return call.customer.address;
}

// ------------------------------------------------------------
// LOYALTY
// ------------------------------------------------------------

function getLoyaltyStatus(call) {
  if (!call.customer) {
    return {
      success: false,
      message:
        "I couldn't access your loyalty information."
    };
  }

  return {
    success: true,
    points:
      call.customer.loyaltyPoints || 0,
    message:
      `You currently have ` +
      `${call.customer.loyaltyPoints || 0} ` +
      `loyalty points.`
  };
}

// ============================================================
// DELIVERY / SHIPPING
// ============================================================

// ------------------------------------------------------------
// DELIVERY ESTIMATE
// ------------------------------------------------------------

function getDeliveryEstimate(call) {
  const order =
    getLatestOrder(call);

  if (!order) {
    return {
      success: false,
      message:
        "I couldn't find a recent order to check."
    };
  }

  return {
    success: true,
    message:
      `Your estimated delivery date is ` +
      `${order.estimatedDelivery}.`
  };
}

// ------------------------------------------------------------
// TRACKING DETAILS
// ------------------------------------------------------------

function getTrackingDetails(call, orderNumber) {
  const result =
    trackOrder(
      call,
      orderNumber
    );

  if (!result.success) {
    return result;
  }

  const order =
    result.order;

  return {
    success: true,
    message:
      `The tracking number for order ` +
      `${order.orderNumber} is ` +
      `${order.trackingNumber}. ` +
      `The current status is ${order.status}.`
  };
}

// ============================================================
// HUMAN CONVERSATION HELPERS
// ============================================================

// ------------------------------------------------------------
// DETECT CUSTOMER INTENT
// ------------------------------------------------------------

function detectIntent(text) {
  const q =
    normalizeText(text);

  if (
    /\b(add|put|place).*(cart)\b/i.test(q) ||
    /\b(add this|add that)\b/i.test(q)
  ) {
    return "add_to_cart";
  }

  if (
    /\b(remove|delete).*(cart)\b/i.test(q)
  ) {
    return "remove_from_cart";
  }

  if (
    /\b(clear|empty).*(cart)\b/i.test(q)
  ) {
    return "clear_cart";
  }

  if (
    /\b(cart|basket)\b/i.test(q) &&
    /\b(what|show|tell|see|items|inside|have)\b/i.test(q)
  ) {
    return "cart";
  }

  if (
    /\b(track|tracking|where is|where's).*(order|package|parcel)\b/i.test(q)
  ) {
    return "tracking";
  }

  if (
    /\b(order|orders)\b/i.test(q) &&
    /\b(status|details|information|history)\b/i.test(q)
  ) {
    return "order_details";
  }

  if (
    /\b(delivery|deliver|arrive|arrival|shipping)\b/i.test(q)
  ) {
    return "delivery";
  }

  if (
    /\b(points|loyalty|membership|members)\b/i.test(q)
  ) {
    return "loyalty";
  }

  if (
    /\b(product|products|jeans|shirt|dress|hoodie|jacket|shoes|boots|trousers|pants|skirt)\b/i.test(q)
  ) {
    return "product_search";
  }

  if (
    /\b(size|sizing|fit|fits|small|medium|large|xl|xxl)\b/i.test(q)
  ) {
    return "size_help";
  }

  if (
    /\b(return|refund|exchange)\b/i.test(q)
  ) {
    return "return";
  }

  if (
    /\b(cancel).*(order)\b/i.test(q)
  ) {
    return "cancel_order";
  }

  return "general";
}

// ------------------------------------------------------------
// CUSTOMER END-OF-CALL DETECTION
// ------------------------------------------------------------

function isEndCallRequest(text) {
  const q =
    normalizeText(text);

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
    "bye",
    "goodbye",
    "that's everything",
    "thats everything"
  ];

  return endings.some(
    (phrase) =>
      q === phrase ||
      q.startsWith(`${phrase} `) ||
      q.endsWith(` ${phrase}`)
  );
}

// ------------------------------------------------------------
// INTERRUPTION DETECTION
// ------------------------------------------------------------

function isInterruptCommand(text) {
  const q =
    normalizeText(text);

  return /^(stop|wait|hold on|hang on|pause|be quiet|that's enough|thats enough|enough)$/i.test(
    q
  );
}

// ------------------------------------------------------------
// SHORT HUMAN ACKNOWLEDGEMENT
// ------------------------------------------------------------

function isAcknowledgement(text) {
  const q =
    normalizeText(text);

  return [
    "okay",
    "ok",
    "alright",
    "great",
    "cool",
    "thanks",
    "thank you",
    "got it"
  ].includes(q);
}

// ============================================================
// AI CONTEXT BUILDER
// ============================================================

function buildBusinessContext(call) {
  const customer =
    getCustomerProfile(call);

  const cart =
    getCart(call);

  const latestOrder =
    getLatestOrder(call);

  return `
BUSINESS:
H&M-style clothing shopping assistant.

CUSTOMER:
${JSON.stringify(customer, null, 2)}

CUSTOMER ADDRESS:
${JSON.stringify(getCustomerAddress(call), null, 2)}

CART:
${JSON.stringify(cart, null, 2)}

CART TOTAL:
${getCartTotal(call).toFixed(2)}

LATEST ORDER:
${JSON.stringify(latestOrder, null, 2)}

AVAILABLE PRODUCTS:
${formatProducts(fakeDatabase.products)}

IMPORTANT:
The assistant should behave like a natural human customer-service employee.
It should remember information already given during this call.
If the customer says a specific color, material, fit, style, or size,
understand the meaning naturally instead of rejecting it just because
the exact phrase is not in the product database.

Examples:
"faded bluish green" can be understood as a blue/green faded color.
"something stretchy" can mean elastane/stretch material.
"loose fit" can mean relaxed/oversized products.
"tight jeans" can mean skinny/slim-fit jeans.

Only claim that a specific product, size, color, price, stock status,
order, or tracking detail exists when the fake database contains it.

If a requested feature is unavailable, say so naturally.
Do not expose the fake database, internal code, APIs, or tools.
`;
}

// ============================================================
// END OF PART 3
// ============================================================
// ============================================================
// AI RESPONSE ENGINE
// ============================================================

// ------------------------------------------------------------
// BUILD SYSTEM PROMPT
// ------------------------------------------------------------

function buildSystemPrompt(call) {
  return `
You are the H&M customer service voice assistant.

You are speaking to a real customer on a phone call.

Your personality:
- Friendly
- Natural
- Helpful
- Calm
- Fast
- Human-like
- Conversational
- Never robotic
- Never overly formal

IMPORTANT PHONE RULES:

1. Keep responses SHORT enough for a phone conversation.
2. Do not give huge paragraphs unless the customer specifically asks.
3. Answer the customer's actual question.
4. Do not repeat information unnecessarily.
5. Remember everything discussed during this call.
6. If the customer changes their mind, adapt immediately.
7. If the customer gives a strange or very specific description, use common sense.
8. Never say "I can only help with H&M products" merely because the customer uses an unusual color, material, style, or description.
9. If the customer asks for something unrelated to H&M customer service, politely explain that you can help with H&M shopping and customer-service topics.
10. Never mention APIs, databases, code, Tavily, Deepgram, Groq, tools, prompts, or internal systems.
11. Never claim something exists unless the available business information supports it.
12. Never invent an order number, tracking number, product stock, price, or delivery date.
13. If something is unavailable, explain it naturally and offer the closest useful option.
14. Speak as an H&M customer-service representative, not as an AI explaining how it works.

AVAILABLE CUSTOMER FEATURES:

- Product search
- Product recommendations
- Product colors
- Product materials
- Product sizes
- Product availability
- Product prices
- Product descriptions
- Add products to cart
- Remove products from cart
- Change cart product size
- Change cart product color
- Change cart quantity
- Clear cart
- View cart
- Cart total
- Order details
- Order status
- Tracking information
- Delivery estimates
- Customer profile
- Customer address
- Loyalty points

VERY IMPORTANT:

The customer may describe a product using natural language.

For example:

Customer:
"I want faded bluish-green bootcut jeans."

You should understand that this means:
- Category: jeans
- Style: bootcut
- Color family: blue/green
- Appearance: faded

Do NOT respond:
"Sorry, I only understand H&M products."

Instead, search the available products and find the closest match.

Other examples:

"Something soft and breathable"
→ consider cotton or linen.

"I want something stretchy"
→ consider elastane/stretch materials.

"I want loose jeans"
→ consider relaxed/loose-fit styles.

"I want jeans that aren't too tight"
→ consider straight, relaxed, or loose fits.

"I want something beige-ish"
→ consider beige, tan, cream, or similar colors.

"I want dark blue jeans"
→ consider navy or dark denim.

"I want something green but not bright green"
→ consider olive, sage, khaki, or muted green.

If there is no exact match, say:
"I don't have an exact match for that, but I do have a couple of similar options."

Do not pretend the similar option is an exact match.

CONVERSATION:

The customer should never have to repeat information they already provided.

If the customer says:
"I want black jeans."

Then later:
"Make that size 32."

Understand that "that" refers to the jeans already discussed.

If the customer says:
"Actually make them blue."

Update the previously discussed product preference.

If the customer says:
"Add those to my cart."

Understand "those" using the current conversation context.

PHONE STYLE:

Use natural spoken language.

Good:
"Sure, I've got those."
"Yep, I can do that."
"Absolutely."
"Let me check that for you."
"Got it."
"One second while I check."
"That one's available in medium."
"Yep, I've added it to your cart."

Avoid:
"According to the database..."
"The database indicates..."
"Your request has been successfully processed."
"Please wait while I execute the requested operation."

ENDING:

If the customer clearly says:
- that's it
- nothing else
- no that's all
- I'm done
- bye
- goodbye
- that's everything

The call may be ended after a brief confirmation.

Do NOT immediately hang up if the customer's statement is ambiguous.

`;
}

// ------------------------------------------------------------
// ASK GROQ — FAST NON-STREAMING HELPER
// ------------------------------------------------------------

async function askGroq(
  call,
  question,
  extraContext = ""
) {
  if (
    call.destroyed
  ) {
    return "";
  }

  const messages = [
    {
      role: "system",
      content:
        buildSystemPrompt(call) +
        "\n\n" +
        buildBusinessContext(call)
    }
  ];

  // Conversation memory
  for (
    const item of call.conversationHistory
  ) {
    messages.push({
      role: item.role,
      content: item.content
    });
  }

  if (extraContext) {
    messages.push({
      role: "system",
      content: extraContext
    });
  }

  messages.push({
    role: "user",
    content: question
  });

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, GROQ_TIMEOUT_MS);

  try {
    const response =
      await groq.chat.completions.create(
        {
          model: GROQ_MODEL,

          messages,

          temperature: 0.25,

          max_tokens: 120,

          top_p: 0.9,

          stream: false
        },
        {
          signal: controller.signal
        }
      );

    const answer =
      response
        ?.choices?.[0]
        ?.message
        ?.content || "";

    return answer
      .replace(/\s+/g, " ")
      .trim();

  } catch (error) {
    if (
      error.name === "AbortError"
    ) {
      console.log(
        `[${call.id}] GROQ TIMEOUT`
      );
    } else {
      console.log(
        `[${call.id}] GROQ ERROR:`,
        error.message
      );
    }

    return "";

  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// FAST LOCAL RESPONSE LOGIC
// ============================================================

// These responses avoid an LLM request entirely for common
// customer-service operations. This makes the phone assistant
// significantly faster.

async function handleLocalIntent(
  call,
  question
) {
  const q =
    normalizeText(question);

  // ----------------------------------------------------------
  // CART
  // ----------------------------------------------------------

  if (
    detectIntent(question) === "cart"
  ) {
    return {
      handled: true,
      response:
        getCartSummary(call)
    };
  }

  // ----------------------------------------------------------
  // CLEAR CART
  // ----------------------------------------------------------

  if (
    detectIntent(question) === "clear_cart"
  ) {
    const result =
      clearCart(call);

    return {
      handled: true,
      response:
        "Sure, I've cleared your cart."
    };
  }

  // ----------------------------------------------------------
  // LOYALTY
  // ----------------------------------------------------------

  if (
    detectIntent(question) === "loyalty"
  ) {
    const result =
      getLoyaltyStatus(call);

    return {
      handled: true,
      response:
        result.message
    };
  }

  // ----------------------------------------------------------
  // TRACKING
  // ----------------------------------------------------------

  if (
    detectIntent(question) === "tracking"
  ) {
    const order =
      getLatestOrder(call);

    if (!order) {
      return {
        handled: true,
        response:
          "I couldn't find a recent order on your account."
      };
    }

    return {
      handled: true,
      response:
        `Your latest order is currently ${order.status}. ` +
        `It's estimated to arrive by ${order.estimatedDelivery}.`
    };
  }

  // ----------------------------------------------------------
  // DELIVERY
  // ----------------------------------------------------------

  if (
    detectIntent(question) === "delivery"
  ) {
    const result =
      getDeliveryEstimate(call);

    return {
      handled: true,
      response:
        result.message
    };
  }

  // ----------------------------------------------------------
  // ORDER DETAILS
  // ----------------------------------------------------------

  if (
    detectIntent(question) === "order_details"
  ) {
    const order =
      getLatestOrder(call);

    return {
      handled: true,
      response:
        formatOrder(order)
    };
  }

  // ----------------------------------------------------------
  // REMOVE PRODUCT
  // ----------------------------------------------------------

  if (
    detectIntent(question) === "remove_from_cart"
  ) {
    const productName =
      extractProductNameFromRemoval(
        question
      );

    if (!productName) {
      return {
        handled: true,
        response:
          "Sure. Which item would you like me to remove?"
      };
    }

    const result =
      removeFromCart(
        call,
        productName
      );

    return {
      handled: true,
      response:
        result.message
    };
  }

  return {
    handled: false,
    response: ""
  };
}

// ------------------------------------------------------------
// EXTRACT PRODUCT FROM REMOVE REQUEST
// ------------------------------------------------------------

function extractProductNameFromRemoval(
  text
) {
  const q =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  const patterns = [
    /remove (.+?) from (?:my )?cart/i,
    /delete (.+?) from (?:my )?cart/i,
    /take (.+?) out of (?:my )?cart/i,
    /remove (.+)$/i
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      q.match(pattern);

    if (
      match &&
      match[1]
    ) {
      return match[1]
        .replace(
          /\b(the|item|product)\b/gi,
          ""
        )
        .trim();
    }
  }

  return null;
}

// ============================================================
// PRODUCT CONVERSATION STATE
// ============================================================

function updateConversationProductState(
  call,
  question
) {
  if (!call.productContext) {
    call.productContext = {
      product: null,
      category: null,
      color: null,
      material: null,
      size: null,
      quantity: 1
    };
  }

  const color =
    detectColor(question);

  const material =
    detectMaterial(question);

  const size =
    detectSize(question);

  if (color) {
    call.productContext.color =
      color;
  }

  if (material) {
    call.productContext.material =
      material;
  }

  if (size) {
    call.productContext.size =
      size;
  }

  const smartSearch =
    smartProductSearch(question);

  if (
    smartSearch.products.length > 0
  ) {
    call.productContext.product =
      smartSearch.products[0];
  }

  return call.productContext;
}

// ============================================================
// PRODUCT RESPONSE
// ============================================================

async function handleProductQuestion(
  call,
  question
) {
  const context =
    updateConversationProductState(
      call,
      question
    );

  const result =
    smartProductSearch(question);

  // ----------------------------------------------------------
  // FOLLOW-UP ABOUT EXISTING PRODUCT
  // ----------------------------------------------------------

  if (
    context.product &&
    (
      detectSize(question) ||
      detectColor(question) ||
      detectMaterial(question)
    )
  ) {
    const product =
      context.product;

    const availability =
      checkProductAvailability(
        product,
        context.size,
        context.color
      );

    if (
      availability.available
    ) {
      return {
        handled: true,
        response:
          `${product.name} is available` +
          `${context.size ? ` in size ${context.size}` : ""}` +
          `${context.color ? ` in ${context.color}` : ""}.`
      };
    }
  }

  // ----------------------------------------------------------
  // NO RESULTS
  // ----------------------------------------------------------

  if (
    result.products.length === 0
  ) {
    return {
      handled: false,
      response: ""
    };
  }

  // ----------------------------------------------------------
  // SINGLE STRONG MATCH
  // ----------------------------------------------------------

  if (
    result.products.length === 1
  ) {
    const product =
      result.products[0];

    call.productContext.product =
      product;

    return {
      handled: true,
      response:
        `${product.name} is available for ${product.price}. ` +
        `It's available in ` +
        `${(product.colors || []).slice(0, 4).join(", ")}. ` +
        `Would you like me to add it to your cart?`
    };
  }

  // ----------------------------------------------------------
  // MULTIPLE RESULTS
  // ----------------------------------------------------------

  const shortResults =
    result.products
      .slice(0, 3)
      .map(
        (product, index) =>
          `${index + 1}, ${product.name} for ${product.price}`
      )
      .join(". ");

  return {
    handled: true,
    response:
      `I found a few options. ${shortResults}. ` +
      `Which one would you like?`
  };
}

// ============================================================
// ADD-TO-CART HANDLER
// ============================================================

async function handleAddToCart(
  call,
  question
) {
  const context =
    updateConversationProductState(
      call,
      question
    );

  let product =
    context.product;

  if (!product) {
    const search =
      smartProductSearch(question);

    product =
      search.products[0];
  }

  if (!product) {
    return {
      handled: true,
      response:
        "Sure. Which product would you like me to add?"
    };
  }

  const size =
    context.size ||
    detectSize(question);

  const color =
    context.color ||
    detectColor(question);

  if (!size) {
    return {
      handled: true,
      response:
        `Sure. What size would you like for the ${product.name}?`
    };
  }

  const availability =
    checkProductAvailability(
      product,
      size,
      color
    );

  if (
    !availability.available
  ) {
    return {
      handled: true,
      response:
        availability.reason ===
        "size_unavailable"
          ? `That one isn't available in size ${size}.`
          : availability.reason ===
            "color_unavailable"
          ? `That one isn't available in ${color}.`
          : "That product isn't available right now."
    };
  }

  const result =
    addToCart(
      call,
      product,
      size,
      color,
      1
    );

  return {
    handled: true,
    response:
      result.message
  };
}

// ============================================================
// INTELLIGENT QUESTION ROUTER
// ============================================================

async function generateAssistantResponse(
  call,
  question
) {
  const q =
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (!q) {
    return "";
  }

  // ----------------------------------------------------------
  // FAST LOCAL INTENTS
  // ----------------------------------------------------------

  const local =
    await handleLocalIntent(
      call,
      q
    );

  if (
    local.handled
  ) {
    return local.response;
  }

  // ----------------------------------------------------------
  // ADD TO CART
  // ----------------------------------------------------------

  if (
    detectIntent(q) === "add_to_cart" ||
    /\b(add|put).*(cart)\b/i.test(q)
  ) {
    const result =
      await handleAddToCart(
        call,
        q
      );

    if (
      result.handled
    ) {
      return result.response;
    }
  }

  // ----------------------------------------------------------
  // PRODUCT SEARCH
  // ----------------------------------------------------------

  if (
    detectIntent(q) === "product_search"
  ) {
    const result =
      await handleProductQuestion(
        call,
        q
      );

    if (
      result.handled
    ) {
      return result.response;
    }
  }

  // ----------------------------------------------------------
  // SIZE HELP
  // ----------------------------------------------------------

  if (
    detectIntent(q) === "size_help"
  ) {
    return askGroq(
      call,
      q,
      `
The customer is asking about sizing or fit.

Explain the sizing naturally and briefly.
If a specific product is already being discussed,
use that product's available sizes.

Do not invent a size chart if one is not available.
`
    );
  }

  // ----------------------------------------------------------
  // RETURN / REFUND
  // ----------------------------------------------------------

  if (
    detectIntent(q) === "return" ||
    detectIntent(q) === "cancel_order"
  ) {
    return (
      "Sorry, that option is unavailable right now. " +
      "I can currently help with products, shopping, sizes, your cart, orders and tracking."
    );
  }

  // ----------------------------------------------------------
  // GENERAL AI
  // ----------------------------------------------------------

  const answer =
    await askGroq(
      call,
      q
    );

  if (
    answer
  ) {
    return answer;
  }

  return (
    "Sorry, I didn't quite catch that. Could you say that again?"
  );
}

// ============================================================
// CONVERSATION MEMORY
// ============================================================

function rememberConversation(
  call,
  userText,
  assistantText
) {
  if (!userText) {
    return;
  }

  call.conversationHistory.push({
    role: "user",
    content: userText
  });

  if (assistantText) {
    call.conversationHistory.push({
      role: "assistant",
      content: assistantText
    });
  }

  // Keep enough history for natural conversation
  // without making every Groq request huge.
  const MAX_HISTORY =
    16;

  if (
    call.conversationHistory.length >
    MAX_HISTORY
  ) {
    call.conversationHistory =
      call.conversationHistory.slice(
        -MAX_HISTORY
      );
  }
}

// ============================================================
// END CALL RESPONSE
// ============================================================

function getGoodbyeResponse() {
  const responses = [
    "Sure. Thanks for calling H&M. Have a great day!",
    "Absolutely. Thanks for calling H&M. Have a great day!",
    "Of course. Thanks for calling H&M. Goodbye!"
  ];

  return responses[
    Math.floor(
      Math.random() *
        responses.length
    )
  ];
}

// ============================================================
// END OF PART 4
// ============================================================
// ============================================================
// PART 5 — CALL ENGINE / EXOTEL / STARTUP
// ============================================================

// ============================================================
// GREETING
// ============================================================

function getGreeting() {
  return (
    "Hi! Welcome to H&M. " +
    "I can help you find products, check colors and sizes, " +
    "make shopping recommendations, add or change items in your cart, " +
    "and check your order or tracking details. " +
    "What would you like to shop for today?"
  );
}

// ============================================================
// END-CALL DETECTION
// ============================================================

function isEndingPhrase(text) {
  const q =
    normalizeText(text);

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
    "i am done",
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
      ) ||
      q.endsWith(
        " " + phrase
      )
  );
}

// ============================================================
// END CALL AFTER GOODBYE
// ============================================================

function scheduleCallEnd(call) {
  if (
    call.destroyed ||
    call.endTimer
  ) {
    return;
  }

  call.endRequested = true;

  call.endTimer =
    setTimeout(() => {
      if (
        call.destroyed
      ) {
        return;
      }

      console.log(
        `[${call.id}] ENDING CALL`
      );

      try {
        if (
          call.ws &&
          call.ws.readyState ===
            WebSocket.OPEN
        ) {
          call.ws.close();
        }
      } catch (_) {}

      destroyCall(call);

    }, 1200);
}

// ============================================================
// IMMEDIATE INTERRUPTION
// ============================================================

function interruptAI(
  call,
  reason = "caller"
) {
  if (
    !call ||
    call.destroyed
  ) {
    return;
  }

  console.log(
    `[${call.id}] 🔴 INTERRUPTING AI: ${reason}`
  );

  // Invalidate all currently running AI generations.
  call.ttsGeneration++;

  call.aiSpeaking = false;
  call.interrupting = true;

  // Stop audio waiting locally.
  if (
    call.audioSender
  ) {
    call.audioSender.clear();
  }

  // Tell Exotel to immediately clear
  // audio that has already been buffered.
  if (
    call.ws &&
    call.ws.readyState ===
      WebSocket.OPEN &&
    call.streamSid
  ) {
    try {
      call.ws.send(
        JSON.stringify({
          event: "clear",
          stream_sid:
            call.streamSid
        })
      );
    } catch (_) {}
  }

  // Clear Deepgram TTS buffer.
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

  // Any unfinished response should never continue.
  call.questionQueue = [];

  // Reset after the clear command.
  setTimeout(() => {
    if (
      !call.destroyed
    ) {
      call.interrupting = false;
    }
  }, 100);

}

// ============================================================
// SEND TEXT TO DEEPGRAM TTS
// ============================================================

function sendTextToTTS(
  call,
  text
) {
  if (
    call.destroyed ||
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {
    return false;
  }

  const clean =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  if (!clean) {
    return false;
  }

  try {
    call.ttsSocket.send(
      JSON.stringify({
        type: "Speak",
        text: clean
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
        type: "Flush"
      })
    );

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

function waitForAudioDrain(call) {
  if (
    call.destroyed
  ) {
    return;
  }

  if (
    !call.audioSender ||
    !call.audioSender.hasPendingAudio()
  ) {
    return;
  }

  setTimeout(() => {
    waitForAudioDrain(call);
  }, 40);
}

// ============================================================
// SPEAK RESPONSE
// ============================================================

async function speakResponse(
  call,
  text,
  generation
) {
  if (
    call.destroyed ||
    call.interrupting
  ) {
    return false;
  }

  if (
    call.ttsGeneration !==
    generation
  ) {
    return false;
  }

  const sent =
    sendTextToTTS(
      call,
      text
    );

  if (!sent) {
    return false;
  }

  call.aiSpeaking = true;

  return true;
}

// ============================================================
// PROCESS USER QUESTION
// ============================================================

async function processQuestion(
  call,
  question
) {
  if (
    call.destroyed ||
    call.endRequested
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
    `[${call.id}] USER: ${clean}`
  );

  // ----------------------------------------------------------
  // INTERRUPTION WORD
  // ----------------------------------------------------------

  if (
    call.aiSpeaking &&
    /^(stop|wait|hold on|hang on|pause|be quiet|that's enough|thats enough|enough)$/i
      .test(clean)
  ) {
    interruptAI(
      call,
      "explicit interruption"
    );

    return;
  }

  // ----------------------------------------------------------
  // GOODBYE
  // ----------------------------------------------------------

  if (
    isEndingPhrase(clean)
  ) {
    if (
      call.aiSpeaking
    ) {
      interruptAI(
        call,
        "customer ending call"
      );
    }

    const goodbye =
      getGoodbyeResponse();

    const generation =
      ++call.ttsGeneration;

    call.aiSpeaking = true;

    if (
      speakResponse(
        call,
        goodbye,
        generation
      )
    ) {
      flushTTS(call);
    }

    scheduleCallEnd(call);

    return;
  }

  // ----------------------------------------------------------
  // NEW AI GENERATION
  // ----------------------------------------------------------

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking = true;
  call.interrupting = false;

  const started =
    Date.now();

  try {

    // --------------------------------------------------------
    // LOCAL / BUSINESS / AI RESPONSE
    // --------------------------------------------------------

    const answer =
      await generateAssistantResponse(
        call,
        clean
      );

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation ||
      call.interrupting
    ) {
      return;
    }

    if (!answer) {
      return;
    }

    console.log(
      `[${call.id}] AI: ${answer}`
    );

    // --------------------------------------------------------
    // MEMORY
    // --------------------------------------------------------

    rememberConversation(
      call,
      clean,
      answer
    );

    // --------------------------------------------------------
    // SEND TO TTS
    // --------------------------------------------------------

    const sent =
      await speakResponse(
        call,
        answer,
        generation
      );

    if (!sent) {
      console.log(
        `[${call.id}] TTS RESPONSE NOT SENT`
      );

      return;
    }

    flushTTS(call);

    console.log(
      `[${call.id}] RESPONSE TIME:`,
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

    const fallback =
      "Sorry, I had a little trouble with that. Could you say it again?";

    if (
      call.ttsGeneration ===
      generation
    ) {
      sendTextToTTS(
        call,
        fallback
      );

      flushTTS(call);
    }

  } finally {

    if (
      call.ttsGeneration ===
      generation
    ) {
      call.aiSpeaking = false;
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

  // If the customer starts talking while AI is talking,
  // immediately stop the old response.
  if (
    call.aiSpeaking
  ) {
    interruptAI(
      call,
      "caller started speaking"
    );
  }

  // Latest customer message gets priority.
  call.questionQueue = [
    clean
  ];

  runQuestionQueue(call);
}

// ============================================================
// QUESTION QUEUE RUNNER
// ============================================================

async function runQuestionQueue(call) {
  if (
    call.queueRunning ||
    call.destroyed
  ) {
    return;
  }

  call.queueRunning = true;

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

    call.queueRunning = false;
  }
}

// ============================================================
// CREATE CALL SESSION
// ============================================================

function createCallSession(ws) {

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

    phone:
      null,

    customerName:
      "Guest",

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

    aiSpeaking:
      false,

    interrupting:
      false,

    ttsGeneration:
      0,

    endRequested:
      false,

    endTimer:
      null,

    productContext: {

      product:
        null,

      category:
        null,

      color:
        null,

      material:
        null,

      size:
        null,

      quantity:
        1
    },

    audioSender:
      null
  };

  call.audioSender =
    createExotelAudioQueue(
      call
    );

  return call;
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

  call.destroyed = true;

  call.aiSpeaking = false;

  call.interrupting = true;

  call.ttsGeneration++;

  call.questionQueue = [];

  call.speechFinalParts = [];

  call.lastInterim = "";

  if (
    call.endTimer
  ) {
    clearTimeout(
      call.endTimer
    );

    call.endTimer = null;
  }

  console.log(
    `[${call.id}] CLEANING UP CALL`
  );

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

  call.sttSocket = null;
  call.ttsSocket = null;

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] ACTIVE CALLS:`,
    activeCalls.size
  );
}

// ============================================================
// DEEPGRAM STT CONNECTION
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
        "&smart_format=true" +
        "&endpointing=150";

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
        setTimeout(() => {

          if (!settled) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram STT connection timeout"
              )
            );
          }

        }, 8000);

      socket.once(
        "open",
        () => {

          settled = true;

          clearTimeout(
            timeout
          );

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(
              timeout
            );

            reject(error);
          }

        }
      );
    }
  );
}

// ============================================================
// DEEPGRAM TTS CONNECTION
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
        setTimeout(() => {

          if (!settled) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram TTS connection timeout"
              )
            );
          }

        }, 8000);

      socket.once(
        "open",
        () => {

          settled = true;

          clearTimeout(
            timeout
          );

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(
              timeout
            );

            reject(error);
          }

        }
      );
    }
  );
}

// ============================================================
// DEEPGRAM SETUP
// ============================================================

async function setupDeepgram(call) {

  try {

    const results =
      await Promise.all([
        createDeepgramSTT(),
        createDeepgramTTS()
      ]);

    const sttSocket =
      results[0];

    const ttsSocket =
      results[1];

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

    call.sttReady = true;
    call.ttsReady = true;

    console.log(
      `[${call.id}] DEEPGRAM READY`
    );

    // ========================================================
    // STT MESSAGE
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

          call.lastSpeechTime =
            Date.now();

          // ==================================================
          // INTERIM
          // ==================================================

          if (
            !message.is_final
          ) {

            call.lastInterim =
              transcript;

            // ------------------------------------------------
            // BARGE-IN
            // ------------------------------------------------

            if (
              call.aiSpeaking &&
              transcript.trim().length >= 2
            ) {

              const lower =
                transcript
                  .toLowerCase()
                  .trim();

              console.log(
                `[${call.id}] 🎤 DURING AI: ${lower}`
              );

              const explicit =
                /^(stop|wait|hold on|hang on|pause|be quiet|that's enough|thats enough|enough)\b/i
                  .test(lower);

              // Even normal speech interrupts the AI.
              if (
                explicit ||
                lower.length >= 3
              ) {

                interruptAI(
                  call,
                  explicit
                    ? "explicit interruption"
                    : "natural barge-in"
                );
              }
            }

            return;
          }

          // ==================================================
          // FINAL
          // ==================================================

          call.speechFinalParts.push(
            transcript
          );

          call.lastInterim = "";

          if (
            message.speech_final
          ) {

            const question =
              call.speechFinalParts
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();

            call.speechFinalParts = [];

            if (
              question
            ) {

              console.log(
                `[${call.id}] FINAL TRANSCRIPT: ${question}`
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

          if (
            isBinary ||
            Buffer.isBuffer(data)
          ) {

            const audio =
              Buffer.from(data);

            if (
              audio.length > 0 &&
              call.aiSpeaking &&
              !call.interrupting
            ) {

              call.audioSender.enqueue(
                audio
              );
            }

            return;
          }

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

            console.log(
              `[${call.id}] TTS FLUSHED`
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
    // CLOSE EVENTS
    // ========================================================

    sttSocket.on(
      "close",
      () => {

        call.sttReady = false;

        console.log(
          `[${call.id}] STT CLOSED`
        );
      }
    );

    ttsSocket.on(
      "close",
      () => {

        call.ttsReady = false;

        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    );

    // ========================================================
    // ERRORS
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

  } catch (error) {

    console.log(
      `[${call.id}] DEEPGRAM SETUP ERROR:`,
      error.message
    );

  }
}

// ============================================================
// EXOTEL WEBSOCKET
// ============================================================

wss.on(
  "connection",
  ws => {

    const call =
      createCallSession(ws);

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
      `[${call.id}] ACTIVE CALLS:`,
      activeCalls.size
    );

    console.log(
      "============================================"
    );

    // --------------------------------------------------------
    // Start Deepgram immediately.
    // --------------------------------------------------------

    setupDeepgram(call);

    // ========================================================
    // EXOTEL EVENTS
    // ========================================================

    ws.on(
      "message",
      async data => {

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
              `[${call.id}] EXOTEL STREAM CONNECTED`
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

            const start =
              message.start ||
              {};

            call.streamSid =
              message.stream_sid ||
              start.stream_sid ||
              start.streamSid ||
              null;

            call.callSid =
              start.call_sid ||
              start.callSid ||
              null;

            call.phone =
              start.custom_parameters
                ?.phone ||
              start.customParameters
                ?.phone ||
              null;

            call.customerName =
              start.custom_parameters
                ?.name ||
              start.customParameters
                ?.name ||
              "Guest";

            console.log(
              `[${call.id}] CALL SID:`,
              call.callSid
            );

            console.log(
              `[${call.id}] STREAM SID:`,
              call.streamSid
            );

            console.log(
              `[${call.id}] PHONE:`,
              call.phone ||
              "unknown"
            );

            console.log(
              `[${call.id}] CUSTOMER:`,
              call.customerName
            );

            // ------------------------------------------------
            // GREETING
            // ------------------------------------------------

            // Wait briefly so the TTS socket has time to become
            // available if Exotel sends START extremely quickly.

            const greetingGeneration =
              ++call.ttsGeneration;

            const sendGreeting =
              () => {

                if (
                  call.destroyed ||
                  call.ttsGeneration !==
                    greetingGeneration
                ) {
                  return;
                }

                const greeting =
                  getGreeting();

                if (
                  sendTextToTTS(
                    call,
                    greeting
                  )
                {

                  call.aiSpeaking = true;

                  flushTTS(call);

                  console.log(
                    `[${call.id}] GREETING SENT`
                  );
                } else {

                  setTimeout(
                    sendGreeting,
                    150
                  );
                }
              };

            sendGreeting();

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

            if (
              audio.length === 0
            ) {
              return;
            }

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

            call.speechFinalParts = [];
            call.lastInterim = "";

            return;
          }

          // ==================================================
          // MARK
          // ==================================================

          if (
            event ===
            "mark"
          ) {

            console.log(
              `[${call.id}] MARK:`,
              message.mark?.name
            );

            return;
          }

          // ==================================================
          // DTMF
          // ==================================================

          if (
            event ===
            "dtmf"
          ) {

            console.log(
              `[${call.id}] DTMF:`,
              message.dtmf?.digit
            );

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
              `[${call.id}] EXOTEL CALL STOP`
            );

            destroyCall(call);

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
    // WS CLOSE
    // ========================================================

    ws.on(
      "close",
      () => {

        console.log(
          `[${call.id}] EXOTEL DISCONNECTED`
        );

        destroyCall(call);
      }
    );

    // ========================================================
    // WS ERROR
    // ========================================================

    ws.on(
      "error",
      error => {

        console.log(
          `[${call.id}] EXOTEL WS ERROR:`,
          error.message
        );

        destroyCall(call);
      }
    );
  }
);

// ============================================================
// HTTP SERVER ERROR
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
// PROCESS ERROR HANDLERS
// ============================================================

process.on(
  "uncaughtException",
  error => {

    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "UNHANDLED REJECTION:",
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
      "H&M AI VOICE CUSTOMER ASSISTANT"
    );

    console.log(
      "============================================"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Groq:",
      GROQ_MODEL
    );

    console.log(
      "Deepgram STT:",
      DEEPGRAM_STT_MODEL
    );

    console.log(
      "Deepgram TTS:",
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
