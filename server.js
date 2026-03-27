import express from "express";
import cors from "cors";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(cors());

const APP_ID = process.env.APP_ID;
const REDIRECT_URI = process.env.REDIRECT_URI;

let ACCESS_TOKEN = "";

/* ===== LOGIN ===== */
app.get("/login", (req, res) => {
  const url = `https://api.fyers.in/api/v3/generate-authcode?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&state=sample`;
  res.redirect(url);
});

/* ===== CALLBACK (IMPORTANT FIX) ===== */
app.get("/callback", (req, res) => {
  const auth_code = req.query.auth_code;

  if (!auth_code) {
    return res.send("❌ No auth code received");
  }

  // ✅ THIS IS THE KEY FIX
  ACCESS_TOKEN = `${APP_ID}:${auth_code}`;

  console.log("Token set:", ACCESS_TOKEN);

  res.send("✅ Login successful. Now open /start");
});

/* ===== SERVER ===== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function connectFyers() {
  const ws = new WebSocket("wss://socket.fyers.in/socket/v2/dataSock", {
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
    console.log("Reconnecting...");
    setTimeout(connectFyers, 3000);
  });

  ws.on("error", (err) => {
    console.log("WS Error:", err.message);
  });
}

/* ===== START ===== */
app.get("/start", (req, res) => {
  if (!ACCESS_TOKEN) {
    return res.send("❌ Login first");
  }

  connectFyers();
  res.send("🚀 Live streaming started");
});

/* ===== HOME ===== */
app.get("/", (req, res) => {
  res.send("✅ Backend Running");
});

/* ===== START SERVER ===== */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
