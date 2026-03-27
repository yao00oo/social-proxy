export function info(msg: string) {
  console.log(`\x1b[36m●\x1b[0m ${msg}`);
}

export function success(msg: string) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

export function error(msg: string) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
}

export function warn(msg: string) {
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}
