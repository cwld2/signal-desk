const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const packageName = "Changshen-Miaomiaowu-Windows";
const packageDir = path.join(dist, packageName);
const zipPath = path.join(dist, `${packageName}.zip`);

function assertInsideDist(target) {
  const relative = path.relative(dist, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe package path: ${target}`);
  }
}

async function copy(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(packageDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function build() {
  assertInsideDist(packageDir);
  assertInsideDist(zipPath);
  await fs.mkdir(dist, { recursive: true });
  await fs.rm(packageDir, { recursive: true, force: true });
  await fs.rm(zipPath, { force: true });
  await fs.mkdir(packageDir, { recursive: true });

  for (const entry of ["server.js", "sources.js", "public", "src"]) {
    await copy(entry);
  }
  if (await exists(path.join(root, "data", "cache.json"))) {
    await copy(path.join("data", "cache.json"));
  }

  await fs.copyFile(process.execPath, path.join(packageDir, "node.exe"));
  await fs.writeFile(path.join(packageDir, "启动畅神妙妙屋.cmd"), `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nstart "畅神妙妙屋" /min "%~dp0node.exe" "%~dp0server.js"\r\ntimeout /t 2 /nobreak >nul\r\nstart "" "http://127.0.0.1:4173"\r\nendlocal\r\n`, "utf8");
  await fs.writeFile(path.join(packageDir, "使用说明.txt"), `畅神妙妙屋\r\n\r\n1. 解压整个文件夹。\r\n2. 双击“启动畅神妙妙屋.cmd”。\r\n3. 浏览器会打开 http://127.0.0.1:4173。\r\n\r\n刷新新闻需要联网。收藏和已读状态只保存在当前浏览器。\r\n关闭名为“畅神妙妙屋”的最小化窗口即可停止服务。\r\n`, "utf8");

  const escapedPackageDir = packageDir.replace(/'/g, "''");
  const escapedZipPath = zipPath.replace(/'/g, "''");
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -LiteralPath '${escapedPackageDir}' -DestinationPath '${escapedZipPath}' -Force`
  ], { stdio: "inherit" });

  const stats = await fs.stat(zipPath);
  console.log(`Created ${zipPath}`);
  console.log(`Archive size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
