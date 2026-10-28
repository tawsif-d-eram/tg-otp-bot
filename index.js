// Setup:   npm i telegram input express
// Run:     node monitor.js            (DEBUG=1 node monitor.js for verbose logs)
//
// How it reacts to the main channel:
//  - Instant path: raw channel updates (new posts, and posts edited to add a button)
//  - Safety net:   a light poll every POLL_MS, in case Telegram does not push this
//                  channel's updates to the account (for example it has not joined it)
//  Both paths share one handler and one de-dupe set, so a code is never sent twice.
//
// Speed design:
//  - The bot's InputPeer / InputUser are resolved once at startup, not per message
//  - The code is pulled out with precompiled regexes and StartBot is fired immediately
//  - Library logging is off unless DEBUG=1, and Express runs with every extra switched off

process.env.NODE_ENV = process.env.NODE_ENV || "production"; // lets Express skip dev-only work
const express = require("express");
const fs = require("fs");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Raw } = require("telegram/events");
const { generateRandomBigInt } = require("telegram/Helpers");

const apiId = 34631044;
const apiHash = "c28fb6dfa28b9396a6f7aed1d36dd3ba";

const CHANNEL = "klyx_news";
const TARGET_BOT = "klyxx_bot";

// Test channel: any new message here (even your own) gets a reply in the same channel.
const TEST_CHANNEL = "testerx2026";
const TEST_REPLY = "Bot is working";

const POLL_MS = 1000; // safety-net poll of the main channel; 0 turns it off
const MAX_EDIT_AGE_S = 300; // edits of posts older than this are ignored

const SESSION_FILE = "telegram-session.txt";
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === "1";

// Uses the session saved by a previous login if there is one,
// otherwise falls back to the hardcoded session string below.
const SESSION = fs.existsSync(SESSION_FILE)
  ? fs.readFileSync(SESSION_FILE, "utf8").trim()
  : "1BQANOTEuMTA4LjU2LjEyNgG7QPsJdtc49hP0XEW6a7je9eEbuS1B8nn+hgpw9BrFt+RKWPDkYVAU1N3PCMX51x5ixLlZK6Bl+O5b/34ZDfjLmr0E9IYPzRwTp4XuLTuanhc3jguMIH60BnmmuXtuyUQ5/CocJCHOIJPxL1tRk+rYI1CFljZssXIWYmD0rr2qEBSecxclq80J3Hg/fya6CAwoJVoXagWWJ1UrEE0BUIsEhmcVz9G6dNwtPiSrBI9VW2woal4vGfEAkSv5Y0tneS0Ryt0ukWD3tG1LAiQfo99TcBMjrWKoa07pze2bO/JPL8cU6CD35igUOGWi9IxTxUHku7RPBPA1e+hYAj7lObxZzA==";

// ---------- keep-alive web server (Express, stripped down) ----------
const app = express();
app.disable("x-powered-by");
app.set("etag", false);
app.get("/", (req, res) => res.status(200).send("Telegram monitor is running."));
app.listen(PORT, "0.0.0.0", () => console.log(`Express server running on port ${PORT}`));

process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e));

// ---------- code extraction (compiled once) ----------
// Matches https://t.me/<bot>?start=CODE, telegram.me, and tg://resolve?domain=<bot>&start=CODE
const LINK_RE = new RegExp(
  `^(?:https?://(?:t|telegram)\\.me/${TARGET_BOT}\\?|tg://resolve\\?domain=${TARGET_BOT}&)(?:[^#]*&)?start=([^&#\\s]+)`,
  "i"
);
const TEXT_LINKS_RE = /(?:https?|tg):\/\/\S+/gi;
const BOT_RE = new RegExp(TARGET_BOT, "i");

function findCode(msg) {
  // Fast path: inline buttons
  const rows = msg.replyMarkup && msg.replyMarkup.rows;
  if (rows) {
    for (let i = 0; i < rows.length; i++) {
      const buttons = rows[i].buttons;
      for (let j = 0; j < buttons.length; j++) {
        const url = buttons[j].url;
        if (url) {
          const m = LINK_RE.exec(url);
          if (m) return m[1];
        }
      }
    }
  }

  // Fallbacks: a link in the text or in a hyperlinked text entity
  const text = msg.message;
  if (text && BOT_RE.test(text)) {
    const links = text.match(TEXT_LINKS_RE);
    if (links) {
      for (let i = 0; i < links.length; i++) {
        const m = LINK_RE.exec(links[i]);
        if (m) return m[1];
      }
    }
  }
  const entities = msg.entities;
  if (entities) {
    for (let i = 0; i < entities.length; i++) {
      const url = entities[i].url;
      if (url) {
        const m = LINK_RE.exec(url);
        if (m) return m[1];
      }
    }
  }
  return null;
}

// Short description of a post's buttons, printed when no code is found
function describe(msg) {
  const rows = msg.replyMarkup && msg.replyMarkup.rows;
  if (!rows) return "The post has no buttons.";
  return (
    "Buttons: " +
    rows
      .map((r) =>
        (r.buttons || [])
          .map((b) => `${b.className || b.constructor.name}${b.url ? " " + b.url : ""}`)
          .join(" | ")
      )
      .join(" / ")
  );
}

function remember(set, id) {
  set.add(id);
  if (set.size > 1000) set.delete(set.values().next().value);
}

// ---------- main ----------
async function main() {
  const client = new TelegramClient(new StringSession(SESSION), apiId, apiHash, {
    connectionRetries: Infinity,
    retryDelay: 1000,
    autoReconnect: true,
    useWSS: false,
  });
  client.setLogLevel(DEBUG ? "info" : "error");

  const ask = (q) => require("input").text(q);
  await client.start({
    phoneNumber: () => ask("Phone number: "),
    phoneCode: () => ask("Telegram login code: "),
    password: () => ask("Two-step verification password: "),
    onError: console.error,
  });

  fs.writeFileSync(SESSION_FILE, client.session.save(), { mode: 0o600 });
  console.log("Login successful. Session saved automatically.");

  // Resolve everything up front so the hot path does no lookups
  const channel = await client.getEntity(CHANNEL);
  const channelId = channel.id.toString();
  await client.getDialogs({ limit: 100 }); // warms the cache so channel updates arrive

  const botPeer = await client.getInputEntity(TARGET_BOT);

  let testChannel = null;
  let testChannelId = null;
  try {
    testChannel = await client.getInputEntity(TEST_CHANNEL);
    testChannelId = (await client.getEntity(TEST_CHANNEL)).id.toString();
  } catch (err) {
    console.error(`Could not resolve test channel ${TEST_CHANNEL}:`, err.message);
  }

  const seen = new Set(); // posts we already sent a code for
  const reported = new Set(); // posts we already logged as "no code found"
  const ownReplies = new Set(); // IDs of our own test replies (prevents a reply loop)

  // ---- main channel: used by the instant path and the safety-net poll ----
  const handleMainPost = (msg, via) => {
    if (via === "edit" && Date.now() / 1000 - msg.date > MAX_EDIT_AGE_S) return;
    if (seen.has(msg.id)) return;

    const code = findCode(msg);
    if (!code) {
      if (!reported.has(msg.id)) {
        remember(reported, msg.id);
        console.log(`Post ${msg.id} (${via}): no ${TARGET_BOT} link found. ${describe(msg)}`);
      }
      return;
    }
    const updatedCode = code?.startsWith('promo') ? code.split("promo_")[1] : code;

    remember(seen, msg.id);
    const t0 = Date.now();
    client
      .sendMessage(botPeer, { message: updatedCode })
      .then(() => client.sendMessage(botPeer, { message: FOLLOW_UP }))
      .then(() =>
        console.log(
          `Sent code to @${TARGET_BOT}: ${code} + "${FOLLOW_UP}" (post ${msg.id}, ${via}, ${Date.now() - t0}ms)`
        )
      )
      .catch((err) => console.error("Sending code failed:", err.message));
  };

  const onUpdate = (update) => {
    const msg = update.message;
    const peer = msg && msg.peerId;
    if (!peer || peer.channelId === undefined) return;

    const chat = peer.channelId.toString();
    const isEdit = update instanceof Api.UpdateEditChannelMessage;

    if (DEBUG) {
      console.log(
        `[incoming${isEdit ? " edit" : ""}] channel=${chat} id=${msg.id} markup=${!!msg.replyMarkup}`
      );
    }

    if (chat === channelId) {
      handleMainPost(msg, isEdit ? "edit" : "push");
      return;
    }

    // ---- test channel: reply to any new message, including your own ----
    if (!isEdit && chat === testChannelId && msg instanceof Api.Message) {
      if (ownReplies.has(msg.id) || msg.message === TEST_REPLY) return;

      client
        .sendMessage(testChannel, { message: TEST_REPLY })
        .then((sent) => {
          ownReplies.add(sent.id);
          console.log(`Test channel: replied "${TEST_REPLY}" to message ${msg.id}`);
        })
        .catch((err) => console.error("Test reply failed:", err.message));
    }
  };

  client.addEventHandler(
    (update) => {
      try {
        onUpdate(update);
      } catch (err) {
        console.error("Handler error:", err);
      }
    },
    new Raw({ types: [Api.UpdateNewChannelMessage, Api.UpdateEditChannelMessage] })
  );

  // ---- safety-net poll: catches posts Telegram did not push to us ----
  let lastId = 0;
  let canPoll = POLL_MS > 0;
  if (canPoll) {
    try {
      const latest = await client.getMessages(channel, { limit: 1 });
      lastId = latest.length ? latest[0].id : 0; // start from "now": never replay old posts
    } catch (err) {
      canPoll = false;
      console.error("Safety-net poll disabled:", err.message);
    }
  }
  if (canPoll) {
    const poll = async () => {
      try {
        const msgs = await client.getMessages(channel, { limit: 10, minId: lastId });
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].id > lastId) lastId = msgs[i].id;
          handleMainPost(msgs[i], "poll");
        }
      } catch (err) {
        if (DEBUG) console.error("Poll failed:", err.message);
      }
      setTimeout(poll, POLL_MS);
    };
    setTimeout(poll, POLL_MS);
  }

  console.log(
    `Monitoring channel: ${CHANNEL} "${channel.title || ""}" (id ${channelId}, ` +
      `${channel.left ? "NOT JOINED" : "joined"})`
  );
  if (channel.left) {
    console.warn(
      `WARNING: this account has not joined ${CHANNEL}, so Telegram will not push its posts. ` +
        `Only the ${POLL_MS}ms poll can see them. Join the channel for instant reaction.`
    );
  }
  if (testChannelId) console.log(`Test channel: ${TEST_CHANNEL} (id ${testChannelId})`);
}

main().catch(console.error);
