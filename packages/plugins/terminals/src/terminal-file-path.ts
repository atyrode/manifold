/** Paths are literal PTY input, never a shell expression or bracketed paste. */
export function terminalPathIsLiteral(path: string): boolean {
  return path.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(path);
}

/** The sender is the live terminal input boundary, not authority captured at delivery time. */
export function insertTerminalFilePath(path: string, send: (text: string) => boolean): boolean {
  return terminalPathIsLiteral(path) && send(path);
}
