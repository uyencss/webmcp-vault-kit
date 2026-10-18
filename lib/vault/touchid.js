'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { getDataDir } = require('../config.js');
const { readKeySource } = require('./key-source.js');

const SWIFT_HELPER_SOURCE = `
import Foundation
import LocalAuthentication

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "verify"
let reason = args.count > 2 ? args[2] : "Xác thực mở khóa WebMCP Vault"

let context = LAContext()
var authError: NSError?

if mode == "status" {
    let bioAvailable = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError)
    let ownerAvailable = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    let biometryType: String
    switch context.biometryType {
    case .touchID: biometryType = "touchID"
    case .faceID: biometryType = "faceID"
    default: biometryType = "none"
    }
    let out: [String: Any] = [
        "supported": bioAvailable || ownerAvailable,
        "biometricsAvailable": bioAvailable,
        "biometryType": biometryType,
        "error": authError?.localizedDescription ?? ""
    ]
    if let data = try? JSONSerialization.data(withJSONObject: out),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
    exit(0)
}

let semaphore = DispatchSemaphore(value: 0)
var successResult = false
var errorMessage = ""

let policy: LAPolicy = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    ? .deviceOwnerAuthenticationWithBiometrics
    : .deviceOwnerAuthentication

context.evaluatePolicy(policy, localizedReason: reason) { success, error in
    successResult = success
    if let err = error {
        errorMessage = err.localizedDescription
    }
    semaphore.signal()
}

semaphore.wait()
if successResult {
    print("{\\"ok\\":true}")
    exit(0)
} else {
    let escaped = errorMessage.replacingOccurrences(of: "\\"", with: "\\\\\\"")
    fputs("{\\"ok\\":false,\\"error\\":\\"\\(escaped)\\"}\\n", stderr)
    exit(1)
}
`.trim();

function getTouchIdHelperPaths(dataDir = getDataDir()) {
  const binDir = path.join(dataDir, 'bin');
  return {
    binDir,
    swiftFile: path.join(binDir, 'webmcp-touchid.swift'),
    binaryFile: path.join(binDir, 'webmcp-touchid'),
  };
}

function ensureTouchIdBinary(dataDir = getDataDir()) {
  if (os.platform() !== 'darwin') return null;
  const { binDir, swiftFile, binaryFile } = getTouchIdHelperPaths(dataDir);
  if (fs.existsSync(binaryFile)) return binaryFile;
  try {
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(swiftFile, `${SWIFT_HELPER_SOURCE}\n`, { mode: 0o600 });
    execFileSync('swiftc', ['-O', swiftFile, '-o', binaryFile], {
      stdio: 'ignore',
      timeout: 20000,
    });
    fs.chmodSync(binaryFile, 0o700);
    return binaryFile;
  } catch {
    return null;
  }
}

function getTouchIdStatus(options = {}) {
  if (os.platform() !== 'darwin') {
    return { supported: false, biometricsAvailable: false, biometryType: 'none', platform: os.platform() };
  }
  const dataDir = options.dataDir || getDataDir();
  const keySource = readKeySource({ dataDir, env: options.env || process.env });
  const binary = ensureTouchIdBinary(dataDir);
  if (!binary) {
    return {
      supported: true,
      biometricsAvailable: true,
      biometryType: 'touchID',
      keyAvailable: Boolean(keySource.available),
      helperCompiled: false,
    };
  }
  try {
    const stdout = execFileSync(binary, ['status'], { encoding: 'utf8', timeout: 5000 }).trim();
    const parsed = JSON.parse(stdout);
    return {
      ...parsed,
      keyAvailable: Boolean(keySource.available),
      helperCompiled: true,
    };
  } catch (err) {
    return {
      supported: false,
      biometricsAvailable: false,
      biometryType: 'none',
      keyAvailable: Boolean(keySource.available),
      error: err.message,
    };
  }
}

function evaluateTouchId({ reason = 'Mở khóa WebMCP Vault bằng Touch ID', dataDir = getDataDir() } = {}) {
  return new Promise((resolve, reject) => {
    if (os.platform() !== 'darwin') {
      reject(new Error('Touch ID is only supported on macOS.'));
      return;
    }
    const binary = ensureTouchIdBinary(dataDir);
    if (binary) {
      execFile(binary, ['verify', reason], { timeout: 60000 }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, method: 'swift-lacontext' });
          return;
        }
        let message = 'Touch ID authentication was cancelled or failed.';
        try {
          const parsed = JSON.parse(String(stderr || stdout || '').trim());
          if (parsed && parsed.error) message = parsed.error;
        } catch {
          if (stderr && String(stderr).trim()) message = String(stderr).trim();
        }
        reject(new Error(message));
      });
      return;
    }

    // Fallback to JXA LocalAuthentication if swiftc was unavailable
    const jxaScript = `
      ObjC.import('LocalAuthentication');
      ObjC.import('Foundation');
      const ctx = $.LAContext.alloc.init;
      let done = false, ok = false;
      ctx.evaluatePolicyLocalizedReasonReply(2, ${JSON.stringify(reason)}, (s) => { ok = s; done = true; });
      while (!done) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
      if (!ok) throw new Error('Touch ID denied');
    `;
    execFile('osascript', ['-l', 'JavaScript', '-e', jxaScript], { timeout: 60000 }, (error) => {
      if (!error) resolve({ ok: true, method: 'jxa-lacontext' });
      else reject(new Error('Touch ID authentication was cancelled or failed.'));
    });
  });
}

module.exports = {
  ensureTouchIdBinary,
  getTouchIdStatus,
  evaluateTouchId,
};
