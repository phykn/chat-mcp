import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { diagnose, printDiagnosis } from './doctor.mjs';

async function launch(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}

export async function openChromeSetup(extensionDir) {
  if (process.platform === 'win32') {
    await launch('explorer.exe', [extensionDir]);
    const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of bases) {
      const chrome = join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
      try { await access(chrome); } catch { continue; }
      return launch(chrome, ['chrome://extensions/']);
    }
  } else if (process.platform === 'darwin') {
    await launch('open', [extensionDir]);
    return launch('open', ['-a', 'Google Chrome', 'chrome://extensions/']);
  } else {
    await launch('xdg-open', [extensionDir]);
    for (const chrome of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'])
      if (await launch(chrome, ['chrome://extensions/'])) return true;
  }
  return false;
}

export async function finishSetup({ extensionDir, interactive = !!(process.stdin.isTTY && process.stdout.isTTY),
  open = openChromeSetup, check = diagnose, input = process.stdin, output = process.stdout }) {
  console.log('\n[4/4] Chrome 연결 확인');
  let state = await check();
  printDiagnosis(state);
  if (state.ready) return state;
  if (state.code === 'EXTENSION_DISCONNECTED') {
    console.log(`\n최초 1회: Chrome에서 chrome://extensions를 여세요.\n1. 개발자 모드를 켭니다.\n2. "압축해제된 확장 프로그램 로드"에서 아래 경로를 붙여 넣고 폴더를 선택합니다.\n\n   ${extensionDir}\n\n3. 자동으로 열린 ChatGPT 탭에서 로그인합니다. Chat 선택 화면이 나오면 Chat을 선택합니다.\n\n위 폴더 전체를 선택하세요. 저장소의 extension 폴더나 manifest.json 파일을 선택하지 마세요.`);
    if (interactive && !await open(extensionDir)) console.log('Chrome 설정 화면을 자동으로 열지 못했습니다. chrome://extensions를 직접 여세요.');
  }
  if (interactive) {
    const terminal = createInterface({ input, output });
    try {
      while (!state.ready) {
        let answer;
        try { answer = await terminal.question('\n안내대로 완료했으면 Enter로 확인 / 나중에 하려면 q: '); }
        catch (e) { if (e.code === 'ERR_USE_AFTER_CLOSE') break; throw e; }
        if (answer.trim().toLowerCase() === 'q') break;
        state = await check();
        printDiagnosis(state);
      }
    } finally { terminal.close(); }
  }
  if (!state.ready) console.log('\n플러그인 설치는 완료됐고, 연결 확인이 남아 있습니다. 나중에 npm run doctor로 다시 확인하세요.');
  return state;
}
