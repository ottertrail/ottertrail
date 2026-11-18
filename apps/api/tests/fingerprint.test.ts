import { describe, expect, test } from "vite-plus/test";

import {
  fingerprint,
  FINGERPRINT_PATTERN,
  normalizeFile,
  normalizeMessage,
  parseServerStack,
  parseStack,
} from "../src/errors/fingerprint.ts";

const CHROME = `TypeError: Cannot read properties of undefined (reading 'total')
    at renderCart (https://shop.example/assets/index-BfK3x9A2.js:1:2345)
    at async loadCart (https://shop.example/assets/index-BfK3x9A2.js:1:999)
    at new Widget (https://shop.example/assets/widget.js?v=3:10:5)
    at https://shop.example/assets/index-BfK3x9A2.js:2:1
    at Array.forEach (<anonymous>)`;

const FIREFOX = `renderCart@https://shop.example/assets/index-BfK3x9A2.js:1:2345
loadCart@https://shop.example/assets/index-BfK3x9A2.js:1:999
@https://shop.example/assets/index-BfK3x9A2.js:2:1`;

const SAFARI = `renderCart@https://shop.example/assets/index-BfK3x9A2.js:1:2345
global code@https://shop.example/:12:3`;

/** A Python traceback whose message has "@" and a path, which the Firefox format would take for a frame. */
const pythonTraceback = (file: string) => `Traceback (most recent call last):
  File "${file}", line 12, in connect
    conn = psycopg.connect(DSN)
psycopg.OperationalError: connection failed: postgresql://app@/shop?host=/var/run/postgresql`;

const pythonError = (file: string) => ({
  type: "psycopg.OperationalError",
  message: "connection failed",
  stack: pythonTraceback(file),
});

describe("parseStack", () => {
  test("reads V8's frames, named, anonymous, async, and constructors", () => {
    expect(parseStack(CHROME)).toEqual([
      {
        function: "renderCart",
        file: "https://shop.example/assets/index-BfK3x9A2.js",
        line: 1,
        column: 2345,
      },
      {
        function: "loadCart",
        file: "https://shop.example/assets/index-BfK3x9A2.js",
        line: 1,
        column: 999,
      },
      {
        function: "Widget",
        file: "https://shop.example/assets/widget.js?v=3",
        line: 10,
        column: 5,
      },
      { function: "", file: "https://shop.example/assets/index-BfK3x9A2.js", line: 2, column: 1 },
      { function: "Array.forEach", file: "<anonymous>", line: null, column: null },
    ]);
  });

  test("reads Firefox's and Safari's frames", () => {
    expect(parseStack(FIREFOX).map((frame) => frame.function)).toEqual([
      "renderCart",
      "loadCart",
      "",
    ]);
    expect(parseStack(SAFARI)[1]).toEqual({
      function: "global code",
      file: "https://shop.example/",
      line: 12,
      column: 3,
    });
  });

  test("never takes V8's first line for a frame, even with an @ in the message", () => {
    const stack = `Error: No account for alice@example.com
    at signIn (https://shop.example/assets/index-BfK3x9A2.js:1:10)`;
    expect(parseStack(stack)).toMatchObject([{ function: "signIn", line: 1, column: 10 }]);
    const other = stack.replace("alice@example.com", "bob@example.org");
    expect(fingerprint({ type: "Error", message: "No account for alice@example.com", stack })).toBe(
      fingerprint({ type: "Error", message: "No account for alice@example.com", stack: other }),
    );
  });

  test.each([
    ["at " + " (".repeat(7990) + "\u2028x", "V8 frames that never close"],
    ["@".repeat(15_990) + "\u2028x", "a line of @"],
    ["at https://a.example/" + "_1".repeat(7980), "a file name like a content hash"],
    ["at https://a.example/x" + ":1".repeat(7990), "endless line numbers"],
    [("at f (https://a.example/" + "a".repeat(990) + ")\n").repeat(16), "long frames"],
  ])("reads a hostile 16,000-character stack quickly: %#, %s", (stack, _label) => {
    const started = performance.now();
    fingerprint({ type: "Error", message: "x", stack });
    expect(performance.now() - started).toBeLessThan(20);
  });

  test.each([
    [("at a" + " ".repeat(990) + "b\n").repeat(16), "JVM frames with long runs of spaces"],
    [("at a" + " [".repeat(495) + "\n").repeat(16), "JVM frames of unclosed jars"],
    [("/a.rb:1" + ":in ".repeat(245) + "\n").repeat(16), "Ruby frames of repeated :in"],
    [("\t/a" + ".go:".repeat(245) + "\n").repeat(16), "Go locations of repeated .go:"],
    [("at a()" + " in ".repeat(245) + "\n").repeat(16), ".NET frames of repeated in"],
    [('  File "' + '"'.repeat(980) + "\n").repeat(16), "Python frames of quotes"],
  ])("reads a hostile server stack in linear time: %#, %s", (stack, _label) => {
    // A hundred in a row: work that grows with the square of a line's
    // length takes the better part of a second, linear work milliseconds.
    const started = performance.now();
    for (let i = 0; i < 100; i += 1) {
      fingerprint({ type: "Error", message: "x", stack }, { server: i % 2 === 0 });
    }
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("a server's stack is read in the server formats first", () => {
    expect(fingerprint(pythonError("/app/a.py"), { server: true })).not.toBe(
      fingerprint(pythonError("/app/b.py"), { server: true }),
    );
  });

  test("finds no frames in text that has none", () => {
    expect(parseStack("")).toEqual([]);
    expect(parseStack("Error: something\nno frames here")).toEqual([]);
  });
});

describe("normalizeFile", () => {
  test.each([
    ["https://shop.example/assets/index-BfK3x9A2.js", "/assets/index.js", "Vite"],
    ["https://cdn.example/static/js/main.3f2a1c9d.js", "/static/js/main.js", "webpack"],
    [
      "https://shop.example/_next/static/chunks/page-1a2b3c4d5e6f.js",
      "/_next/static/chunks/page.js",
      "Next.js",
    ],
    ["https://shop.example/assets/widget.js?v=3#x", "/assets/widget.js", "query and fragment"],
    [
      "https://shop.example/assets/index-component.js",
      "/assets/index-component.js",
      "a name without digits",
    ],
    ["https://shop.example/app-v2.js", "/app-v2.js", "a short suffix"],
    ["<anonymous>", "<anonymous>", "not a URL"],
  ])("%s → %s (%s)", (file, expected) => {
    expect(normalizeFile(file)).toBe(expected);
  });
});

describe("normalizeMessage", () => {
  test.each([
    ["Order 8f2a7c1e-0d3b-4b8e-9a51-2c6d7e8f9a0b not found", "Order <id> not found"],
    ["Request to https://api.example/v1/orders/123?x=1 failed", "Request to <url> failed"],
    ["Item 48213 is out of stock", "Item <n> is out of stock"],
    ["Token deadbeef42 expired", "Token <id> expired"],
    ["Request failed with status code 404", "Request failed with status code 404"],
    ["  Two\n  lines  ", "Two lines"],
  ])("%j → %j", (message, expected) => {
    expect(normalizeMessage(message)).toBe(expected);
  });
});

describe("fingerprint", () => {
  const base = {
    type: "TypeError",
    message: "Cannot read properties of undefined (reading 'total')",
    stack: CHROME,
  };

  test("is versioned, and matches what the routes accept", () => {
    expect(fingerprint(base)).toMatch(new RegExp(FINGERPRINT_PATTERN));
    expect(fingerprint(base).startsWith("1-")).toBe(true);
  });

  test("stays the same across deploys: new bundle hashes, lines, and function names", () => {
    const redeployed = CHROME.replaceAll("index-BfK3x9A2.js", "index-Zq81LmP0.js")
      .replace("1:2345", "1:8812")
      .replace("renderCart", "a");
    expect(fingerprint({ ...base, stack: redeployed })).toBe(fingerprint(base));
  });

  test("stays the same when only IDs in the message differ", () => {
    const one = { type: "Error", message: "Order 48213 not found", stack: CHROME };
    const other = { type: "Error", message: "Order 99120 not found", stack: CHROME };
    expect(fingerprint(one)).toBe(fingerprint(other));
  });

  test("tells apart another type, another message, or another file", () => {
    const seen = new Set([
      fingerprint(base),
      fingerprint({ ...base, type: "ReferenceError" }),
      fingerprint({ ...base, message: "Cannot read properties of undefined (reading 'items')" }),
      fingerprint({
        ...base,
        stack: CHROME.replace("index-BfK3x9A2.js:1:2345", "checkout.js:1:1"),
      }),
      fingerprint({ ...base, stack: "" }),
    ]);
    expect(seen.size).toBe(5);
  });

  test("is the same for a stack from Firefox as from Safari at the same place", () => {
    const firefox = { type: "TypeError", message: "x is undefined", stack: FIREFOX };
    expect(fingerprint(firefox)).toBe(fingerprint({ ...firefox, stack: SAFARI }));
  });
});

// Servers' stacks, as each language prints them.

const PYTHON = `Traceback (most recent call last):
  File "/srv/shop/payments/views.py", line 41, in charge
    receipt = gateway.charge(order)
              ^^^^^^^^^^^^^^^^^^^^^
  File "/srv/shop/payments/gateway.py", line 88, in charge
    raise CardDeclined(reason)
payments.gateway.CardDeclined: card declined for order 5120`;

const PYTHON_CHAINED = `Traceback (most recent call last):
  File "/srv/shop/inventory/stock.py", line 12, in reserve
    return self.counts[sku] - quantity
           ~~~~~~~~~~~^^^^^
KeyError: 'sku-118'

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/srv/shop/orders/place.py", line 30, in place_order
    stock.reserve(line.sku, line.quantity)
  File "/srv/shop/inventory/stock.py", line 14, in reserve
    raise OutOfStock(sku) from None
inventory.stock.OutOfStock: sku-118`;

const RUBY = `/srv/shop/app/models/cart.rb:23:in \`total': undefined method \`price' for nil (NoMethodError)
\tfrom /srv/shop/app/controllers/carts_controller.rb:9:in \`show'
\tfrom /usr/local/bundle/gems/actionpack-8.0.1/lib/action_controller/metal/basic_implicit_render.rb:8:in \`send_action'`;

const RUBY_34 = `/srv/shop/app/models/cart.rb:23:in 'Cart#total': undefined method 'price' for nil (NoMethodError)
\tfrom /srv/shop/app/controllers/carts_controller.rb:9:in 'CartsController#show'`;

const GO = `goroutine 34 [running]:
runtime/debug.Stack()
\t/usr/local/go/src/runtime/debug/stack.go:26 +0x5e
go.opentelemetry.io/otel/sdk/trace.recordStackTrace()
\t/home/dev/go/pkg/mod/go.opentelemetry.io/otel/sdk@v1.38.0/trace/span.go:512 +0x2b
go.opentelemetry.io/otel/sdk/trace.(*recordingSpan).RecordError(0xc0001a2000, {0x9c4e60, 0xc000212080}, {0xc00011c2a0, 0x1, 0x1})
\t/home/dev/go/pkg/mod/go.opentelemetry.io/otel/sdk@v1.38.0/trace/span.go:478 +0x37a
example.com/shop/payments.(*Gateway).Charge(0xc000126000, {0x9d1b28, 0xc000210000}, 0x1400)
\t/home/dev/shop/payments/gateway.go:88 +0x1d4
main.main()
\t/home/dev/shop/main.go:19 +0x85`;

const JAVA = `java.lang.IllegalStateException: Cart 7731 is empty
\tat com.example.shop.cart.CartService.checkout(CartService.java:88) ~[shop.jar:1.4.2]
\tat com.example.shop.cart.CartController.post(CartController.java:41)
\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)
Caused by: java.lang.NullPointerException: Cannot invoke "Item.price()" because "item" is null
\tat com.example.shop.cart.Cart.total(Cart.java:17)
\t... 12 more`;

const DOTNET = `System.InvalidOperationException: Cart 7731 is empty
   at Shop.Cart.CartService.Checkout(Int32 cartId) in /src/Shop/Cart/CartService.cs:line 88
   at Shop.Cart.CartController.Post(Int32 id) in /src/Shop/Cart/CartController.cs:line 41
   at lambda_method12(Closure, Object, Object[])
--- End of stack trace from previous location ---
   at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.Execute(ActionContext context)`;

const DOTNET_RELEASE = `System.InvalidOperationException: Cart 7731 is empty
   at Shop.Cart.CartService.Checkout(Int32 cartId)
   at Shop.Cart.CartController.Post(Int32 id)`;

describe("parseServerStack", () => {
  test("Python: the frame that raised is the traceback's last", () => {
    expect(parseServerStack(PYTHON)[0]).toEqual({
      function: "charge",
      file: "/srv/shop/payments/gateway.py",
      line: 88,
      column: null,
    });
    // A chained exception: the last traceback is the one raised.
    expect(parseServerStack(PYTHON_CHAINED)[0]).toMatchObject({
      function: "reserve",
      file: "/srv/shop/inventory/stock.py",
      line: 14,
    });
  });

  test("Ruby, with the quotes before and since Ruby 3.4", () => {
    expect(parseServerStack(RUBY)).toMatchObject([
      { function: "total", file: "/srv/shop/app/models/cart.rb", line: 23 },
      { function: "show", file: "/srv/shop/app/controllers/carts_controller.rb", line: 9 },
      { function: "send_action" },
    ]);
    expect(parseServerStack(RUBY_34)[0]).toMatchObject({
      function: "Cart#total",
      file: "/srv/shop/app/models/cart.rb",
    });
  });

  test("Go: past the runtime's and OpenTelemetry's own frames", () => {
    expect(parseServerStack(GO)[0]).toEqual({
      function:
        "example.com/shop/payments.(*Gateway).Charge(0xc000126000, {0x9d1b28, 0xc000210000}, 0x1400)",
      file: "/home/dev/shop/payments/gateway.go",
      line: 88,
      column: null,
    });
  });

  test("Java: the class, without the module or the jar", () => {
    expect(parseServerStack(JAVA)).toMatchObject([
      { function: "checkout", file: "com.example.shop.cart.CartService", line: 88 },
      { function: "post", file: "com.example.shop.cart.CartController", line: 41 },
      { function: "invoke", file: "jdk.internal.reflect.DirectMethodHandleAccessor" },
      { function: "total", file: "com.example.shop.cart.Cart", line: 17 },
    ]);
  });

  test(".NET: the file when the build kept it, else the type", () => {
    expect(parseServerStack(DOTNET)[0]).toEqual({
      function: "Checkout",
      file: "/src/Shop/Cart/CartService.cs",
      line: 88,
      column: null,
    });
    expect(parseServerStack(DOTNET_RELEASE)[0]).toEqual({
      function: "Checkout",
      file: "Shop.Cart.CartService",
      line: null,
      column: null,
    });
  });

  test("the browsers' parser finds no frame in them, so grouping falls back to these", () => {
    for (const stack of [PYTHON, RUBY, GO, JAVA, DOTNET]) {
      expect(parseStack(stack)).toEqual([]);
    }
  });

  test("finds nothing in text that has no frames", () => {
    expect(parseServerStack("")).toEqual([]);
    expect(parseServerStack("Error: something\nno frames here")).toEqual([]);
  });
});

describe("fingerprint of a server's exception", () => {
  test.each([
    ["Python", PYTHON, PYTHON.replace("line 88", "line 90").replace("line 41", "line 45")],
    ["Ruby", RUBY, RUBY.replace("cart.rb:23", "cart.rb:31")],
    ["Go", GO, GO.replace("gateway.go:88 +0x1d4", "gateway.go:97 +0x2a0")],
    ["Java", JAVA, JAVA.replace("CartService.java:88", "CartService.java:93")],
    [".NET", DOTNET, DOTNET.replace("CartService.cs:line 88", "CartService.cs:line 93")],
  ])("%s: groups by the raising frame's file, whatever its line", (_language, stack, moved) => {
    const error = { type: "Error", message: "declined", stack };
    expect(fingerprint({ ...error, stack: moved })).toBe(fingerprint(error));
    // Not as if it had no stack: the file counts.
    expect(fingerprint(error)).not.toBe(fingerprint({ ...error, stack: "" }));
  });

  test("another file is another group", () => {
    const error = { type: "CardDeclined", message: "declined", stack: PYTHON };
    const elsewhere = PYTHON.replace("payments/gateway.py", "payments/stripe.py");
    expect(fingerprint({ ...error, stack: elsewhere })).not.toBe(fingerprint(error));
  });
});

describe("browser fingerprints", () => {
  // As version 1 gave them before servers' stacks were read: they must not change.
  const MESSAGE = "Cannot read properties of undefined (reading 'total')";
  test.each([
    ["V8", CHROME, "1-5c0541ff2bc62316aab6"],
    ["Firefox", FIREFOX, "1-5c0541ff2bc62316aab6"],
    ["Safari", SAFARI, "1-5c0541ff2bc62316aab6"],
    [
      "Node.js",
      `Error: connect ECONNREFUSED 127.0.0.1:5432
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)
    at async Pool.connect (/app/node_modules/pg-pool/index.js:45:11)`,
      "1-2af84fd555fe322e44bd",
    ],
    ["no stack", undefined, "1-969830f75ef9fc1d4792"],
    ["no frames", "Error: something\nno frames here", "1-969830f75ef9fc1d4792"],
  ])("%s", (_engine, stack, expected) => {
    expect(fingerprint({ type: "TypeError", message: MESSAGE, stack })).toBe(expected);
  });
});
