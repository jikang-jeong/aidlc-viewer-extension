'use strict';

// What Kiro still has to do, after a v2 project is configured, before /aidlc works.
//
// The engine's own completion message says it: open the project, trust it, run
// `Developer: Reload Window`, pick the aidlc agent. The extension used to drop that line
// (it reads only the "Outstanding actions:" block) and told the person the agent was
// "already available in this window", which it was not. Found on 2026-11-13 while
// reviewing why Windows setups "looked complete and did nothing".
//
// Two different restarts exist, and only one of them an extension can perform:
//
//   reload  -- `Developer: Reload Window`. Kiro reads .kiro/agents and .kiro/hooks when
//              a window loads, so a freshly configured project needs one. Every OS.
//   quit    -- quit Kiro and open it again. Kiro fixes its PATH when it launches, so an
//              engine whose command directory was added to PATH during this session is
//              invisible to Kiro's hooks until then, and Reload Window does not help
//              (upstream's install guide says the same). No extension API relaunches the
//              app; the most this can do is quit it, with the person reopening it.
//
// Which one is decided by a single fact: can a process started with Kiro's PATH find
// `aidlc`? The extension host has that PATH, and the hooks are started from the same
// parent, so the answer here is the answer for them. One function, used by the
// completion dialog ("do this now") and by Check setup ("did you do it"), so the two
// cannot disagree.
//
// Two phrasings of each answer. `en`/`ko` stand alone ("Quit Kiro and open it again…"),
// for Check setup and any place without the button. `dialogEn`/`dialogKo` name the button
// that is on the dialog ("Press Quit Kiro below, then open Kiro again…"), because the
// first Windows tester read the standalone sentence under a Quit Kiro button and asked
// whether the button was the thing to press. It is, and the sentence now says so.
//
// Pure: everything that varies is a parameter, so a test can be the Windows first
// install, the Mac with ~/.local/bin on PATH, or the Mac without it.

const { engineResolvable } = require('./engine-install');

const ACTIONS = {
  reload: { label: 'Reload Window', command: 'workbench.action.reloadWindow' },
  quit: { label: 'Quit Kiro', command: 'workbench.action.quit' }
};

function answer(action, { en, ko, dialogEn, dialogKo }) {
  return { action, ...ACTIONS[action], en, ko, dialogEn, dialogKo };
}

// `pathStatus` is install.ps1's word for what it did to PATH (updated, unchanged,
// failed, conflict), undefined off Windows or when the engine was already installed.
function kiroReadiness({
  env = process.env,
  platform = process.platform,
  freshEngineInstall = false,
  pathStatus = undefined,
  resolvable = engineResolvable({ env, platform })
} = {}) {
  if (resolvable) {
    const why = {
      en: 'Kiro loads the aidlc agent and the hooks the engine just wrote when the window reloads.',
      ko: '창이 다시 로드될 때 Kiro가 방금 생성된 aidlc 에이전트와 훅을 불러옵니다.'
    };
    return answer('reload', {
      en: `Reload the window. ${why.en}`,
      ko: `창을 다시 로드하세요. ${why.ko}`,
      dialogEn: `Press Reload Window below. ${why.en}`,
      dialogKo: `아래 Reload Window를 누르세요. ${why.ko}`
    });
  }
  if (platform === 'win32') {
    const registered = pathStatus === 'updated' || pathStatus === 'unchanged';
    if (freshEngineInstall && registered) {
      const why = {
        en:
          "The installer added the engine to your account's PATH, and Kiro only reads PATH when it " +
          'starts, so until then its hooks cannot find the engine. Reload Window is not enough.',
        ko:
          '설치기가 엔진을 계정 PATH에 등록했지만 Kiro는 시작할 때의 PATH만 읽으므로, 다시 열기 ' +
          '전까지 훅이 엔진을 찾지 못합니다. Reload Window로는 반영되지 않습니다.'
      };
      return answer('quit', {
        en: `Quit Kiro and open it again. ${why.en}`,
        ko: `Kiro를 완전히 종료하고 다시 여세요. ${why.ko}`,
        dialogEn: `Press Quit Kiro below, then open Kiro again. ${why.en}`,
        dialogKo: `아래 Quit Kiro를 눌러 종료한 뒤 다시 Kiro를 여세요. ${why.ko}`
      });
    }
    const fix = {
      en:
        "Kiro cannot find `aidlc` on its PATH. Add the engine's command directory to your user PATH " +
        '(Settings > Edit environment variables for your account)',
      ko: 'Kiro가 PATH에서 aidlc를 찾지 못합니다. 엔진의 명령 폴더를 사용자 PATH에 추가한 뒤'
    };
    return answer('quit', {
      en: `${fix.en}, then quit Kiro and open it again.`,
      ko: `${fix.ko} Kiro를 완전히 종료하고 다시 여세요.`,
      dialogEn: `${fix.en}, then press Quit Kiro below and open Kiro again.`,
      dialogKo: `${fix.ko} 아래 Quit Kiro를 눌러 종료하고 다시 Kiro를 여세요.`
    });
  }
  const fix = {
    en:
      'Kiro cannot find `aidlc` on its PATH, so the hooks will not run. Add ~/.local/bin to PATH in ' +
      "your shell profile (the installer's instruction)",
    ko:
      'Kiro가 PATH에서 aidlc를 찾지 못해 훅이 실행되지 않습니다. 셸 프로필에서 ~/.local/bin을 PATH에 ' +
      '추가한 뒤'
  };
  return answer('quit', {
    en: `${fix.en}, then quit Kiro and open it again.`,
    ko: `${fix.ko} Kiro를 완전히 종료하고 다시 여세요.`,
    dialogEn: `${fix.en}, then press Quit Kiro below and open Kiro again.`,
    dialogKo: `${fix.ko} 아래 Quit Kiro를 눌러 종료하고 다시 Kiro를 여세요.`
  });
}

module.exports = { kiroReadiness, ACTIONS };
