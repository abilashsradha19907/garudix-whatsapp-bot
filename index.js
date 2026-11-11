
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  getContentType
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Sticker } from "wa-sticker-formatter";

// =============================================
// GARUDIX ULTIMATE CONFIGURATION
// =============================================

const BOT_NAME = "GARUDIX";
const OWNER_NAME = "ABILASH";

// Country code + number. No + or spaces.
const OWNER_NUMBER = "919409081149";

const PREFIX = "..";
const VERSION = "2.1";

const STICKER_PACK = "ABILASH";
const STICKER_AUTHOR = "ABILASH | GARUDIX";

const ABOUT_GIF_PATH = "./assets/garudix-about.gif";

const START_TIME = Date.now();

let commandCount = 0;
let messageCount = 0;

const groupSettings = new Map();
const userWarnings = new Map();

const logger = pino({ level: "silent" });

// =============================================
// OWNER VERIFICATION - FIXED
// =============================================


function normalizeJidNumber(jid) {
  if (!jid) return "";

  return jid
    .split(":")[0]
    .split("@")[0]
    .replace(/\D/g, "");
}

function isOwner(msg, sock) {
  const key = msg.key || {};
  const ownerNumber = OWNER_NUMBER.replace(/\D/g, "");

  const senderIds = [
    key.participantAlt,
    key.remoteJidAlt,
    key.participant,
    key.remoteJid
  ];

  return senderIds.some(
    id => normalizeJidNumber(id) === ownerNumber
  );
}


// =============================================
// BASIC HELPERS
// =============================================

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function getText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

function getQuoted(msg) {
  const context =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo;

  if (!context?.quotedMessage) return null;

  return {
    context,
    message: context.quotedMessage
  };
}

async function sendText(sock, jid, text, quoted) {
  return sock.sendMessage(
    jid,
    { text },
    quoted ? { quoted } : {}
  );
}

async function downloadMessage(sock, msg) {
  return downloadMediaMessage(
    msg,
    "buffer",
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage
    }
  );
}

async function downloadQuoted(sock, msg) {
  const quoted = getQuoted(msg);

  if (!quoted) {
    throw new Error("Reply to a media message.");
  }

  const fakeMessage = {
    key: {
      remoteJid: msg.key.remoteJid,
      id: quoted.context.stanzaId,
      participant: quoted.context.participant,
      fromMe: false
    },
    message: quoted.message
  };

  return downloadMessage(sock, fakeMessage);
}

// =============================================
// FFMPEG HELPER
// =============================================

async function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args);

    let errorText = "";

    process.stderr.on("data", data => {
      errorText += data.toString();
    });

    process.on("error", reject);

    process.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            errorText.slice(-1500) || "FFmpeg failed"
          )
        );
      }
    });
  });
}

async function withTempFolder(callback) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "garudix-")
  );

  try {
    return await callback(folder);
  } finally {
    await fs.rm(folder, {
      recursive: true,
      force: true
    });
  }
}

async function convertMedia(
  buffer,
  inputName,
  outputName,
  args
) {
  return withTempFolder(async folder => {
    const input = path.join(folder, inputName);
    const output = path.join(folder, outputName);

    await fs.writeFile(input, buffer);

    await runFFmpeg([
      "-y",
      "-i", input,
      ...args,
      output
    ]);

    return fs.readFile(output);
  });
}

// =============================================
// STICKER STUDIO
// =============================================

async function createSticker(
  buffer,
  quality = 75,
  pack = STICKER_PACK,
  author = STICKER_AUTHOR
) {
  const sticker = new Sticker(buffer, {
    pack,
    author,
    quality
  });

  return sticker.toBuffer();
}

async function videoToSticker(buffer) {
  return convertMedia(
    buffer,
    "input.mp4",
    "sticker.webp",
    [
      "-t", "5",
      "-vf",
      "fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p",
      "-an",
      "-loop", "0",
      "-c:v", "libwebp_anim",
      "-quality", "45",
      "-compression_level", "6"
    ]
  );
}

async function stickerToPng(buffer) {
  return convertMedia(
    buffer,
    "input.webp",
    "output.png",
    ["-frames:v", "1"]
  );
}

async function aboutVideo() {
  const gif = await fs.readFile(ABOUT_GIF_PATH);

  return convertMedia(
    gif,
    "about.gif",
    "about.mp4",
    [
      "-t", "10",
      "-vf",
      "fps=20,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-movflags", "+faststart"
    ]
  );
}

// =============================================
// SAFE CALCULATOR
// =============================================

function calculate(expression) {
  const tokens = expression.match(
    /\d+(?:\.\d+)?|[()+\-*/%]/g
  );

  if (
    !tokens ||
    tokens.join("") !== expression.replace(/\s/g, "")
  ) {
    throw new Error("Invalid calculation.");
  }

  let index = 0;

  function primary() {
    const token = tokens[index++];

    if (token === "+") return primary();
    if (token === "-") return -primary();

    if (token === "(") {
      const value = addSub();

      if (tokens[index++] !== ")") {
        throw new Error("Missing closing bracket.");
      }

      return value;
    }

    const number = Number(token);

    if (!Number.isFinite(number)) {
      throw new Error("Invalid number.");
    }

    return number;
  }

  function mulDiv() {
    let value = primary();

    while (
      ["*", "/", "%"].includes(tokens[index])
    ) {
      const operator = tokens[index++];
      const right = primary();

      if (
        right === 0 &&
        (operator === "/" || operator === "%")
      ) {
        throw new Error("Cannot divide by zero.");
      }

      if (operator === "*") value *= right;
      if (operator === "/") value /= right;
      if (operator === "%") value %= right;
    }

    return value;
  }

  function addSub() {
    let value = mulDiv();

    while (
      tokens[index] === "+" ||
      tokens[index] === "-"
    ) {
      const operator = tokens[index++];
      const right = mulDiv();

      value =
        operator === "+"
          ? value + right
          : value - right;
    }

    return value;
  }

  const result = addSub();

  if (
    index !== tokens.length ||
    !Number.isFinite(result)
  ) {
    throw new Error("Invalid expression.");
  }

  return result;
}

// =============================================
// GROUP HELPERS
// =============================================


// =============================================
// PERSISTENT GROUP DATA + REMINDERS
// =============================================

const GROUP_DATA_PATH = path.join(process.cwd(), "garudix-group-data.json");
const reminderTimers = new Map();
const spamTracker = new Map();
let groupData = { settings: {}, rules: {}, reminders: [] };

async function saveGroupData() {
  const tempPath = GROUP_DATA_PATH + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(groupData, null, 2), "utf8");
  await fs.rename(tempPath, GROUP_DATA_PATH);
}

async function loadGroupData() {
  try {
    const raw = await fs.readFile(GROUP_DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    groupData = {
      settings: parsed.settings || {},
      rules: parsed.rules || {},
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("GARUDIX group data load error:", error.message);
    }
    groupData = { settings: {}, rules: {}, reminders: [] };
  }

  groupSettings.clear();
  for (const [jid, settings] of Object.entries(groupData.settings)) {
    groupSettings.set(jid, settings);
  }
}

function scheduleReminder(sock, reminder) {
  if (reminderTimers.has(reminder.id)) return;
  const delay = reminder.when - Date.now();

  if (delay <= 0) {
    reminderTimers.set(reminder.id, setTimeout(async () => {
      try {
        await sendText(sock, reminder.jid, `⏰ REMINDER\n\n${reminder.message}\n\n🦅 GARUDIX`);
      } catch (error) {
        console.error("GARUDIX reminder send error:", error.message);
      } finally {
        reminderTimers.delete(reminder.id);
        groupData.reminders = groupData.reminders.filter(item => item.id !== reminder.id);
        await saveGroupData().catch(console.error);
      }
    }, 0));
    return;
  }

  reminderTimers.set(reminder.id, setTimeout(async () => {
    try {
      await sendText(sock, reminder.jid, `⏰ REMINDER\n\n${reminder.message}\n\n🦅 GARUDIX`);
    } catch (error) {
      console.error("GARUDIX reminder send error:", error.message);
    } finally {
      reminderTimers.delete(reminder.id);
      groupData.reminders = groupData.reminders.filter(item => item.id !== reminder.id);
      await saveGroupData().catch(console.error);
    }
  }, Math.min(delay, 2147483647)));
}

function syncGroupSettingsToDisk(jid) {
  groupData.settings[jid] = getGroupSetting(jid);
  return saveGroupData();
}

function getGroupSetting(jid) {
  if (!groupSettings.has(jid)) {
    groupSettings.set(jid, {
      antilink: false,
      welcome: true,
      goodbye: true,
      antispam: false,
      ...(groupData.settings[jid] || {})
    });
  }

  return groupSettings.get(jid);
}


function normalizeAdminId(id) {
  if (!id) return "";

  return id
    .replace(/:\d+(?=@)/, "")
    .toLowerCase();
}

async function getGroupAdmins(sock, jid) {
  const metadata = await sock.groupMetadata(jid);

  const admins = metadata.participants
    .filter(p =>
      p.admin === "admin" ||
      p.admin === "superadmin"
    )
    .flatMap(p => [
      p.id,
      p.lid,
      p.phoneNumber
    ])
    .map(normalizeAdminId)
    .filter(Boolean);

  return { metadata, admins };
}

async function checkGroupAdmin(sock, msg) {
  const jid = msg.key.remoteJid;

  if (!jid.endsWith("@g.us")) {
    throw new Error("This command works only in groups.");
  }

  const { admins } = await getGroupAdmins(sock, jid);

  const senderIds = msg.key.fromMe
    ? [sock.user.id, sock.user.lid, sock.user.phoneNumber]
    : [msg.key.participant, msg.key.participantAlt];

  const senderIsAdmin = senderIds
    .filter(Boolean)
    .map(normalizeAdminId)
    .some(id => admins.includes(id));

  const botIds = [
    sock.user.id,
    sock.user.lid,
    sock.user.phoneNumber
  ];
  console.log("GARUDIX ADMIN DEBUG:", {
  botId: sock.user.id,
  botLid: sock.user.lid,
  botPhone: sock.user.phoneNumber,
  groupAdminIds: admins
});

  const botIsAdmin = botIds
    .filter(Boolean)
    .map(normalizeAdminId)
    .some(id => admins.includes(id));

  if (!senderIsAdmin) {
    throw new Error("Only group admins can use this command.");
  }

  if (!botIsAdmin) {
    throw new Error("Make GARUDIX a group admin first.");
  }
}
 

// =============================================
// WEATHER - OPEN-METEO
// =============================================

async function getWeather(city) {
  const geoUrl =
    "https://geocoding-api.open-meteo.com/v1/search?name=" +
    encodeURIComponent(city) +
    "&count=1&language=en&format=json";

  const geoResponse = await fetch(geoUrl);

  if (!geoResponse.ok) {
    throw new Error("Weather service unavailable.");
  }

  const geo = await geoResponse.json();
  const place = geo.results?.[0];

  if (!place) {
    throw new Error("City not found.");
  }

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}` +
    `&longitude=${place.longitude}` +
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m";

  const response = await fetch(weatherUrl);

  if (!response.ok) {
    throw new Error("Weather service unavailable.");
  }

  const data = await response.json();
  const current = data.current;

  return `🌤️ WEATHER REPORT

📍 ${place.name}, ${place.country}
🌡️ Temperature: ${current.temperature_2m}°C
🤗 Feels like: ${current.apparent_temperature}°C
💧 Humidity: ${current.relative_humidity_2m}%
💨 Wind: ${current.wind_speed_10m} km/h

🦅 GARUDIX`;
}

// =============================================
// BUILT-IN FREE ASSISTANT
// =============================================

function freeAssistant(question) {
  const q = question.toLowerCase().trim();

  if (!q) {
    return "Ask me something after ..ai";
  }

  if (/\b(hi|hello|hey|hai)\b/.test(q)) {
    return "Hello! 🦅 I am GARUDIX. How can I help you?";
  }

  if (q.includes("who are you")) {
    return "I am GARUDIX, a lightweight WhatsApp assistant created by ABILASH.";
  }

  if (q.includes("time")) {
    return "Current time: " +
      new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata"
      });
  }

  if (q.includes("help")) {
    return "I can help with basic commands, calculations, media conversion and utilities. Use ..menu to see commands.";
  }

  return `🦅 GARUDIX FREE ASSISTANT

I can answer a few built-in questions.

Advanced AI chat requires an AI model or API. This lightweight edition does not connect to a paid AI service.

Try ..menu for available commands.`;
}

// =============================================
// WINDOWS TEXT TO SPEECH
// =============================================

async function textToSpeech(text) {
  return withTempFolder(async folder => {
    const output = path.join(folder, "speech.wav");

    const safeText = text
      .replace(/'/g, "''")
      .slice(0, 700);

    const script = `
      Add-Type -AssemblyName System.Speech
      $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $speaker.SetOutputToWaveFile('${output.replace(/\\/g, "\\\\")}')
      $speaker.Speak('${safeText}')
      $speaker.Dispose()
    `;

    await new Promise((resolve, reject) => {
      const ps = spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script
      ]);

      let error = "";

      ps.stderr.on("data", d => {
        error += d.toString();
      });

      ps.on("error", reject);

      ps.on("close", code => {
        if (code === 0) resolve();
        else reject(
          new Error(error || "Windows TTS failed.")
        );
      });
    });

    return fs.readFile(output);
  });
}

// =============================================
// START GARUDIX
// =============================================

async function startGarudix() {
  await loadGroupData();
  const { state, saveCreds } =
    await useMultiFileAuthState("./session");

  const sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async update => {
    const {
      connection,
      lastDisconnect,
      qr
    } = update;

    if (qr) {
     await QRCode.toFile("./garudix-qr.png", qr, {
    width: 500,
    margin: 4,
    errorCorrectionLevel: "L"
});
console.log("GARUDIX QR image saved: garudix-qr.png");
    }

    if (connection === "open") {
      console.log("🦅 GARUDIX CONNECTED SUCCESSFULLY!");
      console.log("Owner number:", OWNER_NUMBER);
      for (const reminder of groupData.reminders) {
        scheduleReminder(sock, reminder);
      }
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        console.log("GARUDIX reconnecting in 5 seconds...");
        await sleep(5000);
        startGarudix().catch(console.error);
      } else {
        console.log("GARUDIX logged out. Scan QR again.");
      }
    }
  });

  // =============================================
  // WELCOME / GOODBYE
  // =============================================

  sock.ev.on(
    "group-participants.update",
    async update => {
      console.log("GARUDIX GROUP EVENT:", update.action, update.id, update.participants);
      try {
        const settings = getGroupSetting(update.id);

        for (const participant of update.participants) {
          const participantJid =
  typeof participant === "string"
    ? participant
    : participant?.id || participant?.jid || participant?.phoneNumber || participant?.lid;

if (!participantJid) continue;
          if (
            update.action === "add" &&
            settings.welcome
          ) {
            await sock.sendMessage(update.id, {
               text: `👋 Welcome to the group!\n\n@${participantJid.split("@")[0]}\n\nPowered by GARUDIX`,
              mentions: [participantJid]
            });
          }

          if (
            update.action === "remove" &&
            settings.goodbye
          ) {
            await sock.sendMessage(update.id, {
              text:
                `👋 Goodbye @${participantJid.split("@")[0]}
              mentions: [participantJid]
            });
          }
        }
      } catch (error) {
        console.log("Group event:", error.message);
      }
    }
  );

  // =============================================
  // MESSAGE HANDLER
  // =============================================

  sock.ev.on(
    "messages.upsert",
    async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          // IMPORTANT:
          // Do not skip fromMe here.
          // Owner commands from the bot's own account
          // must be allowed through owner verification.

          if (!msg.message) continue;

          const jid = msg.key.remoteJid;

          if (!jid || jid === "status@broadcast") {
            continue;
          }

          messageCount++;

          const message = msg.message;
          const contentType = getContentType(message);
          const body = getText(message).trim();

          // =====================================
          // ANTI-LINK
          // =====================================

          if (
            jid.endsWith("@g.us") &&
            !msg.key.fromMe
          ) {
            const settings = getGroupSetting(jid);

            if (
              settings.antilink &&
              /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(body)
            ) {
              const { admins } =
                await getGroupAdmins(sock, jid);

              const sender = normalizeAdminId(msg.key.participant);

              if (!admins.includes(sender)) {
                const botJid =
                  sock.user.id.split(":")[0] +
                  "@s.whatsapp.net";

                if (admins.includes(botJid)) {
                  await sock.sendMessage(jid, {
                    delete: msg.key
                  });

                  await sendText(
                    sock,
                    jid,
                    "🚫 Links are disabled in this group."
                  );
                } else {
                  await sendText(
                    sock,
                    jid,
                    "⚠️ Please make GARUDIX an admin to enable anti-link deletion."
                  );
                }

                continue;
              }
            }
          }


          // =====================================
          // ANTI-SPAM (GROUPS)
          // =====================================

          if (
            jid.endsWith("@g.us") &&
            !msg.key.fromMe &&
            !body.startsWith(PREFIX)
          ) {
            const settings = getGroupSetting(jid);
            if (settings.antispam) {
              const { admins } = await getGroupAdmins(sock, jid);
             const sender = normalizeAdminId(msg.key.participant);
              if (sender && !admins.includes(sender)) {
                const now = Date.now();
                const key = `${jid}:${sender}`;
                const recent = (spamTracker.get(key) || [])
                  .filter(timestamp => now - timestamp < 8000);
                recent.push(now);
                spamTracker.set(key, recent);

                if (recent.length >= 6) {
                  spamTracker.set(key, []);
                  const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
                  if (admins.includes(botJid)) {
                    await sock.sendMessage(jid, { delete: msg.key });
                  }
                  await sock.sendMessage(jid, {
                    text: `⚠️ Anti-spam: @${sender.split("@")[0]}, please slow down. Repeated messages are restricted.`,
                    mentions: [sender]
                  });
                }
              }
            }
          }

          if (!body.startsWith(PREFIX)) {
            continue;
          }

          const parts = body
            .slice(PREFIX.length)
            .trim()
            .split(/\s+/);

          const command = (parts.shift() || "")
            .toLowerCase();

          const args = parts.join(" ");

          commandCount++;


// ======================================
// VIDEO DOWNLOADER
// ======================================

if (command === "download") {
  const url = args.trim();

  if (!url || !/^https?:\/\//i.test(url)) {
    await sendText(
      sock,
      jid,
      "❌ Please use:\n..download VIDEO_LINK"
    );
    continue;
  }

  let folder;

  try {
    await sendText(
      sock,
      jid,
      "🦅 GARUDIX DOWNLOADER\n\n⏳ Downloading your video..."
    );

    folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "garudix-download-")
    );

    const output = path.join(folder, "video.%(ext)s");

    await new Promise((resolve, reject) => {
      const downloader = spawn(
  String.raw`C:\Users\ABILASH SRADHA\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe`,
  [
        "--no-playlist",
        "-f", "best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", output,
        url
      ]);

      let errorText = "";

      downloader.stderr.on("data", data => {
        errorText += data.toString();
      });

      downloader.on("error", reject);

      downloader.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(errorText.slice(-1000) || "Download failed"));
      });
    });

    const files = await fs.readdir(folder);
    const videoFile = files.find(file =>
      /\.(mp4|mkv|webm|mov)$/i.test(file)
    );

    if (!videoFile) {
      throw new Error("Downloaded video file not found.");
    }

    const videoPath = path.join(folder, videoFile);
    const info = await fs.stat(videoPath);

    if (info.size > 64 * 1024 * 1024) {
      throw new Error("Video is larger than 64 MB. Cannot send it as a WhatsApp video.");
    }

    const video = await fs.readFile(videoPath);

    await sock.sendMessage(jid, {
      video,
      mimetype: "video/mp4",
      caption: "🦅 Downloaded by GARUDIX"
    });

  } catch (error) {
    console.error("GARUDIX DOWNLOAD ERROR:", error);

    await sendText(
      sock,
      jid,
      "❌ Download failed.\n" + (error.message || "Try another public video link.")
    );

  } finally {
    if (folder) {
      await fs.rm(folder, {
        recursive: true,
        force: true
      });
    }
  }

  continue;
}


          // =====================================
          // PING
          // =====================================

          if (command === "ping") {
            await sendText(
              sock,
              jid,
              "🏓 GARUDIX is alive!"
            );
          }

          // =====================================
          // ALIVE
          // =====================================

          else if (command === "alive") {
            await sendText(
              sock,
              jid,
              `🦅 ${BOT_NAME} IS ONLINE!

⚡ Status: Active
👑 Owner: ${OWNER_NAME}
🔖 Version: ${VERSION}
⏱️ Uptime: ${Math.floor((Date.now() - START_TIME) / 1000)} seconds

Ancient Power. Modern Intelligence.`
            );
          }

          // =====================================
          // MENU
          // =====================================

          else if (command === "menu") {
            await sendText(
              sock,
              jid,
              `╭━━━━━━━━━━━━━━━━━━━━╮
       🦅 GARUDIX
╰━━━━━━━━━━━━━━━━━━━━╯

⚡ Ancient Power. Modern Intelligence.

👑 Owner: ${OWNER_NAME}
🔖 Version: ${VERSION}
⚙️ Prefix: ${PREFIX}

╭━━〔 🎨 STICKER STUDIO 〕━━╮
│ ..sticker
│ ..toimg (reply sticker)
│ ..take PACK | AUTHOR (reply sticker)
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 🎬 IMAGE / VIDEO 〕━━╮
│ ..gif (reply video)
│ ..compress (reply video)
│ ..toaudio (reply video)
│ ..audio (reply audio/video)
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 🔊 AUDIO TOOLS 〕━━╮
│ ..tts your text
│ ..transcribe (not installed)
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 🤖 ASSISTANT 〕━━╮
│ ..ai your question
│ ..translate text (not installed)
│ ..caption text
│ ..summarize text (not installed)
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 👥 GROUP TOOLS 〕━━╮
│ ..groupinfo
│ ..tagall
│ ..kick (reply)
│ ..promote (reply)
│ ..demote (reply)
│ ..warn (reply)
│ ..antilink on/off
│ ..welcome on/off
│ ..goodbye on/off
│ ..poll Question | Option 1 | Option 2
│ ..announce message
│ ..countdown 10
│ ..dice
│ ..random 1 100
│ ..setrules / ..rules
│ ..remind 10m message
│ ..antispam on/off
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 🛠️ UTILITIES 〕━━╮
│ ..calc 10+20
│ ..weather Kochi
│ ..time
│ ..qr text (PC terminal)
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 👑 OWNER DASHBOARD 〕━━╮
│ ..dashboard
│ ..owner
│ ..contact
│ ..about
╰━━━━━━━━━━━━━━━━━━━━╯

🦅 GARUDIX ULTIMATE
Ancient Power. Modern Intelligence.`
            );
          }

          // =====================================
          // ABOUT
          // =====================================

          else if (command === "about") {
            await sendText(
              sock,
              jid,
              "🦅 Preparing GARUDIX animation..."
            );

            const video = await aboutVideo();

            await sock.sendMessage(jid, {
              video,
              mimetype: "video/mp4",
              gifPlayback: true,
              caption:
                `🦅 GARUDIX ULTIMATE

⚡ Ancient Power. Modern Intelligence.

👑 Created by ${OWNER_NAME}
🔖 Version ${VERSION}

✨ Mythology meets Modern Intelligence.`
            });
          }

          // =====================================
          // OWNER / CONTACT
          // =====================================

          else if (
            command === "owner" ||
            command === "contact"
          ) {
            await sendText(
              sock,
              jid,
              `👑 GARUDIX CREATOR

Name: ${OWNER_NAME}
Contact: +${OWNER_NUMBER}

🦅 Ancient Power. Modern Intelligence.`
            );
          }

          // =====================================
          // OWNER DASHBOARD - FIXED
          // =====================================

          else if (command === "dashboard") {
            if (!isOwner(msg, sock)) {
              await sendText(
                sock,
                jid,
                "⛔ Owner only command."
              );
              continue;
            }

            await sendText(
              sock,
              jid,
              `╭━━〔 👑 OWNER DASHBOARD 〕━━╮

🦅 ${BOT_NAME}
⚡ Status: Online
🔖 Version: ${VERSION}

👑 Owner: ${OWNER_NAME}
📱 Owner Number: ${OWNER_NUMBER}

📨 Messages: ${messageCount}
⚙️ Commands: ${commandCount}
⏱️ Uptime: ${Math.floor((Date.now() - START_TIME) / 1000)} sec

💻 Node: ${process.version}
🖥️ Platform: ${process.platform}

╰━━━━━━━━━━━━━━━━━━━━╯`
            );
          }

          // =====================================
          // PHOTO / VIDEO TO STICKER
          // =====================================

          else if (command === "sticker") {
            if (contentType === "imageMessage") {
              await sendText(
                sock,
                jid,
                "🎨 Creating sticker..."
              );

              const buffer =
                await downloadMessage(sock, msg);

              const sticker =
                await createSticker(buffer);

              if (sticker.length > 500 * 1024) {
                throw new Error(
                  "Sticker exceeds WhatsApp size limit."
                );
              }

              await sock.sendMessage(jid, {
                sticker
              });
            }

            else if (contentType === "videoMessage") {
              await sendText(
                sock,
                jid,
                "🎬 Creating animated sticker..."
              );

              const buffer =
                await downloadMessage(sock, msg);

              const sticker =
                await videoToSticker(buffer);

              if (sticker.length > 500 * 1024) {
                throw new Error(
                  "Animated sticker too large. Try a shorter video."
                );
              }

              await sock.sendMessage(jid, {
                sticker
              });
            }

            else {
              await sendText(
                sock,
                jid,
                "📸 Send a photo or short video with caption ..sticker"
              );
            }
          }

          // =====================================
          // STICKER TO PNG
          // =====================================

          else if (command === "toimg") {
            const quoted = getQuoted(msg);

            if (!quoted?.message?.stickerMessage) {
              await sendText(
                sock,
                jid,
                "Reply to a sticker with ..toimg"
              );
              continue;
            }

            const buffer =
              await downloadQuoted(sock, msg);

            const image =
              await stickerToPng(buffer);

            await sock.sendMessage(jid, {
              image,
              mimetype: "image/png",
              caption: "🦅 GARUDIX | Sticker to PNG"
            });
          }

          // =====================================
          // STICKER PACK / AUTHOR CHANGE
          // =====================================

          else if (command === "take") {
            const quoted = getQuoted(msg);

            if (!quoted?.message?.stickerMessage) {
              await sendText(
                sock,
                jid,
                "Reply to a sticker:\n..take PACK NAME | AUTHOR"
              );
              continue;
            }

            const [pack, author] = args
              .split("|")
              .map(x => x?.trim());

            if (!pack || !author) {
              await sendText(
                sock,
                jid,
                "Format:\n..take PACK NAME | AUTHOR"
              );
              continue;
            }

            const buffer =
              await downloadQuoted(sock, msg);

            const sticker = await createSticker(
              buffer,
              75,
              pack,
              author
            );

            if (sticker.length > 500 * 1024) {
              throw new Error("Sticker is too large.");
            }

            await sock.sendMessage(jid, {
              sticker
            });

            await sendText(
              sock,
              jid,
              `✅ Sticker metadata updated.

📦 Pack: ${pack}
✍️ Author: ${author}

🦅 GARUDIX`
            );
          }

          // =====================================
          // VIDEO TO GIF
          // =====================================

          else if (command === "gif") {
            const quoted = getQuoted(msg);

            if (!quoted?.message?.videoMessage) {
              await sendText(
                sock,
                jid,
                "Reply to a video with ..gif"
              );
              continue;
            }

            const buffer =
              await downloadQuoted(sock, msg);

            const gif = await convertMedia(
              buffer,
              "input.mp4",
              "output.gif",
              [
                "-t", "8",
                "-vf",
                "fps=12,scale=480:-1:flags=lanczos"
              ]
            );

            await sock.sendMessage(jid, {
              video: gif,
              mimetype: "video/mp4",
              gifPlayback: true,
              caption: "🦅 GARUDIX GIF"
            });
          }

          // =====================================
          // VIDEO COMPRESS
          // =====================================

          else if (command === "compress") {
            const quoted = getQuoted(msg);

            if (!quoted?.message?.videoMessage) {
              await sendText(
                sock,
                jid,
                "Reply to a video with ..compress"
              );
              continue;
            }

            const buffer =
              await downloadQuoted(sock, msg);

            const compressed = await convertMedia(
              buffer,
              "input.mp4",
              "compressed.mp4",
              [
                "-vf",
                "scale='min(720,iw)':-2",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "30",
                "-c:a", "aac",
                "-b:a", "96k",
                "-movflags", "+faststart"
              ]
            );

            await sock.sendMessage(jid, {
              video: compressed,
              mimetype: "video/mp4",
              caption: "🎬 GARUDIX | Compressed video"
            });
          }

          // =====================================
          // AUDIO CONVERSION
          // =====================================

          else if (
            command === "toaudio" ||
            command === "audio"
          ) {
            const quoted = getQuoted(msg);
            const sourceMessage = quoted?.message || message;

            const isVideo =
              !!sourceMessage.videoMessage;

            const isAudio =
              !!sourceMessage.audioMessage;

            if (!isVideo && !isAudio) {
              await sendText(
                sock,
                jid,
                "Reply to a video/audio with ..toaudio"
              );
              continue;
            }

            const buffer = quoted
              ? await downloadQuoted(sock, msg)
              : await downloadMessage(sock, msg);

            const audio = await convertMedia(
              buffer,
              isVideo ? "input.mp4" : "input.audio",
              "output.mp3",
              [
                "-vn",
                "-c:a", "libmp3lame",
                "-b:a", "128k"
              ]
            );

            await sock.sendMessage(jid, {
              audio,
              mimetype: "audio/mpeg",
              fileName: "garudix-audio.mp3"
            });
          }

          // =====================================
          // TEXT TO SPEECH
          // =====================================

          else if (command === "tts") {
            if (!args) {
              await sendText(
                sock,
                jid,
                "Usage: ..tts Hello world"
              );
              continue;
            }

            await sendText(
              sock,
              jid,
              "🔊 Generating speech..."
            );

            
let audio;

try {
  audio = await textToSpeech(args);

  console.log("GARUDIX TTS: Audio generated.");
  console.log("Audio size:", audio.length);

  if (!audio || audio.length === 0) {
    throw new Error("Generated audio is empty.");
  }

  
const mp3Audio = await convertMedia(
  audio,
  "speech.wav",
  "speech.mp3",
  [
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "128k"
  ]
);

await sock.sendMessage(jid, {
  audio: mp3Audio,
  mimetype: "audio/mpeg",
  fileName: "garudix-tts.mp3",
  ptt: false
});

console.log("GARUDIX TTS: Audio sent successfully.");

} catch (error) {
  console.error("GARUDIX TTS ERROR:", error);

  await sendText(
    sock,
    jid,
    "❌ TTS Error:\n" + (error.message || String(error))
  );
}

          }

          // =====================================
          // BUILT-IN ASSISTANT
          // =====================================

          else if (command === "ai") {
            await sendText(
              sock,
              jid,
              freeAssistant(args)
            );
          }

          // =====================================
          // TRANSLATE NOTICE
          // =====================================

          else if (command === "translate") {
            await sendText(
              sock,
              jid,
              "🌐 Automatic translation is not installed in this lightweight edition. No paid API is connected."
            );
          }

          // =====================================
          // CAPTION
          // =====================================

          else if (command === "caption") {
            if (!args) {
              await sendText(
                sock,
                jid,
                "Usage: ..caption your topic"
              );
              continue;
            }

            await sendText(
              sock,
              jid,
              `✨ ${args}

🦅 GARUDIX | Ancient Power. Modern Intelligence.`
            );
          }

          // =====================================
          // SUMMARIZE
          // =====================================

          else if (command === "summarize") {
            await sendText(
              sock,
              jid,
              "📝 AI summarization requires an AI model. This lightweight 4 GB edition does not download one."
            );
          }

          // =====================================
          // TRANSCRIBE
          // =====================================

          else if (command === "transcribe") {
            await sendText(
              sock,
              jid,
              "🎙️ Offline speech-to-text is not installed in this edition. You can use your phone's voice typing."
            );
          }

          // =====================================
          // CALCULATOR
          // =====================================

          else if (command === "calc") {
            if (!args) {
              await sendText(
                sock,
                jid,
                "Usage: ..calc 25*4+10"
              );
              continue;
            }

            await sendText(
              sock,
              jid,
              `🧮 Result: ${calculate(args)}`
            );
          }

          // =====================================
          // TIME
          // =====================================

          else if (command === "time") {
            await sendText(
              sock,
              jid,
              `🕒 ${new Date().toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata"
              })} IST`
            );
          }

          // =====================================
          // WEATHER
          // =====================================

          else if (command === "weather") {
            if (!args) {
              await sendText(
                sock,
                jid,
                "Usage: ..weather Kochi"
              );
              continue;
            }

            await sendText(
              sock,
              jid,
              "🌤️ Checking weather..."
            );

            await sendText(
              sock,
              jid,
              await getWeather(args)
            );
          }

          // =====================================
          // QR - TERMINAL OUTPUT
          // =====================================

          else if (command === "qr") {
            if (!args) {
              await sendText(
                sock,
                jid,
                "Usage: ..qr your text"
              );
              continue;
            }

            qrcode.generate(args, { small: true });

            await sendText(
              sock,
              jid,
              "✅ QR code generated in the GARUDIX PC terminal."
            );
          }

          // =====================================
          // GROUP INFO
          // =====================================

          // ======================================
          // GROUP POLL
          // ======================================


          // =====================================
          // GROUP POWER PACK
          // =====================================

          else if (command === "announce") {
            await checkGroupAdmin(sock, msg);
            if (!args.trim()) {
              await sendText(sock, jid, "Usage: ..announce Your announcement");
              continue;
            }
            await sendText(sock, jid, `📢 GROUP ANNOUNCEMENT\n\n${args.trim()}\n\n🦅 GARUDIX`);
          }

          else if (command === "countdown") {
            if (!jid.endsWith("@g.us")) {
              await sendText(sock, jid, "Countdown works only in groups.");
              continue;
            }
            const seconds = Number(args.trim());
            if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) {
              await sendText(sock, jid, "Usage: ..countdown 10\nChoose 1–10 seconds.");
              continue;
            }
            await sendText(sock, jid, `⏳ Countdown started: ${seconds}`);
            for (let remaining = seconds - 1; remaining > 0; remaining--) {
              await sleep(1000);
              await sendText(sock, jid, `⏳ ${remaining}...`);
            }
            await sleep(1000);
            await sendText(sock, jid, "🚀 TIME'S UP! 🦅");
          }

          else if (command === "dice") {
            const roll = Math.floor(Math.random() * 6) + 1;
            const faces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
            await sendText(sock, jid, `🎲 GARUDIX DICE\n\n${faces[roll - 1]} You rolled: ${roll}`);
          }

          else if (command === "random") {
            const values = args.trim().split(/\s+/).map(Number);
            const [min, max] = values;
            if (values.length !== 2 || !Number.isSafeInteger(min) ||
                !Number.isSafeInteger(max) || min > max ||
                max - min > 1000000000) {
              await sendText(sock, jid, "Usage: ..random 1 100");
              continue;
            }
            const result = Math.floor(Math.random() * (max - min + 1)) + min;
            await sendText(sock, jid, `🎯 Random number: ${result}`);
          }

          else if (command === "setrules") {
            await checkGroupAdmin(sock, msg);
            if (!args.trim()) {
              await sendText(sock, jid, "Usage: ..setrules Be respectful | No spam | No links");
              continue;
            }
            groupData.rules[jid] = args.trim().slice(0, 3000);
            await saveGroupData();
            await sendText(sock, jid, "✅ Group rules saved. Use ..rules to view them.");
          }

          else if (command === "rules") {
            if (!jid.endsWith("@g.us")) {
              await sendText(sock, jid, "This command works only in groups.");
              continue;
            }
            const rules = groupData.rules[jid];
            await sendText(sock, jid, rules
              ? `📜 GROUP RULES\n\n${rules}\n\n🦅 GARUDIX`
              : "📜 No group rules have been set yet. An admin can use ..setrules Your rules.");
          }

          else if (command === "remind") {
            if (!jid.endsWith("@g.us")) {
              await sendText(sock, jid, "Reminders work only in groups.");
              continue;
            }
            const match = args.trim().match(/^(\d+)(s|m|h)\s+(.+)$/i);
            if (!match) {
              await sendText(sock, jid, "Usage: ..remind 10m Drink water\nUnits: s = seconds, m = minutes, h = hours.");
              continue;
            }
            const amount = Number(match[1]);
            const unit = match[2].toLowerCase();
            const messageText = match[3].trim();
            const multiplier = unit === "s" ? 1000 : unit === "m" ? 60000 : 3600000;
            const delay = amount * multiplier;
            if (!Number.isSafeInteger(amount) || amount < 1 || delay > 7 * 24 * 60 * 60 * 1000) {
              await sendText(sock, jid, "Reminder must be between 1 second and 7 days.");
              continue;
            }
            const reminder = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              jid,
              message: messageText.slice(0, 1000),
              when: Date.now() + delay
            };
            groupData.reminders.push(reminder);
            await saveGroupData();
            scheduleReminder(sock, reminder);
            await sendText(sock, jid, `⏰ Reminder set for ${match[1]}${unit} from now.`);
          }

          else if (command === "antispam") {
            await checkGroupAdmin(sock, msg);
            const value = args.trim().toLowerCase();
            if (!["on", "off"].includes(value)) {
              await sendText(sock, jid, "Usage: ..antispam on/off");
              continue;
            }
            const settings = getGroupSetting(jid);
            settings.antispam = value === "on";
            await syncGroupSettingsToDisk(jid);
            await sendText(sock, jid, `🛡️ Anti-spam is now ${value.toUpperCase()}. It flags 6 messages within 8 seconds.`);
          }

          else if (command === "poll") {
            if (!jid.endsWith("@g.us")) {
              await sendText(sock, jid, "❌ Poll works only in groups.");
              continue;
            }

            const pollParts = args.split("|").map(x => x.trim());
            const question = pollParts.shift();
            const options = pollParts.filter(Boolean);

            if (!question || options.length < 2 || options.length > 12) {
              await sendText(
                sock,
                jid,
                "📊 POLL FORMAT:\n\n..poll Question | Option 1 | Option 2\n\nAdd 2 to 12 options."
              );
              continue;
            }

            await sock.sendMessage(jid, {
              poll: {
                name: question,
                values: options,
                selectableCount: 1
              }
            });
          }

          else if (command === "groupinfo") {
            if (!jid.endsWith("@g.us")) {
              await sendText(
                sock,
                jid,
                "This command works only in groups."
              );
              continue;
            }

            const metadata =
              await sock.groupMetadata(jid);

            await sendText(
              sock,
              jid,
              `👥 GROUP INFORMATION

📌 Name: ${metadata.subject}
👤 Members: ${metadata.participants.length}
🆔 Group ID: ${metadata.id}

🦅 GARUDIX`
            );
          }

          // =====================================
          // TAG ALL
          // =====================================

          else if (command === "tagall") {
            await checkGroupAdmin(sock, msg);

            const metadata =
              await sock.groupMetadata(jid);

            const mentions =
              metadata.participants.map(p => p.id);

            await sock.sendMessage(jid, {
              text:
                `📢 Attention everyone!\n\n${mentions.map(x => "@" + x.split("@")[0]).join(" ")}`,
              mentions
            });
          }

          // =====================================
          // KICK / PROMOTE / DEMOTE
          // =====================================

          else if (
            ["kick", "promote", "demote"].includes(command)
          ) {
            await checkGroupAdmin(sock, msg);

            const quoted = getQuoted(msg);

            const target =
              quoted?.context?.participant ||
              (
                args.replace(/\D/g, "")
                  ? args.replace(/\D/g, "") + "@s.whatsapp.net"
                  : null
              );

            if (!target) {
              await sendText(
                sock,
                jid,
                `Reply to a member's message with ..${command}`
              );
              continue;
            }

            const action = {
              kick: "remove",
              promote: "promote",
              demote: "demote"
            }[command];

            await sock.groupParticipantsUpdate(
              jid,
              [target],
              action
            );

            await sendText(
              sock,
              jid,
              `✅ ${command.toUpperCase()} command completed.`
            );
          }

          // =====================================
          // WARN
          // =====================================

          else if (command === "warn") {
            await checkGroupAdmin(sock, msg);

            const quoted = getQuoted(msg);
            const target =
              quoted?.context?.participant;

            if (!target) {
              await sendText(
                sock,
                jid,
                "Reply to a member's message with ..warn"
              );
              continue;
            }

            const key = `${jid}:${target}`;

            const count =
              (userWarnings.get(key) || 0) + 1;

            userWarnings.set(key, count);

            await sock.sendMessage(jid, {
              text:
                `⚠️ Warning ${count}/3 for @${target.split("@")[0]}`,
              mentions: [target]
            });

            if (count >= 3) {
              await sendText(
                sock,
                jid,
                "⚠️ Three warnings reached. An admin can review this member."
              );
            }
          }

          // =====================================
          // GROUP SETTINGS
          // =====================================

          else if (
            ["antilink", "welcome", "goodbye"].includes(command)
          ) {
            await checkGroupAdmin(sock, msg);

            const value = args.toLowerCase();

            if (!["on", "off"].includes(value)) {
              await sendText(
                sock,
                jid,
                `Usage: ..${command} on/off`
              );
              continue;
            }

            const settings = getGroupSetting(jid);

            settings[command] = value === "on";
            await syncGroupSettingsToDisk(jid);

            await sendText(
              sock,
              jid,
              `✅ ${command} is now ${value.toUpperCase()}.`
            );
          }

          // =====================================
          // UNKNOWN COMMAND
          // =====================================

          else {
            await sendText(
              sock,
              jid,
              `❓ Unknown command: ${PREFIX}${command}

Type ${PREFIX}menu to see commands.`
            );
          }

        } catch (error) {
          console.error(
            "GARUDIX command error:",
            error
          );

          try {
            await sendText(
              sock,
              msg.key.remoteJid,
              `❌ Error: ${error.message || "Something went wrong."}`
            );
          } catch {}
        }
      }
    }
  );
}

// =============================================
// START
// =============================================

startGarudix().catch(console.error);
