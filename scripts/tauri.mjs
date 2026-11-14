#!/usr/bin/env node
/**
 * npm run tauri 的统一入口。
 *
 * 只做一件事：macOS 上给没有显式传架构的 build 注入 --target universal-apple-darwin，
 * 让 npm run tauri build 默认就产出 Intel / Apple Silicon 通用的 fat 包。
 * 其余子命令（dev / icon…）、显式 --target、以及非 macOS 平台都原样透传。
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const tauriBin = require.resolve("@tauri-apps/cli/tauri.js");

const args = process.argv.slice(2);
const isBuild = args[0] === "build";
const hasTarget = args.some((a) => a === "--target" || a.startsWith("--target="));

if (process.platform === "darwin" && isBuild && !hasTarget) {
    // universal 会把两套架构各编一遍再 lipo，两个 standard library 都得在；缺了顺手补装
    for (const t of ["x86_64-apple-darwin", "aarch64-apple-darwin"]) {
        const r = spawnSync("rustup", ["target", "add", t], { stdio: "inherit" });
        if (r.error || r.status !== 0) {
            console.error(`补装 Rust target ${t} 失败，请确认 rustup 可用后手动执行：rustup target add ${t}`);
            process.exit(r.status ?? 1);
        }
    }
    console.log("[tauri] 已注入 --target universal-apple-darwin：产物兼容 Intel 与 Apple Silicon");
    args.push("--target", "universal-apple-darwin");
}

const child = spawn(process.execPath, [tauriBin, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
});
