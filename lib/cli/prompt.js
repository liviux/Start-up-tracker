"use strict";

// One question on the terminal. Commands ask only when both stdin and stdout
// are a terminal; scripts and services never wait for an answer.

const readline = require("readline");

function isInteractive({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

function ask(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(String(answer).trim());
    });
    rl.once("close", () => {
      if (!answered) resolve("");
    });
  });
}

module.exports = { isInteractive, ask };
