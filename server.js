import express from "express";
import cors from "cors";
import axios from "axios";
import WebSocket from "ws";

const app = express();
app.use(cors());

const APP_ID = process.env.APP_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const REDIRECT_URI = process.env.REDIRECT_URI;

let ACCESS_TOKEN = "";

/* LOGIN */
app.get("/login", (req, res) => {
  const url = `https://api.fyers.in/api/v2/generate-authcode?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&state=sample`;
  res.redirect(url);
});

/* CALLBACK */
app.get("/callback", async (req, res) => {
  const auth_code = req.query.auth_code;

  try {
    const response = await axios.post("https://api.fyers.in/api/v2/token", {
      grant_type: "authorization_code",
      appIdHash: Buffer.from(APP_ID + ":" + SECRET_KEY).toString("base64"),
      code: auth_code
    });

    ACCESS_TOKEN = `${APP_ID}:${response.data.access_token}`;
    res.send("Login successful. You can close this tab.");
  } catch (err) {
    res.send("Error generating token");
  }
});

/* WEBSOCKET */
const wss = new WebSocket.Server({ port: 8080 });

function connectFyers() {
  const ws = new WebSocket("wss://socket.fyers.in/socket/v2/dataSock");

  ws.on("open", () => {
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

  ws.on("close", () => setTimeout(connectFyers, 3000));
}

app.get("/start", (req, res) => {
  if (!ACCESS_TOKEN) return res.send("Login first");

  connectFyers();
  res.send("Live streaming started");
});

app.listen(3000, () => console.log("Server running"));
