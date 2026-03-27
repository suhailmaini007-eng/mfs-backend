import express from "express";
import cors from "cors";
import axios from "axios";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(cors());

const APP_ID = process.env.APP_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const REDIRECT_URI = process.env.REDIRECT_URI;

let ACCESS_TOKEN = "";

/* ===== LOGIN ===== */
app.get("/login", (req, res) => {
  const url = `https://api.fyers.in/api/v3/generate-authcode?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&state=sample`;
  res.redirect(url);
});

/* ===== CALLBACK ===== */
app.get("/callback", async (req, res) => {
  const auth_code = req.query.auth_code;

  try {
    const response = await axios.post(
      "https://api.fyers.in/api/v3/token",
      {
        client_id: APP_ID,
        secret_key: SECRET_KEY,
        grant_type: "authorization_code",
        code: auth_code
      }
    );

    ACCESS_TOKEN = `${APP_ID}:${response.data.access_token}`;

    res.send("✅ Login successful. You can close this tab.");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("❌ Token error: " + JSON.stringify(err.response?.data));
  }
});

/* ===== CREATE SERVER ===== */
const server = http.createServer(app);

/* ===== WEBSOCKET ===== */
const wss = new WebSocketServer({ server });

function connectFyers() {
  const ws = new WebSocket("wss://socket.fyers.in/socket/v3/dataSock", {
    headers: {
      Authorization: ACCESS_TOKEN
    }
  });

  ws.on("open", () => {
    console.log("Connected to Fyers");

    ws.send(JSON.stringify({
      T: "SUB_L2",
      symbol: [
        "NSE:NIFTY50-INDEX",
        "NSE:BANKNIFTY-INDEX",
        "BSE:SENSEX-INDEX"
      ]
    }));
  });

  ws.on("message", (data) => {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data.toString());
      }
    });
  });

  ws.on("close", () => {
    console.log("Reconnecting to Fyers...");
    setTimeout(connectFyers, 3000);
  });

  ws.on("error", (err) => {
    console.error("Fyers WS Error:", err.message);
  });
}

/* ===== START STREAM ===== */
app.get("/start", (req, res) => {
  if (!ACCESS_TOKEN) return res.send("❌ Login first");

  connectFyers();
  res.send("🚀 Live streaming started");
});

/* ===== HEALTH CHECK ===== */
app.get("/", (req, res) => {
  res.send("MFS Backend Running");
});

/* ===== START SERVER ===== */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
