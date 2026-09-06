import express from "express";
import session from "express-session";
import path from "path";
import { env } from "./config/env";
import { whatsappRouter } from "./routes/whatsapp";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(whatsappRouter);
app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(env.port, () => {
  console.log(`Server listening on port ${env.port}`);
});
