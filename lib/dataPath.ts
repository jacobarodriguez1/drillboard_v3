/**
 * Shared data directory for persistence.
 * - Production (Fly): /data (mounted volume, writable)
 * - Local dev: ./data under process.cwd()
 * Override via env: DATA_DIR (absolute) or ROSTER_CSV_PATH / COMM_STATE_PATH for specific files.
 */
import path from "path";

export function getDataDir(): string {
  const envDir = process.env.DATA_DIR?.trim();
  if (envDir) return path.isAbsolute(envDir) ? envDir : path.join(process.cwd(), envDir);
  return process.env.NODE_ENV === "production"
    ? "/data"
    : path.join(process.cwd(), "data");
}
