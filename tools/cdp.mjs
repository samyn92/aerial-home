// Minimal Chrome DevTools Protocol client for the TV's web inspector (port 9998).
// Usage:
//   node cdp.mjs <titleMatch> shot <out.png>
//   node cdp.mjs <titleMatch> eval '<js expression>'
//   node cdp.mjs <titleMatch> reload
import { readFileSync, writeFileSync } from "node:fs";

const HOST = process.env.TV_HOST;
if (!HOST) {
  console.error("set TV_HOST=<tv-address>:9998");
  process.exit(1);
}
const [, , match, cmd, arg] = process.argv;
setTimeout(() => {
  console.error("timeout after 25s");
  process.exit(2);
}, 25000).unref();

const targets = await (await fetch(`http://${HOST}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.title.toLowerCase().includes(match.toLowerCase()));
if (!target) {
  console.error("no page matching", match, "->", targets.map((t) => t.title));
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
await new Promise((r) => (ws.onopen = r));

try {
  if (cmd === "shot") {
    await send("Page.enable"); const res = await send("Page.captureScreenshot", { format: "jpeg", quality: 70, fromSurface: true });
    if (!res.result) throw new Error(JSON.stringify(res.error));
    writeFileSync(arg, Buffer.from(res.result.data, "base64"));
    console.log("saved", arg);
  } else if (cmd === "shot-alpha") {
    // UI layer only, with transparent page background (the video plane is not capturable).
    await send("Page.enable");
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    const res = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await send("Emulation.setDefaultBackgroundColorOverride", {});
    if (!res.result) throw new Error(JSON.stringify(res.error));
    writeFileSync(arg, Buffer.from(res.result.data, "base64"));
    console.log("saved", arg);
  } else if (cmd === "key") {
    // Press a key by keyCode, e.g. 38 (up), 13 (OK), 461 (back).
    const code = Number(arg);
    for (const type of ["rawKeyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    }
    console.log("pressed", code);
  } else if (cmd === "mouse") {
    // Move the pointer to "x,y" (CSS px) without clicking.
    const [x, y] = arg.split(",").map(Number);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    console.log("moved", x, y);
  } else if (cmd === "eval" || cmd === "evalfile") {
    const expression = cmd === "evalfile" ? readFileSync(arg, "utf8") : arg;
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    console.log(JSON.stringify(res.result?.result?.value ?? res.result ?? res.error, null, 2));
  } else if (cmd === "reload") {
    await send("Page.reload", { ignoreCache: true });
    console.log("reloaded", target.title);
  }
} finally {
  ws.close();
}
