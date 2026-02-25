import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";

export function loadKeypairFromFile(path: string): Keypair {
  const raw = readFileSync(path, "utf-8");
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}
