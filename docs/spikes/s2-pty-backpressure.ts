const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 1; i <= 3; i++) {
  let bytes = 0;
  let last = "";
  const proc = Bun.spawn(["bash", "--norc", "-i"], {
    env: { ...process.env, PS1: "$ ", TERM: "xterm-256color" },
    terminal: {
      cols: 80,
      rows: 24,
      data(_t, d) {
        bytes += d.byteLength;
        const s = new TextDecoder().decode(d);
        last = (last + s).slice(-4000);
      },
    },
  });
  const t = proc.terminal!;
  await sleep(250);
  const t0 = performance.now();
  t.write("seq 1 100000; echo DONE_MARKER\n");
  while (!last.includes("DONE_MARKER") && performance.now() - t0 < 20000) await sleep(50);
  const ms = Math.round(performance.now() - t0);
  t.write("exit\n");
  await proc.exited;
  t.close();
  console.log(
    JSON.stringify({
      iter: i,
      bytes,
      ms,
      complete: last.includes("DONE_MARKER"),
      tailHas100000: last.includes("100000"),
    }),
  );
}
