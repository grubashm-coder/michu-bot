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
  // Zamień znaki sterujące i niewidzialne (np. znaczniki Twitcha, twarde spacje) na zwykłe spacje
  msg = msg
    .replace(/[\u0000-\u001f\u007f-\u00a0\u200b-\u200f\u2028-\u202f\u2060-\u206f\u3000\ufeff]|[\u{e0000}-\u{e007f}]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^ACTION /, "")
    .trim();
  // Nick to słowo tuż przed "won"/"lost"; przed nim może stać emotka (np. "PogChamp nick went all in...")
  let m;
  if ((m = msg.match(/(\S+) went all in and won (\d+) Punkty/i))) return { username: m[1].replace(/^@/, ""), amount: +m[2], game: "roulette" };
  if ((m = msg.match(/(\S+) went all in and lost every single one of their (\d+) Punkty/i))) return { username: m[1].replace(/^@/, ""), amount: -m[2], game: "roulette" };
  if ((m = msg.match(/(\S+) won (\d+) Punkty in roulette/i))) return { username: m[1].replace(/^@/, ""), amount: +m[2], game: "roulette" };
  if ((m = msg.match(/(\S+) lost (\d+) Punkty in roulette/i))) return { username: m[1].replace(/^@/, ""), amount: -m[2], game: "roulette" };
  if ((m = msg.match(/^@?(\S+),? you got .*?(WYGRAŁEŚ|PRZEGRAŁEŚ)\s+(\d+)\s+Punkty/i)))
    return { username: m[1], amount: m[2].toUpperCase() === "WYGRAŁEŚ" ? +m[3] : -m[3], game: "slots" };
  return null;
}

// ---- Autotest parsera przy starcie (widać go w logach) ----
const BOT_VERSION = "7-bez-historii";
const SAMPLES = [
  ["imisstherage41 went all in and won 20 Punkty PogChamp they now have 40 Punkty", "imisstherage41", 20],
  ["PogChamp Furemen_ went all in and won 48160 Punkty PogChamp they now have 96320 Punkty", "Furemen_", 48160],
  ["Furemen_ went all in and lost every single one of their 96560 Punkty LUL", "Furemen_", -96560],
  ["19dawid06ctsk went all in and won 10000 Punkty PogChamp they now have 20000 Punkty", "19dawid06ctsk", 10000],
  ["19dawid06ctsk went all in and lost every single one of their 240 Punkty LUL", "19dawid06ctsk", -240],
  ["MrKribek won 10000 Punkty in roulette and now has 816136 Punkty! FeelsGoodMan", "MrKribek", 10000],
  ["wo1tas_ lost 5000 Punkty in roulette and now has 200668 Punkty! FeelsBadMan", "wo1tas_", -5000],
  ["@oliwierfishy you got aha41 | aha41 | aha41 WYGRAŁEŚ 27500 Punkty jestjestjest", "oliwierfishy", 27500],
  ["@oliwierfishy you got aha | ahahepi | aha PRZEGRAŁEŚ 1000 Punkty jasperXD", "oliwierfishy", -1000],
];
const testOk = SAMPLES.every(([t, u, a]) => { const r = parse(t); return r && r.username === u && r.amount === a; });
console.log("Wersja bota:", BOT_VERSION, "| autotest parsera:", testOk ? "OK" : "BŁĄD");

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
      if (process.env.DEBUG_ALL) console.log("SE:", m[2]);
      const r = parse(m[2]);
      if (r) record(r);
      else if (/Punkty/i.test(m[2])) {
        const vis = m[2].replace(/[\u0000-\u001f\u007f-\u00a0\u200b-\u200f\u2028-\u202f\u2060-\u206f\u3000\ufeff]|[\u{e0000}-\u{e007f}]/gu, (c) => "<U+" + c.codePointAt(0).toString(16) + ">");
        console.log("NIEROZPOZNANA wiadomość StreamElements:", vis);
      }
    });
  });
  ws.on("close", () => { console.log("Rozłączono, ponawiam za 3 s"); setTimeout(connect, 3000); });
  ws.on("error", () => ws.close());
}
connect();

// Prosty endpoint zdrowia (wymagany przez część hostingów)
http.createServer((req, res) => res.end("ok")).listen(PORT);
