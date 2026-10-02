import { writeSync } from "node:fs";

// A real PTY workload, deliberately unaware of how an old block reflows on resize.
// Agreement must preserve its residual rows, not erase repeated-looking output.
process.stdin.setRawMode(true);
if (Bun.spawnSync(["stty", "-echo", "-opost"], { stdin: "inherit" }).exitCode !== 0) {
  throw new Error("geometry fixture requires a raw PTY");
}

let cols = 0;
let rows = 0;
let frame = 0;
let previousLines = 0;
let mode: "numbered" | "relative" = "numbered";
let timer: ReturnType<typeof setInterval> | undefined;
let input = "";

function size(): void {
  const result = Bun.spawnSync(["stty", "size"], { stdin: "inherit" });
  const dimensions = result.stdout.toString().trim().split(/\s+/).map(Number);
  const [nextRows, nextCols] = dimensions;
  if (
    result.exitCode !== 0 ||
    nextRows === undefined ||
    nextCols === undefined ||
    !Number.isInteger(nextRows) ||
    !Number.isInteger(nextCols) ||
    nextRows < 1 ||
    nextCols < 1
  ) {
    throw new Error("geometry fixture could not observe its PTY grid");
  }
  rows = nextRows;
  cols = nextCols;
}

function emit(text: string): void {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    offset += writeSync(1, bytes, offset, bytes.length - offset);
  }
}

function draw(): void {
  if (mode === "numbered") {
    const label = `NUMBER:${frame}:${cols}x${rows}: `;
    emit(`${label}${"-".repeat(Math.max(0, cols - 2 - label.length))}\r\n`);
  } else {
    let text = previousLines === 0 ? "" : `\r\x1b[${previousLines - 1}A\x1b[J`;
    for (let line = 0; line < 4; line++) {
      const label = `[ROW:${line}:FRAME:${frame}:${cols}x${rows}] `;
      text += label + "-".repeat(Math.max(0, cols - 2 - label.length));
      if (line < 3) text += "\r\n";
    }
    emit(text);
    previousLines = 4;
  }
  frame++;
}

size();
emit(`GEOMETRY_READY:PID:${process.pid}\r\n`);
process.on("SIGWINCH", () => {
  size();
  if (timer !== undefined && mode === "relative") draw();
});
process.stdin.on("data", (chunk: Buffer) => {
  input += chunk.toString("utf8");
  for (;;) {
    const end = input.indexOf("\n");
    if (end < 0) break;
    const command = input.slice(0, end).trim();
    input = input.slice(end + 1);
    if (command === "numbered" || command === "relative") {
      clearInterval(timer);
      mode = command;
      frame = 0;
      previousLines = 0;
      emit(`\r\nMODE:${mode}:PID:${process.pid}\r\n`);
      draw();
      timer = setInterval(draw, 35);
    } else if (command === "stop") {
      clearInterval(timer);
      timer = undefined;
      emit(`\r\nDONE:${mode}:${frame}:PID:${process.pid}\r\n`);
      previousLines = 0;
    } else if (command === "mark") {
      emit(`CONTINUITY:PID:${process.pid}\r\n`);
    } else if (command === "quit") {
      process.exit(0);
    } else {
      throw new Error(`unknown geometry fixture command ${JSON.stringify(command)}`);
    }
  }
});
