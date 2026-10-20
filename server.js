// Bot czyta czat Michu_HM i zapisuje wyniki z wiadomości StreamElements do Supabase
const http = require("http");
const WebSocket = require("ws");

const CHANNEL = (process.env.CHANNEL || "michu_hm").toLowerCase();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const BOT = "streamelements";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Ustaw zmienne SUPABASE_URL i SUPABASE_SECRET_KEY");
  process.exit(1);
}

function parse(msg) {
  msg = msg.replace(/\u0001ACTION |\u0001/g, "").trim();
  let m;
  if ((m = msg.match(/^@?(\S+) won (\d+) Punkty in roulette/i))) return { username: m[1], amount: +m[2], game: "roulette" };
  if ((m = msg.match(/^@?(\S+) lost (\d+) Punkty in roulette/i))) return { username: m[1], amount: -m[2], game: "roulette" };
  if ((m = msg.match(/^@?(\S+) went all in and lost every single one of their (\d+) Punkty/i))) return { username: m[1], amount: -m[2], game: "roulette" };
  if ((m = msg.match(/^@?(\S+),? you got .*?(WYGRAŁEŚ|PRZEGRAŁEŚ)\s+(\d+)\s+Punkty/i)))
    return { username: m[1], amount: m[2].toUpperCase() === "WYGRAŁEŚ" ? +m[3] : -m[3], game: "slots" };
  return null;
}

// ---- Zapis do Supabase (kolejka z ponawianiem) ----
const queue = [];
let sending = false;
async function flush() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const batch = queue.slice(0, 50);
    try {
      const res = await fetch(SUPABASE_URL + "/rest/v1/bets", {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(res.status + " " + (await res.text()));
      queue.splice(0, batch.length);
    } catch (e) {
      console.error("Błąd zapisu, ponawiam za 5 s:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  sending = false;
}
function record(r) {
  console.log(r.username, r.amount, r.game);
  queue.push(r);
  flush();
}

// ---- Twitch IRC (anonimowo) ----
function connect() {
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.on("open", () => {
    ws.send("NICK justinfan" + Math.floor(10000 + Math.random() * 89999));
    ws.send("JOIN #" + CHANNEL);
    console.log("Połączono z #" + CHANNEL);
  });
  ws.on("message", (buf) => {
    buf.toString().split("\r\n").forEach((line) => {
      if (line.startsWith("PING")) return ws.send("PONG :tmi.twitch.tv");
      const m = line.match(/^:(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
      if (!m || m[1].toLowerCase() !== BOT) return;
      const r = parse(m[2]);
      if (r) record(r);
    });
  });
  ws.on("close", () => { console.log("Rozłączono, ponawiam za 3 s"); setTimeout(connect, 3000); });
  ws.on("error", () => ws.close());
}
connect();

// Prosty endpoint zdrowia (wymagany przez część hostingów)
http.createServer((req, res) => res.end("ok")).listen(PORT);
