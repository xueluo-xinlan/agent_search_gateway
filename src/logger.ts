import { createWriteStream, type WriteStream } from "node:fs";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private minLevel: number;
  private stream: WriteStream | null = null;
  /** stdio 传输下必须为 true：stdout 只能承载 JSON-RPC 消息，日志一律走 stderr。 */
  private useStderr: boolean = false;

  constructor(minLevel: Level, logFile?: string, useStderr: boolean = false) {
    this.minLevel = LEVEL_ORDER[minLevel];
    this.useStderr = useStderr;
    if (logFile) {
      this.stream = createWriteStream(logFile, { flags: "a" });
    }
  }

  private emit(level: Level, msg: string): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (this.stream) {
      this.stream.write(line + "\n");
    } else {
      if (this.useStderr || level === "error" || level === "warn") {
        console.error(line);
      } else {
        console.log(line);
      }
    }
  }

  debug(msg: string): void {
    this.emit("debug", msg);
  }
  info(msg: string): void {
    this.emit("info", msg);
  }
  warn(msg: string): void {
    this.emit("warn", msg);
  }
  error(msg: string): void {
    this.emit("error", msg);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
