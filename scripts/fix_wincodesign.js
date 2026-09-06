import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const cacheDir = 'C:\\Users\\nagir\\AppData\\Local\\electron-builder\\Cache\\winCodeSign';
const targetFolder = path.join(cacheDir, 'winCodeSign-2.6.0');
const zBin = path.join(process.cwd(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

async function fix() {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const files = fs.readdirSync(cacheDir);
  const archiveFile = files.find(f => f.endsWith('.7z'));

  if (!archiveFile) {
    console.log('No 7z file found in cacheDir:', cacheDir);
    return;
  }

  const archivePath = path.join(cacheDir, archiveFile);
  console.log('Found archive:', archivePath);

  // Extract using 7za into targetFolder ignoring errors if possible or using -snl-
  if (!fs.existsSync(targetFolder)) {
    fs.mkdirSync(targetFolder, { recursive: true });
  }

  try {
    // -snl- disables symlinks creation so 7za extracts regular files without symlink error
    const cmd = `"${zBin}" x -snl- -y "${archivePath}" "-o${targetFolder}"`;
    console.log('Running:', cmd);
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    console.log('7za output warning/error (ignoring symlink errors):', err.message);
  }

  // Create empty dummy dylib files if missing
  const dylib1 = path.join(targetFolder, 'darwin', '10.12', 'lib', 'libcrypto.dylib');
  const dylib2 = path.join(targetFolder, 'darwin', '10.12', 'lib', 'libssl.dylib');

  fs.mkdirSync(path.dirname(dylib1), { recursive: true });
  if (!fs.existsSync(dylib1)) fs.writeFileSync(dylib1, '');
  if (!fs.existsSync(dylib2)) fs.writeFileSync(dylib2, '');

  console.log('winCodeSign-2.6.0 is ready at:', targetFolder);
}

fix();
