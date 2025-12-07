import Imap from "imap";
import { simpleParser } from "mailparser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import pRetry from "p-retry";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

dotenv.config();

const {
  IMAP_HOST,
  IMAP_PORT,
  IMAP_TLS,
  EMAIL_USER,
  EMAIL_PASS,
  MAILBOX = "INBOX",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  DB_FILE = "./store.json",
  MAX_BODY_CHARS = 1500,
} = process.env;

if (
  !IMAP_HOST ||
  !EMAIL_USER ||
  !EMAIL_PASS ||
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHAT_ID
) {
  console.error("Missing required env vars. Check .env");
  process.exit(1);
}

/* ---------- simple persistent store to track UIDs we've processed ---------- */
const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter, { lastEmailUid: null });
await db.read();
db.data ||= { processedUids: [] };
await db.write();

function hasProcessed(uid) {
  return db?.data?.processedUids?.includes(uid);
}
async function markProcessed(uid) {
  db?.data?.processedUids?.push(uid);
  // keep list small: keep last 2000
  if (db?.data?.processedUids?.length > 2000)
    db.data.processedUids = db?.data?.processedUids?.slice(-2000);
  await db.write();
}

/* ---------- Telegram sender ---------- */
async function sendTelegramMessage(text, options = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  };
  // retry transient network errors
  return pRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Telegram API error ${res.status}: ${txt}`);
      }
      return res.json();
    },
    { retries: 3, factor: 2 }
  );
}

/* ---------- helper to trim and escape HTML for Telegram ---------- */
function escapeHtml(str = "") {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function shorten(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/* ---------- IMAP connection & flow ---------- */
let imap;

function buildImap() {
  return new Imap({
    user: EMAIL_USER,
    password: EMAIL_PASS,
    host: IMAP_HOST,
    port: Number(IMAP_PORT || 993),
    tls: IMAP_TLS === "false" ? false : true,
    tlsOptions: { rejectUnauthorized: false }, // if your server has weird certs, but avoid in prod
    keepalive: {
      interval: 10000, // ping server every 10s
      idleInterval: 300000,
    },
  });
}

function safeOpenBox(boxName = MAILBOX) {
  return new Promise((resolve, reject) => {
    imap.openBox(boxName, false, (err, box) => {
      if (err) return reject(err);
      resolve(box);
    });
  });
}

function imapDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() - days);

  const day = d.getDate();
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getMonth()];
  const year = d.getFullYear();

  return `${day}-${month}-${year}`;
}

// Use in IMAP search
const sinceDate = imapDate(30);

/* fetch & process unseen UIDs */
async function fetchAndProcess() {
  return new Promise((resolve) => {
    imap.search(["UNSEEN", ["SINCE", sinceDate]], (err, results) => {
      if (err) {
        console.error("IMAP search error:", err);
        return resolve();
      }
      if (!results || !results.length) return resolve();

     

      const latest10 = results.slice(0, 50);

      const f = imap.fetch(latest10, { bodies: "", markSeen: false });

      f.on("message", (msg, seqno) => {
        let uid;
        msg.on("attributes", (attrs) => {
          uid = attrs.uid;
        });

        msg.on("body", (stream) => {
          simpleParser(stream)
            .then(async (parsed) => {
              if (!uid) {
                // fallback: use date+subject hash if UID missing (rare)
                uid = `fallback-${Date.now()}-${Math.random()}`;
              }
              if (hasProcessed(uid)) {
                // already processed
                return;
              }

              const from = parsed.from?.text || "Unknown";
              const subject = parsed.subject || "(no subject)";
              const date = parsed.date ? parsed.date.toUTCString() : "";
              const text = parsed.text || parsed.html || "";
              const bodyText = shorten(
                escapeHtml(
                  parsed.text ||
                    (parsed.html ? parsed.html.replace(/<[^>]+>/g, "") : "")
                ),
                Number(MAX_BODY_CHARS)
              );

              // attachments summary
              let attachmentsSummary = "";
              if (parsed.attachments && parsed.attachments.length) {
                attachmentsSummary = `\nAttachments (${parsed.attachments.length}):\n`;
                attachmentsSummary += parsed.attachments
                  .map(
                    (a) =>
                      `• ${a.filename || "unnamed"} (${a.contentType}, ${
                        a.size
                      } bytes)`
                  )
                  .join("\n");
              }

              const message = `<b>New Email</b>\n<b>From:</b> ${escapeHtml(
                from
              )}\n<b>Subject:</b> ${escapeHtml(
                subject
              )}\n<b>Date:</b> ${escapeHtml(
                date
              )}\n\n${bodyText}${attachmentsSummary}`;

              try {
                await new Promise((r) => setTimeout(r, 5000));
                await sendTelegramMessage(message);
                await markProcessed(uid);
                console.log(`Sent uid=${uid} subject="${subject}"`);
              } catch (e) {
                console.error("Failed to send to Telegram:", e.message || e);
              }
            })
            .catch((err) => {
              console.error("simpleParser error:", err);
            });
        });

        msg.once("end", () => {});
      });

      f.once("error", (err) => {
        console.error("Fetch error:", err);
        resolve();
      });

      f.once("end", () => {
        resolve();
      });
    });
  });
}

/* ---------- main connect loop with reconnection ---------- */
async function start() {
  imap = buildImap();

  imap.once("ready", async () => {
    console.log("IMAP ready. Opening mailbox...");
    try {
      await safeOpenBox(MAILBOX);
      console.log(`Opened ${MAILBOX}. Listening for new mail...`);
    } catch (err) {
      console.error("Open box failed:", err);
      imap.end();
      return;
    }

    // initial sweep
    try {
      await fetchAndProcess();
    } catch (e) {
      console.error(e);
    }

    // IDLE: listen for new mail
    imap.on("mail", async () => {
      console.log("mail event - checking unseen...");
      try {
        await fetchAndProcess();
      } catch (e) {
        console.error(e);
      }
    });
  });

  imap.once("error", (err) => {
    console.error("IMAP error:", err);
  });

  imap.once("end", () => {
    console.warn("IMAP connection ended — will reconnect in 5s");
    setTimeout(() => start(), 5000);
  });

  // connect - with small retry wrapper
  try {
    await pRetry(
      () =>
        new Promise((res, rej) => {
          imap.connect();
          imap.once("ready", res);
          imap.once("error", (err) => {
            // if early connection error, reject to let pRetry try again
            rej(err);
          });
        }),
      { retries: 3, factor: 2 }
    );
  } catch (err) {
    console.error("Failed initial IMAP connect:", err);
    // schedule reconnect
    setTimeout(() => start(), 10000);
  }
}

start().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
