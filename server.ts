import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("traceability.db");

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );

  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    data JSON,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed a default user if none exists
const userCount = db.prepare("SELECT count(*) as count FROM users").get() as { count: number };
if (userCount.count === 0) {
  db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run("admin", "admin123");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Auth API
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password);
    if (user) {
      res.json({ success: true, user: { id: user.id, username: user.username } });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  });

  // Records API
  app.post("/api/records", (req, res) => {
    const { type, data } = req.body;
    try {
      const result = db.prepare("INSERT INTO records (type, data) VALUES (?, ?)").run(type, JSON.stringify(data));
      res.json({ success: true, id: result.lastInsertRowid });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get("/api/records", (req, res) => {
    const records = db.prepare("SELECT * FROM records ORDER BY timestamp DESC LIMIT 20").all();
    res.json(records.map((r: any) => ({ ...r, data: JSON.parse(r.data) })));
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
