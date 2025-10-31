// ==================================================
// 基本モジュール
// ==================================================
import gulp from "gulp";
const { series, parallel, src, dest, watch } = gulp;

import plumber from "gulp-plumber";
import notify from "gulp-notify";
import browserSync from "browser-sync";

// ==================================================
// Sass関連
// ==================================================
import * as dartSass from "sass";
import gulpSass from "gulp-sass";
import sassGlob from "gulp-sass-glob-use-forward";
import postcss from "gulp-postcss";
import autoprefixer from "autoprefixer";
import postcssSortMediaQueries from "postcss-sort-media-queries";
import cssdeclsort from "css-declaration-sorter";
const sass = gulpSass(dartSass);

// ==================================================
// 画像処理（sharp / imagemin）
// ==================================================
import sharp from "sharp";
import through2 from "through2";
import path from "path";
import imagemin from "imagemin";
import imageminSvgo from "imagemin-svgo";
import fs from "fs";
import fsp from "fs/promises";
import { glob } from "glob";

// ==================================================
// ユーティリティ
// ==================================================
import changed from "gulp-changed";
import { deleteAsync } from "del";

// ==================================================
// 出力フォーマット切替（"webp" か "avif"）
// ==================================================
const IMG_FORMAT = "avif";

// フォーマット別の品質
const AVIF_QUALITY = 70;
const WEBP_QUALITY = 75;

// ==================================================
// エラーハンドラ（plumber + notify）共通化
// ==================================================
function withPlumber(taskName) {
  return plumber({
    errorHandler: notify.onError(`[${taskName} ERROR] <%= error.message %>`),
  });
}

// ===================================================================
// パス設定
// ===================================================================
const srcPath = {
  css: "../src/sass/**/*.scss",
  js: "../src/js/**/*",
  img: "../src/images/**/*",
  imgRaster: "../src/images/**/*.{jpg,png}",
  imgSvg: "../src/images/**/*.svg",
  html: ["../src/**/*.html", "!./node_modules/**"],
};

const destPath = {
  all: "../dist/**/*",
  css: "../dist/assets/css/",
  js: "../dist/assets/js/",
  img: "../dist/assets/images/",
  html: "../dist/",
};

// ===================================================================
// 画像削除・同期用ヘルパー
// ===================================================================
const src_img_root = path.resolve("../src/images");
const dest_img_root = path.resolve(destPath.img);

async function safeUnlink(targetPath) {
  try {
    await fsp.unlink(targetPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

function map_src_to_dest(filePath) {
  const rel = path.relative(src_img_root, path.resolve(filePath));
  return path.join(dest_img_root, rel);
}

function replace_ext(targetPath, newExt) {
  return targetPath.replace(/\.(jpg|jpeg|png|svg|avif|webp)$/i, newExt);
}

async function onUnlinkRaster(srcFilePath, cb) {
  try {
    const destMain = map_src_to_dest(srcFilePath);
    const destAvif = replace_ext(destMain, ".avif");
    const destWebp = replace_ext(destMain, ".webp");
    await safeUnlink(destMain);
    await safeUnlink(destAvif);
    await safeUnlink(destWebp);
    cb && cb();
  } catch (err) {
    cb && cb(err);
  }
}

async function onUnlinkSvg(srcFilePath, cb) {
  try {
    const destSvg = map_src_to_dest(srcFilePath);
    await safeUnlink(destSvg);
    cb && cb();
  } catch (err) {
    cb && cb(err);
  }
}

// ===================================================================
// コピータスク
// ===================================================================
const htmlCopy = () => src(srcPath.html).pipe(dest(destPath.html));
const jsCopy = () => src(srcPath.js).pipe(dest(destPath.js));

// ==================================================
// Sassコンパイル
// ==================================================
function css() {
  return src(srcPath.css)
    .pipe(withPlumber("SASS"))
    .pipe(sassGlob())
    .pipe(sass().on("error", sass.logError))
    .pipe(
      postcss([
        autoprefixer({ overrideBrowserslist: ["defaults", "not op_mini all"] }),
        postcssSortMediaQueries(),
        cssdeclsort({ order: "alphabetical" }),
      ])
    )
    .pipe(dest(destPath.css))
    .pipe(browserSync.stream());
}

// ==================================================
// 画像圧縮（JPEG/PNG）
// ==================================================
function compressImages() {
  return src(srcPath.imgRaster, { encoding: false })
    .pipe(changed(destPath.img))
    .pipe(
      through2.obj(async (file, _, cb) => {
        if (file.isBuffer()) {
          try {
            const ext = path.extname(file.path).toLowerCase();
            let outputBuffer;

            if (ext === ".jpg") {
              outputBuffer = await sharp(file.contents).jpeg({ quality: 75 }).toBuffer();
            } else if (ext === ".png") {
              outputBuffer = await sharp(file.contents).png({ quality: 75 }).toBuffer();
            }

            file.contents = outputBuffer;
            cb(null, file);
          } catch (err) {
            cb(err);
          }
        } else {
          cb(null, file);
        }
      })
    )
    .pipe(dest(destPath.img));
}

// ==================================================
// 派生画像変換（WebP / AVIF 切替）
// ==================================================
function convertToDerived() {
  return src(srcPath.imgRaster, { encoding: false })
    .pipe(changed(destPath.img, { extension: `.${IMG_FORMAT}` }))
    .pipe(
      through2.obj(async (file, _, cb) => {
        if (!file.isBuffer()) return cb(null, file);
        try {
          // フォーマット別オプション
          const opts =
            IMG_FORMAT === "avif"
              ? { quality: AVIF_QUALITY, chromaSubsampling: "4:2:0" }
              : { quality: WEBP_QUALITY };

          const outputBuffer = await sharp(file.contents)
            .toFormat(IMG_FORMAT, opts)
            .toBuffer();

          const outFile = file.clone();
          outFile.path = file.path.replace(/\.(jpg|jpeg|png)$/i, `.${IMG_FORMAT}`);
          outFile.contents = outputBuffer;
          cb(null, outFile);
        } catch (err) {
          cb(err);
        }
      })
    )
    .pipe(dest(destPath.img));
}

// ==================================================
// SVG圧縮（SVGO）
// ==================================================
function compressSVG() {
  return src(srcPath.imgSvg)
    .pipe(changed(destPath.img))
    .pipe(
      through2.obj(async (file, _, cb) => {
        if (file.isBuffer()) {
          try {
            let outputBuffer = await imagemin.buffer(file.contents, {
              plugins: [
                imageminSvgo({
                  plugins: [
                    { name: "preset-default" },
                    { name: "removeDimensions", active: true },
                  ],
                }),
              ],
            });

            if (outputBuffer instanceof Uint8Array) {
              outputBuffer = Buffer.from(outputBuffer);
            } else if (!Buffer.isBuffer(outputBuffer)) {
              outputBuffer = Buffer.from(String(outputBuffer));
            }
            file.contents = outputBuffer;
            cb(null, file);
          } catch (err) {
            cb(err);
          }
        } else {
          cb(null, file);
        }
      })
    )
    .pipe(dest(destPath.img));
}

// ==================================================
// 画像タスクまとめ
// ==================================================
export const images = parallel(compressImages, convertToDerived, compressSVG);

// ==================================================
// ローカルサーバー起動
// ==================================================
function serve(done) {
  browserSync.init({
    server: { baseDir: destPath.html },
    notify: false,
  });
  done();
}

// ==================================================
// リロードタスク
// ==================================================
function reload(done) {
  browserSync.reload();
  done();
}

// ==================================================
// クリーン（dist削除）
// ==================================================
const clean = () => deleteAsync(["../dist"], { force: true });
export { clean };

// ==================================================
// ファイル監視（削除対応）
// ==================================================
function watchFiles() {
  watch(srcPath.html, series(htmlCopy, reload));
  watch(srcPath.css, series(css, reload));
  watch(srcPath.js, series(jsCopy, reload))

  const rasterWatcher = watch(
    srcPath.imgRaster,
    series(compressImages, convertToDerived, reload)
  );
  rasterWatcher.on("unlink", (removedPath) => {
    onUnlinkRaster(removedPath);
  });

  const svgWatcher = watch(
    srcPath.imgSvg,
    series(compressSVG, reload)
  );
  svgWatcher.on("unlink", (removedPath) => {
    onUnlinkSvg(removedPath);
  });
}

// ==================================================
// タスク定義
// ==================================================
export const defaultTask = series(
  parallel(htmlCopy, css, jsCopy, images),
  serve,
  watchFiles
);

export default defaultTask;

export const build = series(clean, htmlCopy, css, jsCopy, images);

// ===================================================================
// dist内のjpg/png削除タスク（特定のファイルは除外）
// ===================================================================
const cleanImages = async () => {
  // 除外ファイルは dist/assets/images/ からの相対パスで記述
  // 例: "sora.jpg", "top/header.jpg", "common/logo.png"
  const excludeFilesList = [
    "sora.jpg",
  ];

  const cwd = path.resolve(destPath.img);

  const patterns = [
    "**/*.jpg",
    "**/*.png",
    ...excludeFilesList.map((f) => `!${f.replace(/\\/g, "/")}`)
  ];

  await deleteAsync(patterns, { cwd, force: true });
};
export { cleanImages };

// ===================================================================
// 保険用：孤児ファイル一括掃除タスク
// ===================================================================
async function pruneImages() {
  const destPosix = dest_img_root.replace(/\\/g, "/");
  const pattern = `${destPosix}/**/*.{jpg,jpeg,png,avif,webp,svg}`;

  const isWin = process.platform === "win32";
  const files = await glob(pattern, { nodir: true, windowsPathsNoEscape: isWin });

  const deletions = files.map(async (distFileAbs) => {
    const rel = path.relative(dest_img_root, distFileAbs);
    const parsed = path.parse(rel);
    const relNoExt = path.join(parsed.dir || "", parsed.name);

    const srcSameExt = path.join(src_img_root, rel);
    const srcJpg = path.join(src_img_root, `${relNoExt}.jpg`);
    const srcJpeg = path.join(src_img_root, `${relNoExt}.jpeg`);
    const srcPng = path.join(src_img_root, `${relNoExt}.png`);

    let shouldDelete = false;
    const ext = (parsed.ext || "").toLowerCase();

    if (ext === ".avif" || ext === ".webp") {
      const exists = fs.existsSync(srcJpg) || fs.existsSync(srcJpeg) || fs.existsSync(srcPng);
      shouldDelete = !exists;
    } else if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".svg") {
      shouldDelete = !fs.existsSync(srcSameExt);
    }

    if (shouldDelete) {
      await safeUnlink(distFileAbs);
    }
  });

  await Promise.all(deletions);
}
export { pruneImages };
