// S2 spike: Bun.Terminal functional matrix — bun $BUN_VERSION on this machine.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function once(iter: number) {
  const res: Record<string, unknown> = { iter };
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const proc = Bun.spawn(["bash", "--norc", "-i"], {
    env: { ...process.env, PS1: "$ ", TERM: "xterm-256color", LANG: "C.UTF-8" },
    terminal: {
      cols: 80,
      rows: 24,
      data(_t, d) {
        bytes += d.byteLength;
        chunks.push(new Uint8Array(d));
      },
    },
  });
  const t = proc.terminal!;
  await sleep(250);
  t.write("echo SPIKE_$((6*7))\n"); // bidirectional
  t.write("printf '\\xe4\\xbd\\xa0\\xe5\\xa5\\xbd\\xf0\\x9f\\x9a\\x80\\n'\n"); // utf-8 multibyte
  t.write("printf '\\033[31mRED\\033[0m\\n'\n"); // ansi
  await sleep(300);
  t.resize(120, 40);
  await sleep(150);
  t.write("stty size\n");
  await sleep(250);
  t.write("seq 1 100000 | tail -1\n"); // backpressure: ~600KB through pty
  await sleep(1500);
  t.write("exit 3\n");
  const code = await Promise.race([proc.exited, sleep(3000).then(() => -1)]);
  t.close();
  const out = new TextDecoder().decode(Buffer.concat(chunks));
  res.echo = out.includes("SPIKE_42");
  res.utf8 = out.includes("你好🚀");
  res.ansi = out.includes("\x1b[31mRED");
  res.resize = out.includes("40 120");
  res.backpressure = out.includes("100000");
  res.exit = code;
  res.bytes = bytes;
  return res;
}
// disconnect cleanup: kill terminal while child alive
async function cleanup() {
  const proc = Bun.spawn(["bash", "--norc", "-i"], { terminal: { cols: 80, rows: 24, data() {} } });
  await sleep(200);
  proc.terminal!.close();
  const code = await Promise.race([proc.exited, sleep(2000).then(() => "timeout")]);
  proc.kill();
  return { closedWhileAlive: true, exitedAfterClose: code };
}
for (let i = 1; i <= 5; i++) console.log(JSON.stringify(await once(i)));
console.log(JSON.stringify(await cleanup()));
console.log("bun", Bun.version);
