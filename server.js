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

const WS_URL = PUBLIC_URL
  .replace(/^https:/, "wss:")
  .replace(/^http:/, "ws:");

const GROQ_MODEL = "llama-3.1-8b-instant";
const STT_MODEL = "nova-3";
const TTS_MODEL = "aura-2-thalia-en";

// ============================================================
// ENVIRONMENT
// ============================================================

const GROQ_KEY = process.env.GROQ_API_KEY;
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;

if (!GROQ_KEY) {
  throw new Error("GROQ_API_KEY is missing");
}

if (!DG_KEY) {
  throw new Error("DEEPGRAM_API_KEY is missing");
}

const groq = new Groq({
  apiKey: GROQ_KEY
});

// ============================================================
// ACTIVE CALLS
// ============================================================

const calls = new Map();

let callNo = 1;

// ============================================================
// FAKE H&M DATABASE
// ============================================================

const products = [

  {
    id: "JEAN001",

    name: "Bootcut Jeans",

    category: "jeans",

    style: "bootcut",

    price: 2299,

    colors: [
      "black",
      "dark blue",
      "faded blue",
      "faded bluish-green",
      "washed teal"
    ],

    materials: [
      "99% cotton",
      "1% elastane"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "32"
    ],

    stock: {
      XS: 5,
      S: 8,
      M: 12,
      L: 8,
      XL: 3,
      "32": 7
    }
  },

  {
    id: "JEAN002",

    name: "Relaxed Straight Jeans",

    category: "jeans",

    style: "straight",

    price: 1999,

    colors: [
      "light blue",
      "washed blue",
      "black"
    ],

    materials: [
      "100% cotton"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL",
      "32"
    ],

    stock: {
      S: 8,
      M: 12,
      L: 7,
      XL: 3,
      "32": 6
    }
  },

  {
    id: "JEAN003",

    name: "Slim Tapered Jeans",

    category: "jeans",

    style: "slim",

    price: 1799,

    colors: [
      "dark blue",
      "black",
      "faded blue"
    ],

    materials: [
      "98% cotton",
      "2% elastane"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL",
      "32"
    ],

    stock: {
      S: 7,
      M: 10,
      L: 8,
      XL: 4,
      "32": 6
    }
  },

  {
    id: "TOP001",

    name: "Oversized Cotton T-Shirt",

    category: "tops",

    style: "oversized",

    price: 999,

    colors: [
      "white",
      "black",
      "sage green",
      "washed teal"
    ],

    materials: [
      "100% cotton"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L",
      "XL"
    ],

    stock: {
      XS: 8,
      S: 12,
      M: 15,
      L: 10,
      XL: 4
    }
  },

  {
    id: "HOOD001",

    name: "Relaxed-Fit Hoodie",

    category: "hoodies",

    style: "hoodie",

    price: 1999,

    colors: [
      "black",
      "grey",
      "sage green",
      "washed teal"
    ],

    materials: [
      "80% cotton",
      "20% polyester"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],

    stock: {
      S: 5,
      M: 9,
      L: 8,
      XL: 3
    }
  },

  {
    id: "SHIRT001",

    name: "Linen-Blend Shirt",

    category: "shirts",

    style: "regular",

    price: 2299,

    colors: [
      "white",
      "beige",
      "light blue",
      "sage green"
    ],

    materials: [
      "55% linen",
      "45% cotton"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],

    stock: {
      S: 5,
      M: 8,
      L: 6,
      XL: 2
    }
  },

  {
    id: "DRESS001",

    name: "Fitted Midi Dress",

    category: "dresses",

    style: "midi",

    price: 2499,

    colors: [
      "black",
      "red",
      "sage green",
      "cream"
    ],

    materials: [
      "95% polyester",
      "5% elastane"
    ],

    sizes: [
      "XS",
      "S",
      "M",
      "L"
    ],

    stock: {
      XS: 5,
      S: 8,
      M: 7,
      L: 3
    }
  }

];

// ============================================================
// CUSTOMERS
// ============================================================

const customers = {

  CUST1001: {
    id: "CUST1001",
    name: "Alex",
    phone: "+919999999999",
    email: "alex@example.com",
    address: "12 Example Street, Chennai",
    size: "M"
  },

  CUST1002: {
    id: "CUST1002",
    name: "Sam",
    phone: "+918888888888",
    email: "sam@example.com",
    address: "45 Example Road, Bengaluru",
    size: "L"
  }

};

// ============================================================
// CARTS
// ============================================================

const carts = {

  CUST1001: [
    {
      productId: "TOP001",
      size: "M",
      quantity: 1
    }
  ],

  CUST1002: [
    {
      productId: "JEAN002",
      size: "32",
      quantity: 1
    }
  ]

};

// ============================================================
// WISHLISTS
// ============================================================

const wishlists = {

  CUST1001: [
    "JEAN001"
  ],

  CUST1002: []

};

// ============================================================
// ORDERS
// ============================================================

const orders = [

  {
    id: "HM48291",

    customerId: "CUST1001",

    items: [
      {
        productId: "JEAN001",
        size: "M",
        quantity: 1
      }
    ],

    total: 2299,

    status: "shipped",

    carrier: "DHL",

    tracking: "DHL-IN-48291",

    eta: "2026-08-14",

    canCancel: false
  },

  {
    id: "HM48112",

    customerId: "CUST1001",

    items: [
      {
        productId: "HOOD001",
        size: "L",
        quantity: 1
      }
    ],

    total: 1999,

    status: "processing",

    carrier: null,

    tracking: null,

    eta: "2026-08-16",

    canCancel: true
  },

  {
    id: "HM47555",

    customerId: "CUST1002",

    items: [
      {
        productId: "JEAN002",
        size: "32",
        quantity: 1
      }
    ],

    total: 1999,

    status: "delivered",

    carrier: "DHL",

    tracking: "DHL-IN-47555",

    eta: "2026-08-05",

    canCancel: false
  }

];


// ============================================================
// RETURNS
// ============================================================

const returns = [];


// ============================================================
// STORES
// ============================================================

const stores = [

  {
    id: "CHN1",
    name: "H&M Phoenix MarketCity Chennai",
    city: "Chennai",
    hours: "10 AM to 10 PM"
  },

  {
    id: "CHN2",
    name: "H&M Express Avenue Chennai",
    city: "Chennai",
    hours: "10 AM to 10 PM"
  },

  {
    id: "BLR1",
    name: "H&M Orion Mall Bengaluru",
    city: "Bengaluru",
    hours: "10 AM to 10 PM"
  }

];


// ============================================================
// HELPERS
// ============================================================

function clean(value) {

  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();

}


function money(value) {

  return (
    "₹" +
    Number(value).toLocaleString("en-IN")
  );

}


function product(id) {

  return products.find(
    p => p.id === id
  );

}


function customer(id) {

  return (
    customers[id] ||
    customers.CUST1001
  );

}


function summary(p) {

  return {

    id: p.id,

    name: p.name,

    price: money(p.price),

    category: p.category,

    style: p.style,

    colors: p.colors,

    materials: p.materials,

    sizes: p.sizes

  };

}


function customerFor(call) {

  return customer(
    call.customerId
  );

}


// ============================================================
// SIZE DETECTION
// ============================================================

function sizeFrom(q) {

  const x =
    q.toLowerCase();

  if (
    /\bextra small\b|\bxs\b/.test(x)
  ) {
    return "XS";
  }

  if (
    /\bsmall\b|\bs\b/.test(x)
  ) {
    return "S";
  }

  if (
    /\bmedium\b|\bmed\b|\bm\b/.test(x)
  ) {
    return "M";
  }

  if (
    /\blarge\b|\bl\b/.test(x)
  ) {
    return "L";
  }

  if (
    /\bextra large\b|\bxl\b/.test(x)
  ) {
    return "XL";
  }

  const n =
    x.match(
      /\b(26|27|28|29|30|31|32|33|34|36|38|40)\b/
    );

  return n
    ? n[1]
    : "";

}


// ============================================================
// COLOUR UNDERSTANDING
// ============================================================

function colorTerms(q) {

  const x =
    q.toLowerCase();

  const out = [];

  if (
    /green|sage|olive|mint/.test(x)
  ) {
    out.push("green");
  }

  if (
    /blue|navy|denim/.test(x)
  ) {
    out.push("blue");
  }

  if (
    /teal|bluish.green|blue.green|turquoise/.test(x)
  ) {
    out.push("teal");
  }

  if (
    /faded|washed|vintage/.test(x)
  ) {
    out.push("faded");
  }

  if (
    /black/.test(x)
  ) {
    out.push("black");
  }

  if (
    /white|cream/.test(x)
  ) {
    out.push("white");
  }

  if (
    /beige|tan|sand/.test(x)
  ) {
    out.push("beige");
  }

  return out;

}


// ============================================================
// COLOUR MATCHING
// ============================================================

function colorScore(q, c) {

  q =
    q.toLowerCase();

  c =
    c.toLowerCase();

  let score = 0;

  if (
    q.includes(c) ||
    c.includes(q)
  ) {
    score += 10;
  }

  for (
    const t of colorTerms(q)
  ) {

    if (
      c.includes(t)
    ) {
      score += 5;
    }

    if (
      t === "blue" &&
      (
        c.includes("teal") ||
        c.includes("blue")
      )
    ) {
      score += 2;
    }

    if (
      t === "green" &&
      (
        c.includes("teal") ||
        c.includes("green")
      )
    ) {
      score += 2;
    }

    if (
      t === "teal" &&
      (
        c.includes("blue") ||
        c.includes("green") ||
        c.includes("teal")
      )
    ) {
      score += 2;
    }

    if (
      t === "faded" &&
      (
        c.includes("washed") ||
        c.includes("faded")
      )
    ) {
      score += 3;
    }

  }

  return score;

}


// ============================================================
// FIND PRODUCT FROM NATURAL SPEECH
// ============================================================

function findProductFromSpeech(q) {

  let best = null;

  let score = 0;

  const x =
    q.toLowerCase();

  for (
    const p of products
  ) {

    let s = 0;

    if (
      x.includes(
        p.id.toLowerCase()
      )
    ) {
      s += 20;
    }

    if (
      x.includes(
        p.name.toLowerCase()
      )
    ) {
      s += 20;
    }

    if (
      x.includes(
        p.category
      )
    ) {
      s += 5;
    }

    if (
      x.includes(
        p.style
      )
    ) {
      s += 8;
    }

    for (
      const tag of p.colors
    ) {

      s += colorScore(
        x,
        tag
      );

    }

    if (
      s > score
    ) {

      score = s;

      best = p;

    }

  }

  return best;

}


// ============================================================
// PRODUCT SEARCH
// ============================================================

function searchProducts(q) {

  const size =
    sizeFrom(q);

  const colors =
    colorTerms(q);

  return products

    .map(p => {

      let score = 0;

      const x =
        q.toLowerCase();

      if (
        x.includes(
          p.category
        )
      ) {
        score += 8;
      }

      if (
        x.includes(
          p.style
        )
      ) {
        score += 8;
      }

      if (
        x.includes(
          p.name.toLowerCase()
        )
      ) {
        score += 15;
      }

      if (
        size &&
        p.sizes.includes(size)
      ) {
        score += 5;
      }

      for (
        const c of colors
      ) {

        score += Math.max(
          ...p.colors.map(
            v =>
              colorScore(
                c,
                v
              )
          ),
          0
        );

      }

      for (
        const m of p.materials
      ) {

        if (
          x.includes(
            m
              .split("%")
              .pop()
              .trim()
              .toLowerCase()
          )
        ) {
          score += 3;
        }

      }

      return {
        score,
        product: p
      };

    })

    .filter(
      x => x.score > 0
    )

    .sort(
      (a, b) =>
        b.score - a.score
    )

    .slice(0, 5)

    .map(
      x =>
        summary(
          x.product
        )
    );

}


// ============================================================
// CART DATA
// ============================================================

function cartData(cid) {

  return (
    carts[cid] || []
  ).map(item => {

    const p =
      product(
        item.productId
      );

    return {

      ...item,

      product:
        p
          ? summary(p)
          : null,

      subtotal:
        p
          ? p.price *
            item.quantity
          : 0

    };

  });

}


// ============================================================
// BUSINESS ACTION ENGINE
// ============================================================

function runAction(call, q) {

  const cid =
    customerFor(call).id;

  const x =
    q.toLowerCase();


  // ----------------------------------------------------------
  // CART
  // ----------------------------------------------------------

  if (
    /\bwhat.*cart\b|
     \bshow.*cart\b|
     \bcart.*contain/.test(x)
  ) {

    return {

      action: "cart",

      result:
        cartData(cid)

    };

  }


  // ----------------------------------------------------------
  // WISHLIST
  // ----------------------------------------------------------

  if (
    /\bwishlist\b/.test(x)
  ) {

    return {

      action: "wishlist",

      result:
        (
          wishlists[cid] ||
          []
        )
          .map(product)
          .filter(Boolean)
          .map(summary)

    };

  }


  // ----------------------------------------------------------
  // ADD TO CART
  // ----------------------------------------------------------

  if (
    /\badd\b.*\bcart\b/.test(x)
  ) {

    const p =
      findProductFromSpeech(q);

    const size =
      sizeFrom(q) ||
      customerFor(call).size;

    if (!p) {

      return {

        action:
          "add_to_cart",

        result: {

          ok: false,

          message:
            "I couldn't identify the product."

        }

      };

    }

    if (
      !p.sizes.includes(size)
    ) {

      return {

        action:
          "add_to_cart",

        result: {

          ok: false,

          message:
            `That product isn't available in ${size}.`

        }

      };

    }

    if (
      (p.stock[size] || 0) < 1
    ) {

      return {

        action:
          "add_to_cart",

        result: {

          ok: false,

          message:
            `That product is out of stock in ${size}.`

        }

      };

    }

    const c =
      carts[cid] ||
      (
        carts[cid] = []
      );

    const old =
      c.find(
        i =>
          i.productId ===
            p.id &&
          i.size ===
            size
      );

    if (old) {

      old.quantity++;

    } else {

      c.push({

        productId:
          p.id,

        size,

        quantity:
          1

      });

    }

    return {

      action:
        "add_to_cart",

      result: {

        ok: true,

        product:
          p.name,

        size,

        cart:
          cartData(cid)

      }

    };

  }


  // ----------------------------------------------------------
  // REMOVE FROM CART
  // ----------------------------------------------------------

  if (
    /\bremove\b|\bdelete\b/.test(x) &&
    /\bcart\b/.test(x)
  ) {

    const p =
      findProductFromSpeech(q);

    if (!p) {

      return {

        action:
          "remove_from_cart",

        result: {

          ok: false,

          message:
            "I couldn't identify the cart item."

        }

      };

    }

    carts[cid] =
      (
        carts[cid] || []
      ).filter(
        i =>
          i.productId !==
          p.id
      );

    return {

      action:
        "remove_from_cart",

      result: {

        ok: true,

        cart:
          cartData(cid)

      }

    };

  }


  // ----------------------------------------------------------
  // TRACKING / DELIVERY
  // ----------------------------------------------------------

  if (
    /\btrack\b|
     \btracking\b|
     \bwhere.*order\b|
     \bshipment\b|
     \bdelivery\b/.test(x)
  ) {

    const id =
      (
        q.match(
          /\bHM\d+\b/i
        ) || []
      )[0];

    const os =
      orders.filter(
        o =>
          o.customerId ===
          cid
      );

    const o =
      id
        ? os.find(
            v =>
              v.id.toUpperCase() ===
              id.toUpperCase()
          )
        : os[0];

    return {

      action:
        "tracking",

      result:
        o || {
          found: false
        }

    };

  }


  // ----------------------------------------------------------
  // CANCEL ORDER
  // ----------------------------------------------------------

  if (
    /\bcancel\b.*\border\b/.test(x)
  ) {

    const id =
      (
        q.match(
          /\bHM\d+\b/i
        ) || []
      )[0];

    const os =
      orders.filter(
        o =>
          o.customerId ===
          cid
      );

    const o =
      id
        ? os.find(
            v =>
              v.id.toUpperCase() ===
              id.toUpperCase()
          )
        : os[0];

    if (!o) {

      return {

        action:
          "cancel_order",

        result: {

          ok: false,

          message:
            "Order not found."

        }

      };

    }

    if (
      !o.canCancel
    ) {

      return {

        action:
          "cancel_order",

        result: {

          ok: false,

          message:
            "That order has already moved forward and cannot be cancelled."

        }

      };

    }

    o.status =
      "cancelled";

    o.canCancel =
      false;

    return {

      action:
        "cancel_order",

      result: {

        ok: true,

        orderId:
          o.id,

        status:
          o.status

      }

    };

  }


  // ----------------------------------------------------------
  // RETURN
  // ----------------------------------------------------------

  if (
    /\breturn\b/.test(x)
  ) {

    const id =
      (
        q.match(
          /\bHM\d+\b/i
        ) || []
      )[0];

    const os =
      orders.filter(
        o =>
          o.customerId ===
          cid
      );

    const o =
      id
        ? os.find(
            v =>
              v.id.toUpperCase() ===
              id.toUpperCase()
          )
        : os.find(
            v =>
              v.status ===
              "delivered"
          );

    if (!o) {

      return {

        action:
          "return",

        result: {

          ok: false,

          message:
            "I couldn't find a delivered order to return."

        }

      };

    }

    if (
      o.status !==
      "delivered"
    ) {

      return {

        action:
          "return",

        result: {

          ok: false,

          message:
            "That order has not been delivered yet."

        }

      };

    }

    const r = {

      id:
        `RET${String(
          returns.length + 1
        ).padStart(4, "0")}`,

      orderId:
        o.id,

      status:
        "return_requested",

      refundStatus:
        "pending"

    };

    returns.push(r);

    return {

      action:
        "return",

      result: {

        ok: true,

        return:
          r

      }

    };

  }


  // ----------------------------------------------------------
  // STORE INFORMATION
  // ----------------------------------------------------------

  if (
    /\bstore\b|
     \bhours\b|
     \bopen\b|
     \blocation\b/.test(x)
  ) {

    return {

      action:
        "stores",

      result:
        stores

    };

  }


  // ----------------------------------------------------------
  // PRODUCT SEARCH
  // ----------------------------------------------------------

  if (
    /\bjeans?\b|
     \bhoodie\b|
     \bshirt\b|
     \bdress\b|
     \btop\b|
     \bproduct\b|
     \bsize\b|
     \bcolour\b|
     \bcolor\b|
     \bmaterial\b|
     \bprice\b|
     \bcotton\b|
     \blinen\b|
     \bbootcut\b/.test(x)
  ) {

    return {

      action:
        "products",

      result:
        searchProducts(q)

    };

  }


  return {

    action:
      "none",

    result:
      null

  };

}


// ============================================================
// GROQ SYSTEM PROMPT
// ============================================================

const SYSTEM = `

You are an H&M phone customer-service assistant.

Sound like a real human retail employee, not a bot and not an IVR.

Be warm, confident, natural and concise.

Usually speak one to three short sentences.

Understand interruptions, corrections, incomplete speech and follow-up questions.

Remember what the customer already told you.

If they change only the colour, preserve the product and size.

If they change only the size, preserve the product and colour.

Understand natural colours such as:

- faded bluish-green
- washed teal
- dusty blue-green
- olive-ish
- vintage blue
- washed black
- creamish white

Never reject these merely because they are not exact catalog wording.

Use the closest available product colour.

Never mention:

AI
prompts
APIs
tools
databases
Groq
Deepgram
internal systems

Never invent:

product stock
prices
order status
tracking information
actions

For unrelated general questions, answer briefly and naturally rather than refusing.

Ask one useful question at a time.

If an action result says something succeeded, confirm it naturally.

If an action is unavailable, explain briefly and offer the closest useful alternative.

Do not read JSON or internal data to the caller.

Do not sound like a scripted call center.

`;

// ============================================================
// GROQ STREAMING ANSWER
// ============================================================

async function answer(
  call,
  q,
  action,
  generation
) {

  const c =
    customerFor(call);

  const context = {

    customer: {

      name:
        c.name,

      size:
        c.size

    },

    cart:
      cartData(c.id),

    recentOrders:
      orders
        .filter(
          o =>
            o.customerId ===
            c.id
        )
        .slice(0, 3),

    wishlist:
      (
        wishlists[c.id] ||
        []
      )
        .map(product)
        .filter(Boolean)
        .map(summary)

  };


  const messages = [

    {
      role:
        "system",

      content:
        SYSTEM

    },

    {
      role:
        "system",

      content:
        "SESSION DATA:\n" +
        JSON.stringify(
          context
        )

    },

    {
      role:
        "system",

      content:
        "AUTHORITATIVE ACTION RESULT:\n" +
        JSON.stringify(
          action
        )

    }

  ];


  for (
    const m of
      call.history.slice(-10)
  ) {

    messages.push(m);

  }


  messages.push({

    role:
      "user",

    content:
      q

  });


  const ac =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        ac.abort(),
      8000
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
            90,

          stream:
            true

        },

        {
          signal:
            ac.signal
        }

      );


    let full = "";

    let pending = "";


    for await (
      const ch of
        stream
    ) {

      if (
        call.destroyed ||
        call.generation !==
          generation
      ) {

        break;

      }


      const text =
        ch
          ?.choices?.[0]
          ?.delta
          ?.content || "";


      if (!text) {

        continue;

      }


      full +=
        text;

      pending +=
        text;


      let match;


      while (
        (
          match =
            pending.match(
              /^([\s\S]*?[.!?])(?:\s+|$)/
            )
        )
      {

        if (
          call.destroyed ||
          call.generation !==
            generation
        ) {

          break;

        }


        const sentence =
          clean(
            match[1]
          );


        pending =
          pending
            .slice(
              match[0].length
            )
            .trimStart();


        if (
          sentence
        ) {

          speak(
            call,
            sentence,
            generation
          );

        }

      }


      // ------------------------------------------------------
      // EARLY CHUNKING
      // ------------------------------------------------------

      if (
        pending.length >= 38
      ) {

        const cut =
          pending.lastIndexOf(
            " "
          );


        if (
          cut >= 20
        ) {

          const sentence =
            clean(
              pending.slice(
                0,
                cut
              )
            );


          pending =
            pending
              .slice(
                cut + 1
              )
              .trimStart();


          if (
            sentence
          ) {

            speak(
              call,
              sentence,
              generation
            );

          }

        }

      }

    }


    if (
      pending &&
      call.generation ===
        generation
    ) {

      speak(
        call,
        clean(pending),
        generation
      );

    }


    return clean(full);

  } finally {

    clearTimeout(
      timer
    );

  }

}


// ============================================================
// SEND TEXT TO DEEPGRAM TTS
// ============================================================

function speak(
  call,
  text,
  generation
) {

  if (
    call.destroyed ||
    call.generation !==
      generation ||
    !call.tts
  ) {

    return false;

  }


  if (
    call.tts.readyState !==
    WebSocket.OPEN
  ) {

    return false;

  }


  try {

    call.tts.send(

      JSON.stringify({

        type:
          "Speak",

        text:
          clean(text)

      })

    );


    call.aiSpeaking =
      true;


    return true;

  } catch {

    return false;

  }

}


// ============================================================
// FLUSH TTS
// ============================================================

function flush(call) {

  if (
    call.tts?.readyState ===
    WebSocket.OPEN
  ) {

    try {

      call.tts.send(

        JSON.stringify({

          type:
            "Flush"

        })

      );

      return true;

    } catch {}

  }

  return false;

}


// ============================================================
// INTERRUPTION
// ============================================================

function interrupt(
  call,
  reason
) {

  if (
    !call.aiSpeaking
  ) {

    return;

  }


  console.log(
    `[${call.id}] INTERRUPT: ${reason}`
  );


  call.generation++;

  call.aiSpeaking =
    false;


  call.audio.clear();


  // ----------------------------------------------------------
  // CLEAR EXOTEL BUFFER
  // ----------------------------------------------------------

  if (
    call.ws?.readyState ===
      WebSocket.OPEN &&
    call.streamSid
  ) {

    try {

      call.ws.send(

        JSON.stringify({

          event:
            "clear",

          stream_sid:
            call.streamSid

        })

      );

    } catch {}

  }


  // ----------------------------------------------------------
  // FLUSH TTS
  // ----------------------------------------------------------

  if (
    call.tts?.readyState ===
    WebSocket.OPEN
  ) {

    try {

      call.tts.send(

        JSON.stringify({

          type:
            "Flush"

        })

      );

    } catch {}

  }

}


// ============================================================
// END / STOP COMMANDS
// ============================================================

const endWords =
  /^(?:okay\s+)?(?:that's it|nothing else|no that's all|i'm done|im done|bye|goodbye|that's everything|thank you|thanks)$/i;


const stopWords =
  /^(?:stop|wait|hold on|hang on|pause|that's enough|enough|stop talking)$/i;


// ============================================================
// PROCESS QUESTION
// ============================================================

async function processQuestion(
  call,
  q
) {

  q =
    clean(q);


  if (
    !q ||
    call.destroyed
  ) {

    return;

  }


  // ----------------------------------------------------------
  // STOP AI
  // ----------------------------------------------------------

  if (
    stopWords.test(q)
  ) {

    interrupt(
      call,
      "explicit stop"
    );

    return;

  }


  // ----------------------------------------------------------
  // END CALL
  // ----------------------------------------------------------

  if (
    endWords.test(q)
  ) {

    call.generation++;

    call.aiSpeaking =
      false;

    call.audio.clear();


    try {

      call.ws.send(

        JSON.stringify({

          event:
            "clear",

          stream_sid:
            call.streamSid

        })

      );

    } catch {}


    call.endAfterGoodbye =
      true;


    const generation =
      call.generation;


    speak(

      call,

      "You're all set. Thanks for calling H and M. Goodbye.",

      generation

    );


    flush(call);


    return;

  }


  // ----------------------------------------------------------
  // NEW GENERATION
  // ----------------------------------------------------------

  const generation =
    ++call.generation;


  call.aiSpeaking =
    true;


  console.log(
    `[${call.id}] USER: ${q}`
  );


  try {

    // --------------------------------------------------------
    // ACTION
    // --------------------------------------------------------

    const action =
      runAction(
        call,
        q
      );


    // --------------------------------------------------------
    // GROQ
    // --------------------------------------------------------

    const result =
      await answer(
        call,
        q,
        action,
        generation
      );


    if (
      call.destroyed ||
      call.generation !==
        generation
    ) {

      return;

    }


    // --------------------------------------------------------
    // MEMORY
    // --------------------------------------------------------

    if (
      result
    ) {

      call.history.push({

        role:
          "user",

        content:
          q

      });


      call.history.push({

        role:
          "assistant",

        content:
          result

      });


      if (
        call.history.length >
        10
      ) {

        call.history =
          call.history.slice(
            -10
          );

      }


      console.log(
        `[${call.id}] AI: ${result}`
      );

    }


    flush(call);


  } catch (err) {

    if (
      call.destroyed ||
      call.generation !==
        generation
    ) {

      return;

    }


    console.log(

      `[${call.id}] PROCESS ERROR: ${err.message}`

    );


    speak(

      call,

      "Sorry, I had a small problem there. Please try that again.",

      generation

    );


    flush(call);

  }

}


// ============================================================
// DEEPGRAM CONNECTION
// ============================================================

function dg(
  url,
  label
) {

  return new Promise(
    (resolve, reject) => {

      const socket =
        new WebSocket(

          url,

          {

            headers: {

              Authorization:
                `Token ${DG_KEY}`

            }

          }

        );


      const timer =
        setTimeout(

          () => {

            try {

              socket.close();

            } catch {}


            reject(

              new Error(
                label +
                " timeout"
              )

            );

          },

          6500

        );


      socket.once(
        "open",
        () => {

          clearTimeout(
            timer
          );

          resolve(
            socket
          );

        }
      );


      socket.once(
        "error",
        error => {

          clearTimeout(
            timer
          );

          reject(
            error
          );

        }
      );

    }
  );

}


// ============================================================
// DEEPGRAM STT
// ============================================================

function stt() {

  return dg(

    "wss://api.deepgram.com/v1/listen" +

    `?model=${encodeURIComponent(
      STT_MODEL
    )}` +

    "&language=en-US" +

    "&encoding=linear16" +

    "&sample_rate=8000" +

    "&channels=1" +

    "&interim_results=true" +

    "&punctuate=true" +

    "&endpointing=180" +

    "&smart_format=true",

    "STT"

  );

}


// ============================================================
// DEEPGRAM TTS
// ============================================================

function tts() {

  return dg(

    "wss://api.deepgram.com/v1/speak" +

    `?model=${encodeURIComponent(
      TTS_MODEL
    )}` +

    "&encoding=linear16" +

    "&sample_rate=8000" +

    "&container=none" +

    "&speed=1.18",

    "TTS"

  );

}


// ============================================================
// CLOSE SOCKET
// ============================================================

function close(socket) {

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

  } catch {}


  try {

    socket.close();

  } catch {}

}


// ============================================================
// 20MS EXOTEL AUDIO QUEUE
// ============================================================

function audioQueue(call) {

  const queue = [];

  let timer =
    null;

  let sequence =
    1;

  let chunk =
    0;

  let timestamp =
    0;

  let stopped =
    false;


  // 8000 samples/sec
  // 16-bit mono
  // 20ms = 320 bytes

  const frame =
    320;


  function clear() {

    queue.length =
      0;


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


  function next() {

    timer =
      null;


    if (
      stopped ||
      call.destroyed ||
      !call.ws ||
      call.ws.readyState !==
        WebSocket.OPEN ||
      !call.streamSid
    ) {

      return;

    }


    const buffer =
      queue.shift();


    if (!buffer) {

      return;

    }


    try {

      call.ws.send(

        JSON.stringify({

          event:
            "media",

          sequence_number:
            String(
              sequence++
            ),

          stream_sid:
            call.streamSid,

          media: {

            chunk:
              String(
                chunk++
              ),

            timestamp:
              String(
                timestamp
              ),

            payload:
              buffer.toString(
                "base64"
              )

          }

        })

      );


      timestamp +=
        20;


    } catch {

      clear();

      return;

    }


    if (
      queue.length
    ) {

      timer =
        setTimeout(
          next,
          20
        );

    }

  }


  function add(buffer) {

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
      i += frame
    ) {

      queue.push(

        buffer.subarray(

          i,

          Math.min(
            i + frame,
            buffer.length
          )

        )

      );

    }


    if (!timer) {

      next();

    }

  }


  function pending() {

    return (
      queue.length >
      0 ||
      !!timer
    );

  }


  return {

    add,

    clear,

    stop,

    pending

  };

}


// ============================================================
// CREATE CALL SESSION
// ============================================================

function newCall(ws) {

  const call = {

    id:
      `CALL-${String(
        callNo++
      ).padStart(
        4,
        "0"
      )}`,

    ws,

    destroyed:
      false,

    streamSid:
      null,

    callSid:
      null,

    customerId:
      "CUST1001",

    stt:
      null,

    tts:
      null,

    audio:
      null,

    greeted:
      false,

    aiSpeaking:
      false,

    generation:
      0,

    history:
      [],

    parts:
      [],

    lastInterim:
      "",

    queue:
      [],

    running:
      false,

    endAfterGoodbye:
      false

  };


  call.audio =
    audioQueue(
      call
    );


  return call;

}


// ============================================================
// DESTROY CALL
// ============================================================

function destroy(call) {

  if (
    call.destroyed
  ) {

    return;

  }


  call.destroyed =
    true;


  call.generation++;


  call.aiSpeaking =
    false;


  call.audio.stop();


  close(
    call.stt
  );


  close(
    call.tts
  );


  calls.delete(
    call.id
  );


  console.log(

    `[${call.id}] DISCONNECTED. ACTIVE: ${calls.size}`

  );

}


// ============================================================
// SETUP DEEPGRAM
// ============================================================

async function setup(call) {

  try {

    const [
      sttSocket,
      ttsSocket
    ] = await Promise.all([

      stt(),

      tts()

    ]);


    if (
      call.destroyed
    ) {

      close(
        sttSocket
      );

      close(
        ttsSocket
      );

      return;

    }


    call.stt =
      sttSocket;

    call.tts =
      ttsSocket;


    console.log(
      `[${call.id}] DEEPGRAM READY`
    );


    // ========================================================
    // STT
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


          const text =
            clean(

              message
                ?.channel
                ?.alternatives?.[0]
                ?.transcript ||
              ""

            );


          if (!text) {

            return;

          }


          // --------------------------------------------------
          // INTERIM
          // --------------------------------------------------

          if (
            !message.is_final
          ) {

            call.lastInterim =
              text;


            // ------------------------------------------------
            // NATURAL BARGE-IN
            // ------------------------------------------------

            if (
              call.aiSpeaking &&
              text.length >= 3
            ) {

              interrupt(
                call,
                "caller speech"
              );

            }


            return;

          }


          // --------------------------------------------------
          // FINAL
          // --------------------------------------------------

          call.parts.push(
            text
          );


          call.lastInterim =
            "";


          if (
            message.speech_final
          ) {

            const question =
              clean(
                call.parts.join(
                  " "
                )
              );


            call.parts =
              [];


            if (
              question
            ) {

              enqueue(
                call,
                question
              );

            }

          }

        } catch (
          error
        ) {

          console.log(

            `[${call.id}] STT MESSAGE ERROR: ${error.message}`

          );

        }

      }
    );


    // ========================================================
    // TTS
    // ========================================================

    ttsSocket.on(
      "message",
      (
        data,
        isBinary
      ) => {

        if (
          call.destroyed
        ) {

          return;

        }


        // ----------------------------------------------------
        // AUDIO
        // ----------------------------------------------------

        if (
          isBinary ||
          Buffer.isBuffer(data)
        ) {

          if (
            data.length
          ) {

            call.audio.add(
              Buffer.from(
                data
              )
            );

          }


          return;

        }


        // ----------------------------------------------------
        // JSON
        // ----------------------------------------------------

        try {

          const message =
            JSON.parse(
              data.toString()
            );


          if (
            message.type ===
            "Flushed"
          ) {

            const generation =
              call.generation;


            const drain =
              () => {

                if (
                  call.destroyed
                ) {

                  return;

                }


                if (
                  !call.audio.pending()
                ) {

                  if (
                    call.generation ===
                    generation
                  ) {

                    call.aiSpeaking =
                      false;

                  }


                  // ------------------------------------------
                  // GOODBYE
                  // ------------------------------------------

                  if (
                    call.endAfterGoodbye
                  ) {

                    setTimeout(

                      () => {

                        if (
                          !call.destroyed
                        ) {

                          try {

                            call.ws.close();

                          } catch {}

                        }

                      },

                      300

                    );

                  }


                  return;

                }


                setTimeout(
                  drain,
                  25
                );

              };


            drain();

          }

        } catch {}

      }
    );


    // ========================================================
    // SOCKET ERRORS
    // ========================================================

    sttSocket.on(
      "error",
      error => {

        console.log(

          `[${call.id}] STT ERROR: ${error.message}`

        );

      }
    );


    ttsSocket.on(
      "error",
      error => {

        console.log(

          `[${call.id}] TTS ERROR: ${error.message}`

        );

      }
    );

  } catch (
    error
  ) {

    console.log(

      `[${call.id}] DEEPGRAM SETUP ERROR: ${error.message}`

    );

  }

}


// ============================================================
// QUESTION QUEUE
// ============================================================

function enqueue(
  call,
  question
) {

  if (
    call.destroyed
  ) {

    return;

  }


  if (
    call.aiSpeaking
  ) {

    interrupt(
      call,
      "caller started speaking"
    );

  }


  if (
    call.queue[0]?.toLowerCase() ===
    question.toLowerCase()
  ) {

    return;

  }


  call.queue.unshift(
    question
  );


  runQueue(
    call
  );

}


// ============================================================
// RUN QUEUE
// ============================================================

async function runQueue(
  call
) {

  if (
    call.running ||
    call.destroyed
  ) {

    return;

  }


  call.running =
    true;


  try {

    while (
      call.queue.length &&
      !call.destroyed
    ) {

      const question =
        call.queue.shift();


      await processQuestion(
        call,
        question
      );

    }

  } finally {

    call.running =
      false;

  }

}


// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (
      req,
      res
    ) => {

      res.writeHead(
        200,
        {
          "Content-Type":
            "application/json"
        }
      );


      res.end(

        JSON.stringify({

          status:
            "ok",

          service:
            "hm-human-voice-assistant",

          websocket:
            WS_URL,

          activeCalls:
            calls.size,

          products:
            products.length,

          orders:
            orders.length

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
// EXOTEL CONNECTION
// ============================================================

wss.on(
  "connection",
  ws => {

    const call =
      newCall(
        ws
      );


    calls.set(
      call.id,
      call
    );


    console.log(

      `[${call.id}] EXOTEL CONNECTED. ACTIVE: ${calls.size}`

    );


    // Start Deepgram immediately.

    setup(
      call
    );


    // ========================================================
    // EXOTEL MESSAGES
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


          // --------------------------------------------------
          // CONNECTED
          // --------------------------------------------------

          if (
            event ===
            "connected"
          ) {

            return;

          }


          // --------------------------------------------------
          // START
          // --------------------------------------------------

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


            const phone =
              message
                .start
                ?.custom_parameters
                ?.phone ||
              message
                .start
                ?.customParameters
                ?.phone;


            if (
              phone
            ) {

              const found =
                Object.values(
                  customers
                ).find(
                  c =>
                    c.phone ===
                    phone
                );


              if (
                found
              ) {

                call.customerId =
                  found.id;

              }

            }


            console.log(

              `[${call.id}] CALL START ${call.callSid}`

            );


            // ------------------------------------------------
            // GREETING
            // ------------------------------------------------

            const greet =
              () => {

                if (
                  call.destroyed ||
                  call.greeted
                ) {

                  return;

                }


                if (
                  call.tts?.readyState ===
                  WebSocket.OPEN
                ) {

                  call.greeted =
                    true;


                  call.aiSpeaking =
                    true;


                  const greeting =
                    "Hi, welcome to H and M. " +
                    "I can help you find products, colours and sizes, " +
                    "manage your cart, check orders and tracking, " +
                    "handle returns, and help with stores. " +
                    "What would you like to purchase or do today?";


                  speak(

                    call,

                    greeting,

                    call.generation

                  );


                  flush(
                    call
                  );


                } else {

                  setTimeout(
                    greet,
                    40
                  );

                }

              };


            greet();


            return;

          }


          // --------------------------------------------------
          // MEDIA
          // --------------------------------------------------

          if (
            event ===
            "media"
          ) {

            const payload =
              message
                .media
                ?.payload;


            if (
              payload &&
              call.stt?.readyState ===
              WebSocket.OPEN
            ) {

              try {

                call.stt.send(

                  Buffer.from(
                    payload,
                    "base64"
                  )

                );

              } catch {}

            }


            return;

          }


          // --------------------------------------------------
          // STOP
          // --------------------------------------------------

          if (
            event ===
            "stop"
          ) {

            destroy(
              call
            );

            return;

          }


          // --------------------------------------------------
          // CLEAR
          // --------------------------------------------------

          if (
            event ===
            "clear"
          ) {

            call.parts =
              [];

            call.lastInterim =
              "";

            return;

          }

        } catch (
          error
        ) {

          console.log(

            `[${call.id}] EXOTEL ERROR: ${error.message}`

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

        destroy(
          call
        );

      }
    );


    // ========================================================
    // WEBSOCKET ERROR
    // ========================================================

    ws.on(
      "error",
      () => {

        destroy(
          call
        );

      }
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
      "========================================"
    );

    console.log(
      "H&M HUMAN-LIKE AI VOICE ASSISTANT"
    );

    console.log(
      "========================================"
    );

    console.log(
      "GROQ:",
      GROQ_MODEL
    );

    console.log(
      "STT:",
      STT_MODEL
    );

    console.log(
      "TTS:",
      TTS_MODEL
    );

    console.log(
      "PRODUCTS:",
      products.length
    );

    console.log(
      "ORDERS:",
      orders.length
    );

    console.log(
      "TAVILY:",
      TAVILY_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "WS:",
      WS_URL
    );

    console.log(
      "========================================"
    );

  }
);
