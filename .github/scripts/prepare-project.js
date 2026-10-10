/**
 * prepare-project.js — skrip untuk GitHub Actions milik bot QUEEN WEB2APK.
 * ─────────────────────────────────────────────────────────────────────────
 * Dipanggil oleh workflow build-android.yml / build-flutter.yml. Tugasnya
 * menyiapkan folder `work/project` SEBELUM di-build, persis seperti yang
 * dilakukan worker VPS (worker/projectPrep.js):
 *
 *   mode URL  -> salin template native dari `gh-template/android-native`,
 *                lalu suntik nama aplikasi + URL target
 *   mode ZIP  -> unduh release asset (payload.zipAssetUrl) dan ekstrak
 *
 * Input dari bot (workflow_dispatch):
 *   JOB_ID  : id job
 *   PAYLOAD : JSON string berisi antara lain
 *     { url, appName, buildType, zipAssetUrl, zipReleaseTag, customIcon, ... }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WORK_DIR = path.resolve('work');
const PROJECT_DIR = path.join(WORK_DIR, 'project');
const NATIVE_TEMPLATE_DIR = path.resolve('gh-template', 'android-native');

function log(...args) {
  console.log('[prepare]', ...args);
}

function readPayload() {
  try {
    return JSON.parse(process.env.PAYLOAD || '{}') || {};
  } catch (error) {
    throw new Error(`PAYLOAD bukan JSON yang valid: ${error.message}`);
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeJavaString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

/** Samakan dengan projectPrep.encodeUrlForTemplate (dibalik lalu base64). */
function encodeUrlForTemplate(url) {
  return Buffer.from(String(url || '').split('').reverse().join(''), 'utf8').toString('base64');
}

/** Kalau hasil ekstrak ZIP hanya berisi satu folder, isinya dinaikkan. */
function hoistSingleFolder(target) {
  const entries = fs.readdirSync(target, { withFileTypes: true }).filter((e) => !e.name.startsWith('__MACOSX'));
  if (entries.length !== 1 || !entries[0].isDirectory()) return;

  const inner = path.join(target, entries[0].name);
  for (const item of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, item), path.join(target, item));
  }
  fs.rmdirSync(inner);
  log(`folder induk "${entries[0].name}" dinaikkan ke root project`);
}

function prepareFromTemplate(appName, targetUrl) {
  if (!fs.existsSync(NATIVE_TEMPLATE_DIR)) {
    throw new Error(`Template native tidak ditemukan di ${NATIVE_TEMPLATE_DIR}. ` +
      'Salin folder assets/android-native-template-safe ke gh-template/android-native di repo ini.');
  }

  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.cpSync(NATIVE_TEMPLATE_DIR, PROJECT_DIR, { recursive: true });

  const stringsPath = path.join(PROJECT_DIR, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const mainActivityPath = path.join(PROJECT_DIR, 'app', 'src', 'main', 'java', 'com', 'web2apk', 'app', 'MainActivity.java');

  const safeName = escapeXml(appName || 'Web2Apk');
  const encodedUrl = encodeUrlForTemplate(targetUrl);
  const fallbackUrl = escapeJavaString(targetUrl || 'https://google.com');

  const strings = fs.readFileSync(stringsPath, 'utf8')
    .replace(/<string name="app_name">.*<\/string>/, `<string name="app_name">${safeName}</string>`);
  fs.writeFileSync(stringsPath, strings, 'utf8');

  let mainActivity = fs.readFileSync(mainActivityPath, 'utf8')
    .replace(/ENCODED_URL_PLACEHOLDER/g, encodedUrl)
    .replace(/private static final String FALLBACK_URL = ".*";/, `private static final String FALLBACK_URL = "${fallbackUrl}";`)
    .replace(/https:\/\/google\.com/g, fallbackUrl);
  fs.writeFileSync(mainActivityPath, mainActivity, 'utf8');

  log(`project dibuat dari template • nama="${safeName}" • url="${targetUrl}"`);
}

function downloadZipProject(assetUrl) {
  const zipPath = path.join(WORK_DIR, 'project.zip');
  fs.mkdirSync(WORK_DIR, { recursive: true });

  log('mengunduh ZIP project dari release asset...');
  execFileSync('curl', [
    '-fsSL',
    '-H', `Authorization: Bearer ${process.env.GITHUB_TOKEN || ''}`,
    '-H', 'Accept: application/octet-stream',
    '-o', zipPath,
    assetUrl
  ], { stdio: 'inherit' });

  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', PROJECT_DIR], { stdio: 'inherit' });
  hoistSingleFolder(PROJECT_DIR);
  log(`ZIP diekstrak ke ${PROJECT_DIR}`);
}

function writeLocalProperties() {
  const sdkDir = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdkDir) return;
  const file = path.join(PROJECT_DIR, 'local.properties');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^sdk\.dir=/m.test(existing)) return;
  fs.writeFileSync(file, `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}sdk.dir=${sdkDir}\n`, 'utf8');
  log(`local.properties ditulis (sdk.dir=${sdkDir})`);
}

const ICON_SPECS = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 }
];

/** ImageMagick ('convert') tersedia di runner GitHub ubuntu-latest. */
function adaConvert() {
  try {
    execFileSync('which', ['convert'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Pasang icon kustom ke semua folder mipmap.
 * Ada ImageMagick -> di-resize sesuai density; kalau tidak -> disalin apa adanya
 * (Android akan men-skala sendiri, hasilnya tetap muncul).
 */
function applyIcon(iconPath) {
  const pakaiConvert = adaConvert();
  let jumlah = 0;

  for (const spec of ICON_SPECS) {
    const dir = path.join(PROJECT_DIR, 'app', 'src', 'main', 'res', spec.dir);
    fs.mkdirSync(dir, { recursive: true });
    const launcher = path.join(dir, 'ic_launcher.png');

    try {
      if (pakaiConvert) {
        execFileSync('convert', [
          iconPath,
          '-resize', `${spec.size}x${spec.size}^`,
          '-gravity', 'center',
          '-extent', `${spec.size}x${spec.size}`,
          launcher
        ], { stdio: 'inherit' });
      } else {
        fs.copyFileSync(iconPath, launcher);
      }

      if (!fs.existsSync(launcher) || fs.statSync(launcher).size === 0) {
        throw new Error('hasil icon kosong');
      }

      fs.copyFileSync(launcher, path.join(dir, 'ic_launcher_round.png'));
      jumlah += 1;

      // Varian .jpg bisa menutupi .png -> buang.
      for (const f of fs.readdirSync(dir)) {
        if (/^ic_launcher.*\.jpe?g$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch (error) {
      log(`icon ${spec.dir} gagal: ${error.message}`);
    }
  }

  log(`icon kustom dipasang ke ${jumlah}/${ICON_SPECS.length} folder mipmap (${pakaiConvert ? 'resize ImageMagick' : 'salin apa adanya'})`);
  return jumlah;
}

/** Unduh icon kustom dari release asset (pola sama seperti ZIP project). */
function downloadIcon(assetUrl) {
  const iconPath = path.join(WORK_DIR, 'icon.png');
  fs.mkdirSync(WORK_DIR, { recursive: true });

  log('mengunduh icon kustom dari release asset...');
  execFileSync('curl', [
    '-fsSL',
    '-H', `Authorization: Bearer ${process.env.GITHUB_TOKEN || ''}`,
    '-H', 'Accept: application/octet-stream',
    '-o', iconPath,
    assetUrl
  ], { stdio: 'inherit' });

  return iconPath;
}

function main() {
  const payload = readPayload();
  const jobId = process.env.JOB_ID || payload.jobId || 'unknown';
  const appName = payload.appName || 'Web2Apk';
  const targetUrl = payload.url || 'https://google.com';

  log(`job ${jobId}`);

  if (payload.zipAssetUrl) {
    downloadZipProject(payload.zipAssetUrl);
  } else {
    prepareFromTemplate(appName, targetUrl);
  }

  /*
   * ICON KUSTOM: bot mengunggah icon user sebagai release asset dan mengirim
   * URL-nya di payload.iconAssetUrl. Di sini icon itu dipasang ke SEMUA folder
   * mipmap (48/72/96/144/192 px) -- perilaku yang sama dengan worker VPS.
   */
  if (payload.iconAssetUrl) {
    try {
      applyIcon(downloadIcon(payload.iconAssetUrl));
    } catch (error) {
      log(`icon kustom GAGAL dipasang (build tetap jalan): ${error.message}`);
    }
  } else if (payload.customIconUrl) {
    log(`CATATAN: customIconUrl diberikan (${payload.customIconUrl}) tanpa iconAssetUrl — icon tidak diubah.`);
  }

  writeLocalProperties();

  const kind = fs.existsSync(path.join(PROJECT_DIR, 'pubspec.yaml')) ? 'flutter'
    : fs.existsSync(path.join(PROJECT_DIR, 'gradlew')) ? 'android'
      : 'tidak dikenal';
  log(`jenis project terdeteksi: ${kind}`);
}

main();
