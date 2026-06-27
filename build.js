// build.js — src/index.html 읽어서 JS 난독화 후 public/index.html 생성
const fs   = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC  = path.join(__dirname, 'src',    'index.html');
const DEST = path.join(__dirname, 'public', 'index.html');

const html = fs.readFileSync(SRC, 'utf8');

// <script> 태그 모두 추출해서 각각 처리
// 첫 번째 <script> (DevTools 차단) 는 그대로 유지
// 두 번째 <script> (메인 앱 코드) 만 난독화
let count = 0;
const result = html.replace(/<script>([\s\S]*?)<\/script>/g, (match, code) => {
  count++;
  if (count === 1) {
    // DevTools 차단 스크립트 — 그대로 유지 (가장 먼저 실행돼야 함)
    return match;
  }
  // 메인 앱 코드 — 최강 난독화
  const obfuscated = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false,        // DevTools 차단은 별도 스크립트가 처리
    disableConsoleOutput: false,   // console.log 서버 로그는 유지
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true,
    renameGlobals: false,
    renameProperties: false,
    selfDefending: true,           // 코드 포맷팅/수정 시 동작 불능
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 4,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.75,
    stringArrayEncoding: ['base64', 'rc4'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 5,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 5,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: true,
  }).getObfuscatedCode();

  return `<script>${obfuscated}</script>`;
});

fs.writeFileSync(DEST, result, 'utf8');
console.log(`[build] 난독화 완료 → public/index.html (스크립트 ${count}개 처리)`);
