import app from "./api/index.js";
import express from "express";
import path from "node:path";

app.use(express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`CultivAI rodando em http://localhost:${PORT}`);
});
