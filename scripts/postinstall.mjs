import ncp from 'ncp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { rimrafSync } from 'rimraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.join(__dirname, '../out');

rimrafSync(outDir);

fs.mkdirSync(outDir, { recursive: true });

async function installLanceDb() {
  const platform = os.platform();
  const arch = os.arch();
  let binaryName;

  if (platform === 'linux' && arch === 'x64') {
    binaryName = '@lancedb/lancedb-linux-x64-gnu';
  } else if (platform === 'darwin' && arch === 'arm64') {
    binaryName = '@lancedb/lancedb-darwin-arm64';
  } else if (platform === 'win32' && arch === 'x64') {
    binaryName = '@lancedb/lancedb-win32-x64-msvc';
  }

  const target = path.join(__dirname, `../out/node_modules/${binaryName}`);

  fs.mkdirSync(target, { recursive: true });

  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, `../node_modules/${binaryName}`),
      target,
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
    );
  });
}

installLanceDb();
